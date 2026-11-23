#!/usr/bin/env node
// 按 编排方案.json 剪精编版：取段 → 按逐字时间修边界 → 缩短长停顿、去掉段首"呃嗯" → 人声处理 → 片头/过渡/片尾配乐 → 统一响度。
//
//   node tools/podcast/build.mjs <节目目录>             出精编版（人声处理按方案里的 voice，默认处理）
//   node tools/podcast/build.mjs <节目目录> --compare   先出"处理前后对比"：从原录音里挑两处音量差最大的 30 秒，处理前、处理后各一份。
//                                                    不用等编排方案，转写完就能跑，一两分钟
//
// 产物：精编版/（精编版.mp3、剪辑表.json、章节目录.txt），或 处理前后对比/。
// 人声处理（2026-11-17 用真实节目调过，见 references/播客_人声处理.md）：
//   ① 低切 80Hz + 轻度降噪（afftdn nr=8），只处理用得上的片段；
//   ② 分人调平：每个识别段往全期中位响度拉 80%，最多 +8 / -5 dB，句间空隙取两边较小的增益（不把底噪拉上来），先整体让 9 dB 余量防削顶；
//   ③ 轻度压缩 2.5:1。人声先量一次响度、按差值整体调到目标（-16 LUFS，节目档案可以改），和配乐一起混好后再量一次、微调。
//   不用 loudnorm：它在峰值超标时会退回逐段调整的慢模式（2026-11-19 实测 10 分钟要 70 秒），改成"量一次 + 整体增益 + 限幅"。
// 单声道录音（transcribe 判断的）全程按单声道处理，混配乐时才变成立体声。
// 节目档案（references/播客_节目档案.md）里写了片头、片尾就放进去（片头在钩子之后，片尾在正文之后），配乐可以换成节目自己的或不要。

import fs from 'node:fs';
import path from 'node:path';
import { episode, mustExist, loadFull, fullSha, makeClipper, HOOK_GAP, readJson, writeJson, ff, duration, fmt, fileSha, wavInfo, needSpace, pcmBytes, planSha, logStep, MUSIC, RATE, PUNCT, findInSentence, planOrExit, cmd, ensureWavs, planCheck, mp3Title, loadPlan, lockInfo, takeLock, recordingsChanged, recChangedMsg, recParts, inFile, stuckFiles, stuckMsg, userError } from '../lib/podcast.mjs';
import { loadShow, showAsset, targetLufs, effectiveVoice, showVoice, showRef, showClipBad } from '../lib/show.mjs';
import { confirmGate, outputGateMsg } from '../lib/confirm.mjs';
const T0 = Date.now();
import { PARTS, resolveMusic, trackByPath, trackGood, defaultEntry, credit, musicName } from '../lib/library.mjs';
import { getMusic } from '../get-model.mjs';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) { console.error(`用法: ${cmd('build.mjs')} <节目目录> [--compare]`); process.exit(2); }
mustExist(dir);
const e = episode(dir);
// 出精编版（不是 --compare）：主理人要先确认过编排和声音（确认之后没改过），不替他做主；
// 同一期同时只剪一个（两次同时剪会互相删、互相覆盖 精编版/ 里的临时文件）。finish 启动的 build 认得 finish 自己的锁
if (!args.includes('--compare')) {
  const mine = process.env.BOKE_FINISH_PID;
  const busy = [lockInfo(e, '剪辑'), lockInfo(e, '成品')].find((l) => l?.alive && String(l.pid) !== mine);
  if (busy) { console.error(`这期正在出成品（进程 ${busy.pid}，已 ${busy.minutes} 分钟），不要再启动：等它跑完看它的输出。`); process.exit(1); }
  const { plan: p0, bad } = loadPlan(e);
  if (p0 && !bad) { const why = outputGateMsg(e, confirmGate(e, { plan: p0, show: (() => { try { return loadShow(e); } catch { return null; } })() })); if (why) { console.error(why); process.exit(1); } }
  takeLock(e, '剪辑');
} else takeLock(e, '对比'); // 出对比也读转好的录音、在 制作文件/ 写临时文件：clean 看到这把锁就不清（2026-11-20 审查 F3）
const GAP = { ...HOOK_GAP, section: 3.0, tail: 11 }; // 片头几段空当和 plan 共用（lib/podcast.mjs）
const FADE = 0.015;
const PROC = { headroom: 9, gainMax: 8, cutMax: 5, amount: 0.8, ramp: 0.08, denoise: 'highpass=f=80,afftdn=nr=8:nf=-60:tn=1', comp: 'acompressor=threshold=-20dB:ratio=2.5:attack=10:release=180:knee=4' };
const MUSIC_BELOW_DB = 4; // 配乐单独响的时候比人声目标响度低这么多（自带的 Aurora 原曲约 -22 LUFS，+2 dB 到 -20）
const LIMIT = 10 ** (-2 / 20); // 成品限幅到 -2 dBFS（真峰值和 mp3 编码还会高一点，检查要求不超过 -1）
const MARGIN = 0.3; // 给片段降噪时两头多带 0.3 秒，让降噪先"听"一下底噪
const RENDER_VERSION = 2; // 剪法变了（声音会不一样）就加 1：check 的接缝缓存按它作废
const DN_DELAY =Math.floor(Math.round(RATE * 0.05) / 2); // afftdn 会把声音往后推半个 50ms 窗（44.1k 下 1102 帧），读回来时要补上，不然剪口偏 25ms

// 转好的录音（原始_44k.wav）。中间文件清理过（clean.mjs）就先自动重新转换（只恢复 wav，识别、分说话人、全文都不动）。
// 出精编版时放在"方案检查过没有"之后：本来就要被拒绝的剪辑，不先花几十秒、几百 MB 去转录音（2026-11-20 审查 F3）
let W, CH, BPS, lay;
function openWav() {
  // 录音在转写之后变了（加了补录、改了录音顺序，或者转写半路断了）：照旧全文的时间去剪新录音会整段错位，先停下（2026-11-22 审查）。
  // 只是修改时间变了的，先重新转换一次核对内容（ensureWavs recheck：内容一样就照常剪，不一样停下）
  const ch = recordingsChanged(e);
  if (ch && !ch.mtimeOnly) { console.error(`${recChangedMsg(e, ch)}。这次没剪。`); process.exit(1); }
  try { ensureWavs(e, { recheck: !!ch?.mtimeOnly }); } catch (err) { console.error(err.message); process.exit(1); }
  if (!fs.existsSync(e.wav44)) { console.error(`制作文件里没有转好的录音。先运行 ${cmd('transcribe.mjs', e.work)}`); process.exit(1); }
  W = wavInfo(e.wav44); CH = W.ch; BPS = 2 * CH; // 单声道录音按单声道处理
  lay = CH === 1 ? 'mono' : 'stereo';
}
const rawIn = (f) => ['-f', 's16le', '-ar', RATE, '-ac', CH, '-i', f];
// 整体响度、真峰值、响度范围（ebur128 一遍）
function loud(args) {
  const o = ff(['-nostats', ...args, '-f', 'null', '-'], '响度测量');
  const last = (re) => { const m = [...o.matchAll(re)]; return m.length ? Number(m.at(-1)[1]) : null; };
  return { lufs: last(/I:\s+(-?[\d.]+) LUFS/g), lra: last(/LRA:\s+([\d.]+) LU/g), peak: last(/Peak:\s+(-?[\d.]+|-inf) dBFS/g) };
}
const loudFile = (f) => loud(['-i', f, '-af', 'ebur128=peak=true']);
// 分人调平的增益包络（原录音时间轴，每 10ms 一个线性倍数，已经扣掉 9 dB 余量）
function gainEnv() {
  const lv = readJson(e.levels, null);
  if (!lv) throw new Error(`没有 段响度.json，先运行 ${cmd('transcribe.mjs', e.work)}`);
  const g = lv.segs.map((s) => (s.db < -90 ? 0 : Math.max(-PROC.cutMax, Math.min(PROC.gainMax, (lv.median - s.db) * PROC.amount))));
  const total = Math.max(Math.ceil(lv.segs.at(-1).end + 5) * 100, Math.ceil(W.frames / RATE * 100) + 2);
  const db = new Float32Array(total);
  const put = (t0, t1, v0, v1) => { const a = Math.max(0, Math.round(t0 * 100)), b = Math.min(total, Math.round(t1 * 100)); for (let k = a; k < b; k++) db[k] = b - a > 1 ? v0 + (v1 - v0) * (k - a) / (b - a - 1) : v1; };
  put(0, lv.segs[0].start, g[0], g[0]);
  lv.segs.forEach((s, i) => {
    put(s.start, s.end, g[i], g[i]);
    const s2 = lv.segs[i + 1]?.start ?? total / 100, g2 = g[i + 1] ?? g[i];
    if (s2 - s.end < 2 * PROC.ramp) { put(s.end, s2, g[i], g2); return; }
    const quiet = Math.min(g[i], g2);
    put(s.end, s.end + PROC.ramp, g[i], quiet); put(s.end + PROC.ramp, s2 - PROC.ramp, quiet, quiet); put(s2 - PROC.ramp, s2, quiet, g2);
  });
  const lin = new Float32Array(total);
  for (let k = 0; k < total; k++) lin[k] = 10 ** ((db[k] - PROC.headroom) / 20);
  return { lin, lv, g };
}
// 一段 16 位样本就地乘增益（env 按原录音时间插值）和淡入淡出；返回削顶的样本数
function shape(buf, f0, env, fadeN) {
  const s = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1), n = s.length / CH;
  let clipped = 0;
  for (let k = 0; k < n; k++) {
    let gl = 1;
    if (env) { const x = (f0 + k) / RATE * 100, j = Math.min(Math.floor(x), env.length - 2), fr = x - j; gl = env[j] * (1 - fr) + env[j + 1] * fr; }
    const fade = fadeN ? (k < fadeN ? 0.5 - 0.5 * Math.cos(Math.PI * k / fadeN) : k >= n - fadeN ? 0.5 - 0.5 * Math.cos(Math.PI * (n - 1 - k) / fadeN) : 1) : 1;
    const m = gl * fade;
    if (m === 1) continue;
    for (let c = 0; c < CH; c++) {
      let v = Math.round(s[k * CH + c] * m);
      if (v > 32767 || v < -32768) { clipped++; v = v > 0 ? 32767 : -32768; }
      s[k * CH + c] = v;
    }
  }
  return clipped;
}
function readFrames(fd, dataOff, f0, n) {
  const buf = Buffer.alloc(n * BPS);
  if (f0 < 0) { const pad = -f0; fs.readSync(fd, buf, pad * BPS, (n - pad) * BPS, dataOff); return buf; }
  fs.readSync(fd, buf, 0, n * BPS, dataOff + f0 * BPS);
  return buf;
}
const tmpFiles = new Set();
const tmp = (dirName, name) => { const f = path.join(dirName, name); tmpFiles.add(f); return f; };
const cleanTmp = () => { for (const f of tmpFiles) fs.rmSync(f, { force: true }); tmpFiles.clear(); };
process.on('exit', cleanTmp);
fs.rmSync(e.wav44dn, { force: true }); // 旧版留下的整条降噪副本，用不着了

// ---------- 处理前后对比：只看原录音里的两段 30 秒，不依赖编排方案 ----------
if (args.includes('--compare')) {
  openWav();
  try {
    console.log('从原录音里挑两处音量差最大的 30 秒，出处理前、处理后……');
    const { lin, lv, g } = gainEnv();
    const total = W.frames / RATE;
    const segs = lv.segs.filter((s) => s.end - s.start > 1 && s.db > -90);
    const wins = [];
    for (let w = 0; w + 30 < total; w += 5) { const xs = segs.filter((s) => s.start >= w && s.end <= w + 30).map((s) => s.db); if (xs.length >= 3) wins.push({ w, spread: Math.max(...xs) - Math.min(...xs) }); }
    wins.sort((a, b) => b.spread - a.spread);
    const picks = [];
    for (const x of wins) if (picks.every((p) => Math.abs(p.w - x.w) >= 90)) { picks.push(x); if (picks.length === 2) break; }
    if (!picks.length) throw new Error('录音太短或太安静，挑不出可以对比的 30 秒。');
    fs.mkdirSync(e.compare, { recursive: true });
    for (const f of fs.readdirSync(e.compare)) fs.rmSync(path.join(e.compare, f), { force: true });
    const fd = fs.openSync(e.wav44, 'r');
    // 两个版本都调到同样响度再比，听的是"处理"本身，不是谁更响
    const toMp3 = (rawFile, pre, out) => {
      const m = loud([...rawIn(rawFile), '-af', `${pre ? `${pre},` : ''}ebur128`]);
      const gain = ((-16) - (m.lufs ?? -16)).toFixed(2);
      ff(['-v', 'error', ...rawIn(rawFile), '-af', `${pre ? `${pre},` : ''}volume=${gain}dB,alimiter=limit=${LIMIT}:level=false:latency=1`, '-c:a', 'libmp3lame', '-b:a', '160k', out], '出对比');
    };
    for (const [i, p] of picks.entries()) {
      const tag = `${i + 1}_原录音${fmt(p.w).replace(/:/g, '分')}秒起`;
      const f0 = Math.round(p.w * RATE), n = 30 * RATE, m = Math.round(MARGIN * RATE * 3);
      const rawA = tmp(e.mid, `对比${i}_A.raw`), srcB = tmp(e.mid, `对比${i}_B源.raw`), dnB = tmp(e.mid, `对比${i}_B降噪.raw`);
      fs.writeFileSync(rawA, readFrames(fd, W.dataOff, f0, n));
      fs.writeFileSync(srcB, readFrames(fd, W.dataOff, f0 - m, n + m + DN_DELAY));
      ff(['-v', 'error', ...rawIn(srcB), '-af', PROC.denoise, '-f', 's16le', '-ar', RATE, '-ac', CH, dnB], '低切降噪');
      const b = fs.readFileSync(dnB).subarray((m + DN_DELAY) * BPS, (m + DN_DELAY + n) * BPS);
      shape(b, f0, lin, 0);
      fs.writeFileSync(dnB, b);
      const a = path.join(e.compare, `${tag}_A处理前.mp3`), bm = path.join(e.compare, `${tag}_B处理后.mp3`);
      toMp3(rawA, '', a); toMp3(dnB, PROC.comp, bm);
      ff(['-v', 'error', '-i', a, '-f', 'lavfi', '-t', 1.5, '-i', `anullsrc=r=${RATE}:cl=${lay}`, '-i', bm, '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1', '-c:a', 'libmp3lame', '-b:a', '160k', path.join(e.compare, `${tag}_先A后B.mp3`)], '拼对比');
      const ma = loudFile(a), mb = loudFile(bm);
      console.log(`  对比 ${i + 1}：原录音 ${fmt(p.w)}${inFile(recParts(e), p.w)} 起 30 秒，这一段里各句响度差 ${p.spread.toFixed(1)} dB；音量起伏 处理前 ${ma.lra} LU → 处理后 ${mb.lra} LU`);
    }
    fs.closeSync(fd); cleanTmp();
    // 整期：各段响度差（10%–90%），调平前后
    const q = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length * 0.9)] - s[Math.floor(s.length * 0.1)]; };
    const before = lv.segs.filter((s) => s.end - s.start > 1 && s.db > -90), idx = before.map((s) => lv.segs.indexOf(s));
    console.log(`整期各句响度差（10%–90%）：处理前 ${q(before.map((s) => s.db)).toFixed(1)} dB，调平后约 ${q(idx.map((k) => lv.segs[k].db + g[k])).toFixed(1)} dB。`);
    console.log(`对比文件在 处理前后对比/。请本人听 ${picks.length} 个"先A后B"文件，`
      + '选处理还是不处理（编排方案.json 的 voice 写 "processed" 或 "raw"；有节目档案的问他要不要记进档案的"人声处理"，以后每期不用再听），再确认"声音"这一步。');
    logStep(e, '对比', T0);
    process.exit(0);
  } catch (err) { console.error(err.message); process.exit(1); }
}

let full;
try { full = loadFull(e); } catch (err) { console.error(err.message); process.exit(1); }
const plan = planOrExit(e); // 写坏了会说第几行、什么原因
if (!plan) { console.error('还没有 编排方案.json'); process.exit(1); }
// 方案检查过没有：按 plan.mjs 检查通过时记的指纹（不看修改时间：Copy-Item 会带着旧时间）。
// 只写了简介、改了标题这类不影响声音的，不用重跑 plan；全文重新识别过的一定要重跑（句子编号可能变了）
{ const why = planCheck(e, plan, { strict: false }); if (why) { console.error(`${why}。先运行 ${cmd('plan.mjs', e.work)}`); process.exit(1); } }
openWav();

// 节目档案：片头、片尾（主理人自己的音频）、配乐、成品响度。没有档案就用默认（自带配乐、-16 LUFS、没有片头片尾）
// 配乐分三处：片头铺底、板块过渡、片尾铺底。规则在 lib/library.mjs 的 resolveMusic（plan.mjs 用同一个）：
//   编排方案.json 的 music 覆盖节目档案的"配乐"；false 不要；"库:<id>" 三处都用；{ "片头", "过渡", "片尾" } 分开写。
let show, LUFS, intro, outro, mus;
try {
  show = loadShow(e);
  LUFS = targetLufs(show);
  const asset = (k) => { const p = showAsset(show, k); return p ? { file: p, dur: duration(p) } : null; };
  intro = asset('片头'); outro = asset('片尾');
  mus = resolveMusic(plan, { work: e.work, assets: show?.assets, showMusic: () => showAsset(show, '配乐') });
  for (const [k, a] of [['片头', intro], ['片尾', outro]]) if (a && showClipBad(k, a.file, a.dur)) throw new Error(showClipBad(k, a.file, a.dur));
  if (showRef(e).note) console.log(`注意：${showRef(e).note}`);
} catch (err) { console.error(err.message); process.exit(1); }
// 曲库里的曲子本地还没下载（或者文件坏了）：当场下载。只管真会铺音乐的地方（有节目片头或没有钩子不铺片头，
// 有节目片尾不铺片尾，只有一个板块没有过渡），同一首只下一次。下不下来就这几处退回默认的 Aurora、说清原因，不中断；
// 换掉的记进剪辑表（musicTracks 的 wanted、reason），status 和 check 会一直提醒，主理人确认的方案上写的是另一首（v0.7 审查 66、69）
{
  const used = { 片头: !intro && plan.sections.some((s) => s.kind === 'hook'), 过渡: plan.sections.filter((s) => s.kind !== 'hook').length > 1, 片尾: !outro };
  const tracks = new Map();
  for (const k of PARTS) if (used[k] && mus[k]?.track?.url) tracks.set(mus[k].track.id, mus[k].track);
  const need = [];
  for (const [id, t] of tracks) if (!(await trackGood(t))) need.push(id);
  if (need.length) {
    console.log(`配乐 ${need.join('、')} 本地还没有（或者文件不完整），下载中……`);
    const r = await getMusic({ ids: need, log: () => {} });
    for (const id of need.filter((x) => !r.got.includes(x))) {
      const reason = r.why?.[id] ?? '原因不明';
      const ks = PARTS.filter((k) => used[k] && mus[k]?.track?.id === id);
      for (const k of ks) mus[k] = { ...defaultEntry(), wanted: id, reason };
      console.warn(`△ 配乐 ${id} 没下载下来（${reason}），${ks.join('、')}先用默认的 Aurora。告诉主理人：他确认的编排方案上写的是 ${id}。要用它：运行 ${cmd('tools/podcast/music.mjs', '--download')} 补下载（还不行就看 references/故障处理.md），再重新运行 ${cmd('finish.mjs', e.work)}`);
    }
  }
}
const musicFor = Object.fromEntries(PARTS.map((k) => [k, mus[k]?.file ?? null]));
// 人声结束之后还有多长：有节目片尾就放片尾；有片尾音乐就留 11 秒给它；都没有只留 2 秒
// 片尾的曲子不到 13 秒：不循环（见下面"曲子不够长"），曲子放完就结束，不留一大段静音
const tailLen = !outro && musicFor['片尾'] ? duration(musicFor['片尾']) : 0;
const TAIL = outro ? 1.0 + outro.dur + 2.0 : musicFor['片尾'] ? (tailLen > 0 && tailLen < 13 ? Math.max(2.0, tailLen - 2.0) : GAP.tail) : 2.0;
const byId = new Map(full.map((s) => [s.id, s]));

// ---------- 方案 → 说话片段（span）→ 剪辑段（clip） ----------
// 方案里的句子、原文在现在的全文里找不到：全文在 plan 检查之后变过（重新识别、换了常错词、改了称呼规则）。
// 用中文说清楚停下，不崩出英文堆栈（2026-11-20 审查 F3）
const planStale = (what) => { console.error(`${what}：全文在上次检查编排方案之后变过（重新识别过，或者常错词、称呼改过后重出了全文）。这次没剪。先运行 ${cmd('plan.mjs', e.work)} 按现在的全文检查、改好编排方案，再剪。`); process.exit(1); };
const sentence = (id) => byId.get(id) ?? planStale(`编排方案用到的第 ${id} 句在全文里没有（全文共 ${full.length} 句）`);
const findOrStop = (s, text, which) => findInSentence(s, text) ?? planStale(`第 ${s.id} 句里找不到 ${which}「${text}」`);
// 一段 → 实际剪下来的几个片段（去掉只有"嗯""呃"的整句、长停顿处断开、两头留一点余量）：lib/podcast.mjs 的 makeClipper，
// plan 估片头配乐要铺多长也用它，两边说的秒数一致
const { partSpans, clipsOf } = makeClipper(full, { sentence, find: findOrStop });

const timeline = [];
const hookSecs = plan.sections.filter((s) => s.kind === 'hook');
for (const sec of hookSecs) {
  timeline.push({ kind: 'gap', dur: GAP.hookLead, section: sec.name });
  sec.parts.forEach((p, k) => {
    if (k) timeline.push({ kind: 'gap', dur: GAP.betweenQuotes, section: sec.name });
    for (const c of clipsOf(partSpans(p))) timeline.push({ kind: 'clip', ...c, section: sec.name, label: p.label, hook: true });
  });
  if (intro) timeline.push({ kind: 'gap', dur: 0.8, section: sec.name }, { kind: 'gap', dur: intro.dur, section: sec.name, asset: 'intro' }, { kind: 'gap', dur: 1.0, section: sec.name });
  else timeline.push({ kind: 'gap', dur: GAP.afterHook, section: sec.name, music: 'swell' });
}
if (intro && !hookSecs.length) timeline.push({ kind: 'gap', dur: intro.dur, section: '片头', asset: 'intro' }, { kind: 'gap', dur: 1.0, section: '片头' });
let prevBody = null;
for (const sec of plan.sections) {
  if (sec.kind === 'hook') continue;
  // 过渡音乐记在上一个板块名下：章节时间从新板块第一句说话算，和简介里小话题的时间一个算法（v0.7 审查 70）
  if (prevBody) timeline.push({ kind: 'gap', dur: GAP.section, section: prevBody, music: 'transition' });
  prevBody = sec.name;
  const spans = sec.parts.flatMap((p) => partSpans(p).map((sp) => ({ ...sp, label: p.label })));
  // 相邻的几段（不同小话题）可能并成一个 clip：记下每个小话题在这个 clip 里的句子范围，locate 按句子编号报小话题（v0.7 审查 19）
  for (const c of clipsOf(spans)) {
    const labels = [];
    for (const sp of spans) if (sp.id >= c.firstId && sp.id <= c.lastId) { const l = labels.at(-1); if (l && l[2] === sp.label) l[1] = sp.id; else labels.push([sp.id, sp.id, sp.label]); }
    timeline.push({ kind: 'clip', ...c, section: sec.name, label: labels[0]?.[2] ?? spans.find((s) => s.id === c.firstId)?.label, ...(labels.length > 1 ? { labels } : {}) });
  }
}

// ---------- 渲染精编版 ----------
function render(processed, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const clips = timeline.filter((x) => x.kind === 'clip');
  const keptSec = clips.reduce((s, c) => s + c.to - c.from, 0);
  const outSec = keptSec + timeline.filter((x) => x.kind === 'gap').reduce((s, x) => s + x.dur, 0) + TAIL;
  // 空间按"同一时刻最多有哪几个临时文件"算（用完的随手删），旧成品会被覆盖，算回来；不够就停，旧成品不动
  const src = processed ? pcmBytes(keptSec + clips.length * 2 * MARGIN, RATE, CH) : 0, voice = pcmBytes(outSec, RATE, CH), mix = 2 * pcmBytes(outSec, RATE, 2), mp3b = outSec * 25000;
  let old = 0; try { old = fs.statSync(path.join(outDir, '精编版.mp3')).size; } catch {}
  needSpace(e.work, Math.max(0, Math.max(2 * src, src + voice, voice + mix, mix + mp3b) - old), '剪精编版');
  // 先查这次要换掉的文件（含 finish 后面检查、出简介要重写的几个）都换得了：被播放器开着、只读的，什么都不动就停，
  // 不留新旧混着的半套成品（2026-11-22 审查 78、80）。然后删掉旧成品：剪到一半失败时不留旧文件，免得后面的检查查到旧的还说通过。
  // 精编版.retag.mp3 是旧版 notes 换标题失败留下的，顺手删掉
  const OLD = ['精编版.mp3', '剪辑表.json', '章节目录.txt', '检查报告.json', '节目简介.md'];
  const stuck = stuckFiles(outDir, [...OLD, '重点试听.mp3', '重点试听.md', '主理人反馈表.md']);
  if (stuck.length) throw userError(stuckMsg(e.work, '精编版/', stuck));
  for (const f of [...OLD, '精编版.retag.mp3']) fs.rmSync(path.join(outDir, f), { force: true });
  const t0 = Date.now(), step = (s) => console.log(`  ${s}（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);

  // 1. 降噪：只把用得上的片段（两头各多带 0.3 秒）按原顺序拼起来，一次降噪；删掉的部分不处理
  let fd = fs.openSync(e.wav44, 'r'), off = W.dataOff, map = null, env = null;
  if (processed) {
    const m = Math.round(MARGIN * RATE);
    const srcRaw = tmp(outDir, '片段.raw'), dnRaw = tmp(outDir, '片段_降噪.raw');
    const w0 = fs.openSync(srcRaw, 'w');
    map = new Map();
    let at = 0;
    for (const c of clips) {
      const a = Math.round(c.from * RATE), n = Math.round(c.to * RATE) - a + 2 * m;
      fs.writeSync(w0, readFrames(fd, W.dataOff, a - m, n));
      map.set(c, at + m); at += n;
    }
    fs.closeSync(w0); fs.closeSync(fd);
    step(`降噪 ${fmt(keptSec)} 用得上的片段`);
    ff(['-v', 'error', ...rawIn(srcRaw), '-af', PROC.denoise, '-f', 's16le', '-ar', RATE, '-ac', CH, dnRaw], '低切降噪');
    fs.rmSync(srcRaw, { force: true });
    fd = fs.openSync(dnRaw, 'r'); off = 0;
    env = gainEnv().lin;
  }

  // 2. 按时间线拼人声：片段（调平、两头 15ms 淡入淡出）+ 空当
  step('拼人声、分人调平');
  const voiceRaw = tmp(outDir, 'voice.raw');
  const wfd = fs.openSync(voiceRaw, 'w');
  const fadeN = Math.round(FADE * RATE);
  const edl = [], chapters = [];
  let t = 0, lastSection = null, clipped = 0;
  for (const item of timeline) {
    if (item.section !== lastSection) { chapters.push({ t, name: item.section }); lastSection = item.section; }
    if (item.kind === 'gap') {
      const n = Math.round(item.dur * RATE);
      fs.writeSync(wfd, Buffer.alloc(n * BPS));
      if (item.music) edl.push({ kind: item.music, at: +t.toFixed(3), dur: item.dur });
      if (item.asset) edl.push({ kind: 'asset', name: item.asset, at: +t.toFixed(3), dur: item.dur });
      t += n / RATE; continue;
    }
    const f0 = Math.round(item.from * RATE), n = Math.round(item.to * RATE) - f0;
    const buf = map ? readFrames(fd, 0, map.get(item) + DN_DELAY, n) : readFrames(fd, off, f0, n);
    clipped += shape(buf, f0, env, fadeN);
    fs.writeSync(wfd, buf);
    // hook：片头钩子的段（locate 靠它认，不用再看现在的方案里板块叫什么）
    edl.push({ kind: 'clip', section: item.section, label: item.label, ...(item.labels ? { labels: item.labels } : {}), ids: [item.firstId, item.lastId], src: [+item.from.toFixed(3), +item.to.toFixed(3)], out: [+t.toFixed(3), +(t + n / RATE).toFixed(3)], ...(item.hook ? { hook: true } : {}) });
    t += n / RATE;
  }
  const voiceEnd = t;
  if (outro) edl.push({ kind: 'asset', name: 'outro', at: +(voiceEnd + 1.0).toFixed(3), dur: outro.dur });
  fs.writeSync(wfd, Buffer.alloc(Math.round(TAIL * RATE) * BPS)); // 片尾音乐 / 片尾的位置
  fs.closeSync(wfd); fs.closeSync(fd);
  for (const f of tmpFiles) if (f.endsWith('_降噪.raw')) { fs.rmSync(f, { force: true }); }

  // 3. 人声量一次响度（压缩之后），算出整体要加多少 dB
  step('量人声响度');
  const vm = loud([...rawIn(voiceRaw), '-af', `${processed ? `${PROC.comp},` : ''}ebur128`]);
  const vgain = +((LUFS - (vm.lufs ?? LUFS))).toFixed(2);

  // 4. 配乐：片头铺底、板块过渡、片尾（有主理人自己的片尾就不铺）；人声出现时自动压低。
  //    片头、片尾（主理人自己的音频）：调到和人声一样响，放在留好的空当里，不压低
  const swell = edl.find((x) => x.kind === 'swell');
  const [mi, mt, mo] = PARTS.map((k) => musicFor[k]);
  const sting = trackByPath(mt)?.kind === '过渡音' ? duration(mt) : 0; // 过渡音：从头放，最长 过渡空当+1.2 秒（约 4.2 秒），最后 0.6 秒淡出；比这长的（曲库里几首有十几秒）在中间截断淡出
  const pieces = [
    ...(swell && mi ? [{ part: '片头', file: mi, at: 0, from: 0, dur: swell.at + GAP.afterHook + GAP.bedAfter, fin: 0.8, fout: 3.0 }] : []),
    ...(mt ? edl.filter((x) => x.kind === 'transition').map((x, k) => (sting
      ? { part: '过渡', file: mt, at: x.at, from: 0, dur: Math.min(sting, x.dur + 1.2), fin: 0.02, fout: Math.min(0.6, sting / 3) }
      : { part: '过渡', file: mt, at: Math.max(0, x.at - 0.15), from: 12 + ((k * 9) % 55), dur: x.dur + 0.9, fin: 0.35, fout: 1.4 })) : []),
    ...(outro || !mo ? [] : [{ part: '片尾', file: mo, at: voiceEnd - 2.5, from: 30, dur: 13, fin: 1.5, fout: 5 }]),
  ];
  // 曲子不够长：不循环（循环会放完结尾、静一下又从头响起来）。片尾往前挪到曲子最后 13 秒，过渡在曲子里另挑一截；
  // 曲子比要铺的还短，就只放到曲子结束、提前淡出，并提示（v0.7 审查 65）。
  // 过渡音本来就是从头整段放完，长度刚好等于曲子，不算"不够长"（和 plan 的判断一致）；同一处同一首只提示一次
  const lens = new Map(), shortMusic = [];
  for (const p of pieces) {
    if (p.part === '过渡' && sting) continue;
    if (!lens.has(p.file)) lens.set(p.file, duration(p.file));
    const L = lens.get(p.file);
    if (!(L > 0) || p.from + p.dur <= L - 0.05) continue;
    p.from = p.part === '过渡' && L - p.dur > 1 ? p.from % (L - p.dur) : Math.max(0, L - p.dur);
    if (p.dur > L - 0.05) {
      const w = `${p.part}的配乐 ${path.basename(p.file)} 只有 ${Math.round(L)} 秒，这里要铺约 ${Math.round(p.dur)} 秒：放完就淡出，不重复`;
      if (!shortMusic.some((x) => x.startsWith(`${p.part}的配乐 ${path.basename(p.file)} `))) shortMusic.push(w);
      p.from = 0; p.dur = Math.max(0.5, L - 0.05); p.fout = Math.min(p.fout, p.dur / 3); p.fin = Math.min(p.fin, p.dur / 3);
    }
  }
  const assets = edl.filter((x) => x.kind === 'asset').map((x) => ({ ...x, file: (x.name === 'intro' ? intro : outro).file }));
  // 每首曲子实测响度，单独响的时候调到"目标响度 − 4 dB"
  const gains = new Map();
  for (const p of pieces) if (!gains.has(p.file)) gains.set(p.file, +((LUFS - MUSIC_BELOW_DB) - (loudFile(p.file).lufs ?? -22)).toFixed(1));
  for (const p of pieces) p.gain = gains.get(p.file);
  const musicGain = pieces.length ? pieces[0].gain : 0;

  // 5. 一遍混好：人声（压缩 + 整体增益，单声道变立体声）+ 配乐（压低）+ 片头片尾，最后限幅
  step('混音');
  const finalWav = tmp(outDir, 'final.wav');
  const inputs = [...rawIn(voiceRaw)], filt = [`[0:a]${processed ? `${PROC.comp},` : ''}volume=${vgain}dB,aformat=sample_fmts=fltp:sample_rates=${RATE}:channel_layouts=stereo[vin]`];
  let n = 1;
  pieces.forEach((p, k) => {
    inputs.push('-i', p.file);
    filt.push(`[${n++}:a]atrim=start=${p.from.toFixed(2)}:duration=${p.dur.toFixed(2)},asetpts=PTS-STARTPTS,aresample=${RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${p.gain}dB,afade=t=in:d=${p.fin},afade=t=out:st=${(p.dur - p.fout).toFixed(2)}:d=${p.fout},adelay=${Math.round(p.at * 1000)}:all=1[m${k}]`);
  });
  assets.forEach((a, k) => {
    inputs.push('-i', a.file);
    filt.push(`[${n++}:a]aresample=${RATE},aformat=channel_layouts=stereo,loudnorm=I=${LUFS}:TP=-2:LRA=11,aresample=${RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${a.dur.toFixed(2)},adelay=${Math.round(a.at * 1000)}:all=1[s${k}]`);
  });
  const parts = [];
  if (pieces.length) {
    filt.push(`${pieces.map((_, k) => `[m${k}]`).join('')}amix=inputs=${pieces.length}:normalize=0:duration=longest[mus]`, '[vin]asplit=2[v1][v2]',
      '[mus][v1]sidechaincompress=threshold=0.012:ratio=12:attack=20:release=450:makeup=1[duck]');
    parts.push('[v2]', '[duck]');
  } else parts.push('[vin]');
  parts.push(...assets.map((_, k) => `[s${k}]`));
  // 混音这一步存 32 位浮点，不限幅（限幅只在最后出 mp3 时做一次，否则补响度时会被它吃掉）
  const lim = `alimiter=limit=${LIMIT}:level=false:latency=1`; // latency=1：补掉限幅器自己的 5ms 延迟
  filt.push(parts.length > 1 ? `${parts.join('')}amix=inputs=${parts.length}:normalize=0:duration=first[mix]` : `${parts[0]}anull[mix]`);
  ff(['-v', 'error', ...inputs, '-filter_complex', filt.join(';'), '-map', '[mix]', '-c:a', 'pcm_f32le', finalWav], '混音');
  fs.rmSync(voiceRaw, { force: true });

  // 6. 成品量一次，差多少补多少（一般零点几 dB），直接在出 mp3 时补上，不再多跑一遍
  step('量成品响度、出 mp3');
  const fm = loudFile(finalWav);
  const corr = +((LUFS - (fm.lufs ?? LUFS))).toFixed(2);
  // 限幅会压掉一点响度，160k 的 mp3 编码又会少约 0.5 LU（2026-11-19 实测；320k 不会）。所以量的是编码好的 mp3：
  // 差 0.2 LU 以上就按差值重新编码一次。量出来的数记进剪辑表，检查直接用，不再量第二遍
  const mp3 = path.join(outDir, '精编版.mp3');
  const encode = (gain) => ff(['-v', 'error', '-i', finalWav, '-af', `volume=${gain.toFixed(2)}dB,${lim}`, '-c:a', 'libmp3lame', '-b:a', '160k', '-id3v2_version', '3', '-metadata', `title=${mp3Title(plan)}`, mp3], '出 mp3');
  let gainNow = corr + 0.5;
  encode(gainNow);
  let est = loudFile(mp3);
  if (est.lufs != null && Math.abs(LUFS - est.lufs) > 0.2) { gainNow += LUFS - est.lufs; step('补一点响度'); encode(gainNow); est = loudFile(mp3); }
  if (process.env.BOKE_DEBUG) console.log('  [debug] 混音后', JSON.stringify(fm), '补', gainNow.toFixed(2), '成品', JSON.stringify(est));
  cleanTmp();
  step('完成');
  est = { ...est, mp3: fileSha(mp3) };
  writeJson(path.join(outDir, '剪辑表.json'), {
    // wav16、full：按哪份录音、哪版全文剪的（重新转写后 status、--confirm 成品、clean 认得出精编版是旧的）
    wav16: readJson(path.join(e.mid, '录音.json'), {}).wav16sha ?? null, full: fullSha(full),
    plan: planSha(plan, 'audio'), title: mp3Title(plan), processed, channels: CH, renderVersion: RENDER_VERSION, voiceEnd: +voiceEnd.toFixed(3), tail: +TAIL.toFixed(3), length: +(voiceEnd + TAIL).toFixed(3), lufs: LUFS,
    show: show?.file ?? null, showSha: show ? fileSha(show.file) : null, musicFile: pieces.length ? (pieces[0].file === MUSIC ? 'default' : path.basename(pieces[0].file)) : null, musicGain,
    // 用到的每首曲子：哪一处、文件、曲库编号和署名（曲库外的文件没有署名，notes 会提醒）
    // from：方案（这期编排方案指定）/ 档案（节目档案的"配乐"）/ 默认
    musicTracks: [...new Set(pieces.map((p) => p.file))].map((f) => { const tr = trackByPath(f); const k = PARTS.find((x) => mus[x]?.file === f); const sw = PARTS.filter((x) => mus[x]?.file === f && mus[x]?.wanted && pieces.some((p) => p.part === x)); return { parts: [...new Set(pieces.filter((p) => p.file === f).map((p) => p.part))], file: f === MUSIC ? 'default' : path.basename(f), from: mus[k]?.from ?? null, id: tr?.id ?? null, credit: tr ? credit(tr) : null, ...(sw.length ? { wanted: mus[sw[0]].wanted, reason: mus[sw[0]].reason, swapped: sw } : {}) }; }),
    assets: assets.map((a) => ({ name: a.name, file: path.basename(a.file), at: a.at, dur: +a.dur.toFixed(3) })), music: pieces.map((p) => ({ ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v])), file: path.basename(p.file) })), items: edl,
    measured: est, clipped, renderSeconds: Math.round((Date.now() - t0) / 1000), // clipped：调平时削掉的采样点，check 看它报"削顶"
  });
  fs.writeFileSync(path.join(outDir, '章节目录.txt'), chapters.map((c) => `${fmt(c.t)} ${c.name}`).join('\n') + '\n', 'utf8');
  return { mp3, edl, voiceEnd, clipped, chapters, est, shortMusic };
}

try {
  const processed = effectiveVoice(plan, show) !== 'raw';
  console.log(`剪精编版（${processed ? '带人声处理' : '不做人声处理'}${!plan.voice && showVoice(show) ? '，按节目档案' : ''}${CH === 1 ? '，单声道录音' : ''}）……`);
  const r = render(processed, e.out);
  const m = r.est;
  // 只写真放进去的：有节目片头或者没有钩子时不铺片头音乐，有节目片尾时不铺片尾音乐，只有一个板块时没有过渡
  const nBodies = plan.sections.filter((s) => s.kind !== 'hook').length;
  const why = { 片头: intro ? '用节目片头，不铺音乐' : !hookSecs.length ? '没有片头钩子，不铺音乐' : null, 过渡: nBodies < 2 ? '只有一个板块，没有过渡' : null, 片尾: outro ? '用节目片尾，不铺音乐' : null };
  console.log(`配乐：${PARTS.map((k) => `${k} ${why[k] ? `（${why[k]}）` : musicName(mus[k])}`).join('；')}`);
  for (const w of r.shortMusic) console.warn(`△ ${w}`);
  if (show) console.log(`节目档案：${[intro && `片头 ${path.basename(intro.file)}`, outro && `片尾 ${path.basename(outro.file)}`, `响度 ${LUFS} LUFS`].filter(Boolean).join('，')}`);
  console.log(`精编版：${fmt(r.voiceEnd + TAIL)}，${r.edl.filter((x) => x.kind === 'clip').length} 段，响度 ${m.lufs} LUFS，峰值 ${m.peak} dBFS，音量起伏 ${m.lra} LU${processed ? `，调平削顶 ${r.clipped} 个采样点` : ''}`);
  console.log(r.chapters.map((c) => `  ${fmt(c.t)} ${c.name}`).join('\n'));
  console.log(`下一步：${cmd('check.mjs', e.work)} 做机器检查，再 ${cmd('notes.mjs', e.work)} 出简介。`);
  logStep(e, '剪精编版', T0);
} catch (err) { cleanTmp(); console.error(err.message); process.exit(1); }

