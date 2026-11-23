#!/usr/bin/env node
// 分说话人 + 声音点名。慢（1 小时录音约 3–11 分钟，电脑越老越久），建议放后台跑，期间先读全文。
//
//   node tools/podcast/speakers.mjs <节目目录> [--threshold 0.9] [--force]
//
// 产物：制作文件/说话人分段.json；全文里标上 A、B、C……；声音点名.mp3（每个编号约 10 秒原声）和 说话人.md（给主理人填"是谁"）。
// 主理人填好 说话人.md 后运行 node tools/podcast/fulltext.mjs <节目目录>，把称呼换进全文。
//
// 阈值：越大分出的人越少。2026-11-17 用十来个人的线下录音试过：0.5 碎成几百个，固定人数 3 或 4 会塌成两个人，
// 0.9 最好（主要的人都稳定，同一人偶尔被拆成两个编号）。总时长不到 40 秒的编号当成插话碎片，并进相邻的人
// （录音很短、谁都不到 40 秒时，留说得最多的和不比他少太多的；一个都没分出来时 说话人.md 照样写，说明不用认人；
// 前后接着的几个录音里，在某个录音里占了一半以上说话时间的编号不算碎片，短补录也有自己的编号）。

import fs from 'node:fs';
import path from 'node:path';
import { relaunchOnMac, loadSherpa, needPodcastModels, pmPath, threads, episode, mustExist, readJson, writeJson, ff, fmt, RATE, trackWav, fileMap, fileMapIssue, lookupFile, wavInfo, recParts } from '../lib/podcast.mjs';
import { buildFull, readNames, rawNames, speakerLabels, diarSource } from './fulltext.mjs';
import { lockInfo, takeLock, logStep, cmd, ensureWavs, longPathMsg, fullBusy, roFix } from '../lib/podcast.mjs';
import { loadShow, loadVoices, matchVoices, oldVoice, oldVoiceHint } from '../lib/show.mjs';
import { labelEmbeddings, similarPairs } from './voices.mjs';

relaunchOnMac();
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--threshold');
if (!dir) { console.error(`用法: ${cmd('speakers.mjs')} <节目目录> [--threshold 0.9] [--force]`); process.exit(2); }
mustExist(dir);
const e = episode(dir);
const threshold = Number(opt('--threshold', 0.9));

const T0 = Date.now();
try {
  // 先看锁、再看文件：转写跑到一半时 识别.json 还没写出来，先看文件就会叫人"先运行 transcribe"，可 transcribe 正在跑
  const other = lockInfo(e, '分说话人');
  // 转写开它时先替它占好了锁（starter 是那个转写进程）：那把锁是自己的
  const mine = other && process.env.BOKE_FROM_TRANSCRIBE && String(other.starter) === process.env.BOKE_FROM_TRANSCRIBE;
  // 已经有一个在跑：退出码 3（不是 0），transcribe 不会误报"跑完了"
  if (other?.alive && other.pid !== process.pid && !mine) { console.log(`分说话人已经在后台跑了（进程 ${other.pid}，已 ${other.minutes} 分钟），不用再开。等它跑完，status.mjs 会显示。确定没在跑的话，删掉 ${other.file} 再来。`); process.exit(3); }
  const tj = lockInfo(e, '转写'); // 转写跑完自己开的分说话人除外：那时转写进程还没退
  if (tj?.alive && String(tj.pid) !== process.env.BOKE_FROM_TRANSCRIBE) throw new Error(tj.rewav ? '录音正在自动重新转换（中间文件清理过，几十秒）：等它跑完再分说话人' : '转写还在跑，录音可能要换：等它跑完再分说话人（它跑完会自动在后台开始）');
  const recMeta = readJson(path.join(e.mid, '录音.json'), {});
  const lp = longPathMsg(e, recMeta.mode === 'multitrack' ? (recMeta.files ?? []).length : 0); // 节目目录太深，识别程序读不了 16k.wav
  if (lp) throw new Error(lp);
  if (fs.existsSync(e.asr)) ensureWavs(e, { tracks: true }); // 中间文件清理过：先重新转换录音（识别、分说话人结果留着）
  if (!fs.existsSync(e.wav16) || !fs.existsSync(e.asr)) throw new Error(`先运行 ${cmd('transcribe.mjs', e.work)}`);
  // 全文.txt、全文提纲.md 写不进去：分完说话人最后要重写全文，先停下（不白算几分钟；2026-11-24 第 3 轮 17）
  const busyNow = fullBusy(e);
  if (busyNow.length) throw Object.assign(new Error(`${busyNow.join('、')} 被别的程序占着（编辑器、预览窗口开着它），或者是只读的：分完说话人要把说话人写进全文，写不进去，这次没分。${roFix(e.work)}`), { busy: busyNow });
  // 分说话人从头到尾是同步计算，跑的时候没法每 30 秒摸一下锁：按录音长短写上预计最晚什么时候跑完
  // （老电脑每小时约 11 分钟，按 20 分钟再加 10 分钟），这之前别的进程不会因为锁"30 分钟没动"就当它死了
  let hours = 1; try { const w = wavInfo(e.wav16); hours = w.frames / w.rate / 3600; } catch {}
  takeLock(e, '分说话人', { busyUntil: Date.now() + Math.round((hours * 20 + 10) * 60000) });
  // 记下这次用的是哪份录音；写结果前再看一眼，中途换了录音就作废，不把旧录音的说话人写进新录音
  const recSha = () => readJson(path.join(e.mid, '录音.json'), {}).wav16sha;
  const sha0 = recSha();
  const sameRec = () => { if (recSha() !== sha0) throw new Error(`录音在分说话人期间换了，这次结果作废：在后台重新运行 ${cmd('speakers.mjs', e.work)}（长录音要好几分钟；转写还在跑的话不用管，它跑完会自动在后台分说话人）`); };
  // 主理人填过的（哪怕填得不合规矩，比如"可能是小李"）都算填过：重新分说话人前要备份，不能直接覆盖
  const hadNames = Object.keys(rawNames(e)).length;
  const multi = readJson(path.join(e.mid, '录音.json'), {}).mode === 'multitrack';
  const srcFile = path.join(e.mid, '说话人来源.json');
  if (multi && (args.includes('--force') || !fs.existsSync(e.diar) || diarSource(e).source !== 'tracks')) {
    // 多轨：每条轨就是一个人。50ms 一帧比各轨音量，最响且比第二响高 6dB 的那条轨在说话（同屋录音会串音，所以要有差距）
    const sherpa = loadSherpa();
    const recs = readJson(path.join(e.mid, '录音.json')).files;
    const HOP = 800; // 16k 下 50ms
    const tracks = recs.map((_, i) => {
      const x = sherpa.readWave(trackWav(e, i), false).samples, n = Math.floor(x.length / HOP), db = new Float32Array(n);
      for (let f = 0; f < n; f++) { let s = 0; for (let k = f * HOP; k < (f + 1) * HOP; k++) s += x[k] * x[k]; db[f] = 10 * Math.log10(s / HOP + 1e-12); }
      const sorted = Float32Array.from(db).sort();
      return { db, gate: Math.max(sorted[Math.floor(n * 0.2)] + 12, -55) };
    });
    const nF = Math.max(...tracks.map((t) => t.db.length));
    const who = new Int16Array(nF).fill(-1);
    let prev = -1;
    for (let f = 0; f < nF; f++) {
      const act = tracks.map((t, i) => ({ i, v: t.db[f] ?? -120, on: (t.db[f] ?? -120) > t.gate })).filter((x) => x.on).sort((a, b) => b.v - a.v);
      if (!act.length) { prev = -1; continue; }
      who[f] = act.length === 1 || act[0].v - act[1].v >= 6 || !act.some((x) => x.i === prev) ? act[0].i : prev;
      prev = who[f];
    }
    const segs = [];
    for (let f = 0; f < nF; f++) {
      if (who[f] < 0) continue;
      const last = segs.at(-1);
      if (last && last.speaker === who[f] && f * 0.05 - last.end <= 0.5) last.end = (f + 1) * 0.05;
      else segs.push({ start: f * 0.05, end: (f + 1) * 0.05, speaker: who[f] });
    }
    sameRec();
    writeJson(e.diar, segs.filter((s) => s.end - s.start >= 0.3).map((s) => ({ start: +s.start.toFixed(2), end: +s.end.toFixed(2), speaker: s.speaker })), 0);
    const map = fileMap(e, '音轨对应');
    writeJson(srcFile, { source: 'tracks', files: recs, names: Object.fromEntries(recs.map((f, i) => [i, lookupFile(map, f) ?? ''])) });
    console.log(`多轨：按 ${recs.length} 条音轨认人。`);
  } else if (!multi && (args.includes('--force') || !fs.existsSync(e.diar))) {
    fs.rmSync(srcFile, { force: true });
    needPodcastModels(['seg', 'emb']);
    const sherpa = loadSherpa();
    console.log(`分说话人（阈值 ${threshold}）……长录音要几分钟到十几分钟。`);
    const t0 = Date.now();
    const sd = new sherpa.OfflineSpeakerDiarization({
      // windowShiftRatio：滑窗每次挪窗口长度的 1/4（默认 1/10，同一秒要算十来遍）。2026-11-19 VOL01：363 → 139 秒，
      // 主要说话人同样 14 个，逐帧和旧结果一致 93.8%；0.5 能快到 69 秒，但主要说话人数会变，不用
      segmentation: { pyannote: { model: pmPath('seg'), windowShiftRatio: 0.25 }, numThreads: threads(), provider: 'cpu', debug: 0 },
      embedding: { model: pmPath('emb'), numThreads: threads(), provider: 'cpu', debug: 0 },
      clustering: { numClusters: -1, threshold }, minDurationOn: 0.3, minDurationOff: 0.5,
    });
    const segs = sd.process(sherpa.readWave(e.wav16, false).samples).map((s) => ({ start: +s.start.toFixed(2), end: +s.end.toFixed(2), speaker: s.speaker }));
    sameRec();
    writeJson(e.diar, segs, 0);
    console.log(`分说话人完成，用了 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
    // 重新分了说话人，编号全变了：原来填的称呼不能再对着新编号用（会张冠李戴），挪到 说话人_上一版.md 备查
    if (hadNames) {
      let bak = path.join(e.work, '说话人_上一版.md');
      for (let n = 2; fs.existsSync(bak); n++) bak = path.join(e.work, `说话人_上一版${n}.md`); // 不覆盖更早的备份（里面可能是主理人手填的）
      fs.renameSync(e.names, bak);
      console.log(`注意：重新分了说话人，编号变了。原来填的称呼挪到了 ${path.basename(bak)}，不会自动套到新编号上；请主理人对着新的声音点名重新填。`);
    }
  }
  const src = diarSource(e);
  const { label, total, fragments } = speakerLabels(readJson(e.diar), src.source === 'tracks' ? 3 : undefined, src.source === 'tracks' ? null : recParts(e));
  buildFull(dir);

  // 声音点名：每个编号挑他最长的一段连续发言，截约 10 秒
  const full = readJson(e.full);
  const turns = [];
  for (const s of full) {
    const t = turns.at(-1);
    if (t && t.speaker === s.speaker && s.start - t.end < 1.5) { t.end = s.end; t.text += s.text; }
    else turns.push({ speaker: s.speaker, start: s.start, end: s.end, text: s.text });
  }
  const order = Object.entries(label).sort((a, b) => a[1].localeCompare(b[1]));
  // 没重新分说话人（编号没变）：主理人原来填的原样填回去（不按规矩清洗，括号说明、"可能是"都留着，fulltext/status 会照旧指出问题）；
  // 重新分过的，上面已经挪去 说话人_上一版.md，这里读到的是空的
  const names = rawNames(e);
  // 上一版里机器按声纹预填的（说明里那句"按节目档案的声纹认出：A=小周（相似度 …）"）：主理人没改过的不算手填，
  // 这次按这次的比对重新填（档案里删掉了这个人，show.mjs --forget，就不该还留着）
  const prefilled = {};
  try { const m = fs.readFileSync(e.names, 'utf8').match(/按节目档案的声纹认出：(.+?)。已预填/); if (m) for (const x of m[1].matchAll(/([A-Z])=([^（、]+)（相似度/g)) prefilled[x[1]] = x[2]; } catch {}
  const redone = [];

  // 声纹：和节目档案里记住的人比（认出常驻主播），再看同一期里有没有两个编号其实是同一个人
  const show = loadShow(e);
  const voices = loadVoices(show);
  const haveVoices = Object.keys(voices.people ?? {}).length > 0;
  let matches = {}, pairs = [];
  if (order.length && (haveVoices || (src.source !== 'tracks' && order.length > 1))) {
    console.log(haveVoices ? `和节目档案里的 ${Object.keys(voices.people).length} 个人比声纹……` : '比对各编号的声纹……');
    const labs = labelEmbeddings(e);
    matches = Object.fromEntries(Object.entries(matchVoices(labs, voices)).sort((a, b) => a[0].localeCompare(b[0])));
    if (src.source !== 'tracks') pairs = similarPairs(labs);
  }
  const mEnt = Object.entries(matches);
  const conflicts = {}; // 同一个称呼认给了几个编号、这几个编号彼此又不像（lib/show.mjs matchVoices）
  for (const [, m] of mEnt) if (m.conflict) conflicts[m.name] = m.conflict;
  const dups = [...new Set(mEnt.filter(([, m]) => m.dup).map(([, m]) => [m.name, ...m.dup].join('、')))];
  // 档案里有旧版（0.7 以前）记的声纹：算法不一样，认人可能不准，提醒重记（2026-11-23 复核 #53）
  const olds = Object.entries(voices.people ?? {}).filter(([, p]) => oldVoice(p)).map(([n]) => n);
  const voiceNote = [
    ...(olds.length ? [`${oldVoiceHint(olds, e.work)}。`] : []),
    ...(mEnt.some(([, m]) => m.sure) ? [`按节目档案的声纹认出：${mEnt.filter(([, m]) => m.sure).map(([l, m]) => `${l}=${m.name}（相似度 ${m.sim}）`).join('、')}。已预填，请听点名核对。`] : []),
    ...(mEnt.some(([, m]) => !m.sure && !m.conflict) ? [`声音有点像、没敢填的：${mEnt.filter(([, m]) => !m.sure && !m.conflict).map(([l, m]) => `${l} 像 ${m.name}（${m.sim}）`).join('、')}。`] : []),
    ...Object.entries(conflicts).map(([n, c]) => `${c.labs.map((l) => `${l}（${matches[l].sim}）`).join('、')} 都像档案里的 ${n}，可是这几个编号彼此不像（相似度 ${c.sim}），不会都是 ${n}，没敢填。请听点名认。`),
    ...dups.map((d) => `节目档案里 ${d} 的声纹几乎一样，可能是同一个人记了两个称呼。是的话运行 ${cmd('show.mjs', '--forget', e.work, '<多出来的称呼>')} 删掉一个。`),
    ...(pairs.length ? [`声音很像、可能是同一个人被拆成了两个编号：${pairs.map((p) => `${p.a} 和 ${p.b}（${p.sim}）`).join('、')}。是的话两行填同一个称呼。`] : []),
  ];
  const rows = [], inputs = [];
  let at = 0;
  for (const [k, lab] of order) {
    const best = turns.filter((t) => t.speaker === lab).sort((p, q) => (q.end - q.start) - (p.end - p.start))[0];
    if (!best) continue;
    const dur = Math.min(10, best.end - best.start + 0.2);
    inputs.push({ ss: Math.max(0, best.start - 0.1), dur });
    const auto = src.source === 'tracks' && src.names?.[k] ? src.names[k] : matches[lab]?.sure ? matches[lab].name : '';
    const byMachine = names[lab] != null && prefilled[lab] === names[lab];
    const name = (byMachine ? auto : names[lab] ?? auto) ?? '';
    if (byMachine && name !== names[lab]) redone.push(`${lab}=${names[lab]}${name ? `（这次认成 ${name}）` : ''}`);
    rows.push(`| ${fmt(at)} | ${lab} | ${(total[k] / 60).toFixed(1)} 分钟 | ${fmt(best.start)} | ${best.text.slice(0, 24).replace(/\|/g, '｜')}…… | ${name} |`);
    at += dur + 1.2;
  }
  if (redone.length) voiceNote.push(`上次按声纹预填的 ${redone.join('、')}，这次没再认出（节目档案里删掉了这个人，或者声音对不上了），已经${redone.some((x) => x.includes('这次认成')) ? '按这次的比对改掉或' : ''}清空，请听点名核对。`);
  if (inputs.length) {
    const filt = inputs.map((x, i) => `[${i}:a]aresample=${RATE},aformat=channel_layouts=stereo,afade=t=in:d=0.1,apad=pad_dur=1.2[a${i}]`).join(';')
      + `;${inputs.map((_, i) => `[a${i}]`).join('')}concat=n=${inputs.length}:v=0:a=1,loudnorm=I=-18[o]`;
    ff(['-v', 'error', ...inputs.flatMap((x) => ['-ss', x.ss.toFixed(2), '-t', x.dur.toFixed(2), '-i', e.wav44]), '-filter_complex', filt, '-map', '[o]', '-c:a', 'libmp3lame', '-b:a', '128k', e.rollcall], '声音点名');
  } else fs.rmSync(e.rollcall, { force: true }); // 一个说话人都没分出来（录音里几乎没有人声）：没有可点名的，旧的点名删掉免得对不上
  // 说话人.md 是"分说话人跑完了"的标志（status、transcribe 都看它）：先写临时文件再改名，半截的不算
  const namesTmp = e.names + '.part';
  fs.writeFileSync(namesTmp, `# 说话人

${!rows.length ? `机器没分出说话人（录音里的人声太少、太短），没有声音点名。不用认人：运行 \`${cmd('status.mjs', e.work, '--skip', '认人')}\`。\n\n` : ''}${src.source === 'tracks' ? `多轨录音，按音轨认人：一条音轨就是一个人，共 ${rows.length} 条有人说话。称呼按 节目信息.md 的"音轨对应"预填，请核对。` : `机器分出了 ${rows.length} 个说话人编号（另有 ${fragments} 个插话碎片已并入相邻的人）。`}\`声音点名.mp3\` 按下表顺序每个编号放约 10 秒原声，请主理人听一遍，在"是谁"一栏填称呼。
同一个人被拆成了两个编号的，两行填同一个称呼。认不出来的空着。填完运行 \`${cmd('fulltext.mjs', e.work)}\`，称呼会换进全文。
${voiceNote.length ? `\n${voiceNote.map((x) => `- ${x}`).join('\n')}\n` : ''}${show ? `\n认完人、确认之后，运行 \`${cmd('show.mjs', '--learn', e.work)}\`，把主持人和常驻嘉宾的声纹记进节目档案，下一期自动认出。\n` : ''}
| 点名音频里 | 编号 | 说了多久 | 这段原声在原录音 | 开头的话 | 是谁 |
|---|---|---|---|---|---|
${rows.join('\n')}
`, 'utf8');
  fs.renameSync(namesTmp, e.names);
  if (Object.keys(readNames(e)).length) buildFull(dir); // 称呼（手填的，或多轨按音轨对应自动填的）换进全文
  if (src.source === 'tracks') {
    // "没填"和"填了但名字对不上"分开说（2026-11-22 审查 75）
    const mapIssue = fileMapIssue(e, '音轨对应', readJson(path.join(e.mid, '录音.json'), {}).files ?? []);
    console.log(`${rows.length} 条音轨有人说话，已按音轨标好说话人${mapIssue ? `。注意：${mapIssue}，再运行 ${cmd('speakers.mjs', e.work, '--force')}；对不上的称呼现在空着` : Object.keys(readNames(e)).length ? '，称呼按 节目信息.md 的"音轨对应"填好了' : '（节目信息.md 的"音轨对应"没填，称呼空着）'}。声音点名.mp3 和 说话人.md 已写好。`);
    console.log('下一步：请主理人听一下 声音点名.mp3，核对 说话人.md 的称呼，没问题就确认"认人"。');
  } else if (!rows.length) {
    console.log(`机器没分出说话人（录音里的人声太少、太短），说话人.md 已写好，没有声音点名。下一步：不用认人，运行 ${cmd('status.mjs', e.work, '--skip', '认人')}`);
  } else {
    console.log(`${rows.length} 个说话人编号，${fragments} 个碎片并入相邻的人。声音点名.mp3（${fmt(at)}）和 说话人.md 已写好，全文已标上编号。`);
    console.log('下一步：请主理人听 声音点名.mp3、在 说话人.md 填称呼（可以晚点做，不挡编排）。');
  }
  logStep(e, '分说话人', T0);
} catch (err) { console.error(err.busy ? `${err.message}，再在后台运行 ${cmd('speakers.mjs', e.work)}${fs.existsSync(e.diar) ? '（已分好的段直接用，几秒钟）' : ''}` : err.message); process.exit(1); }
