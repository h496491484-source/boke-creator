#!/usr/bin/env node
// 精编版机器检查：成品逐段重新识别、对照应有的原话（查接缝吞字），以及响度、峰值、时长、配乐（片头、过渡、片尾都在）、说话中间的长静音、削顶。写 精编版/检查报告.json。
//
//   node tools/podcast/check.mjs <节目目录>
//
// 通过 ≠ 好听。最后一定要本人从头听一遍。

import fs from 'node:fs';
import path from 'node:path';
import { relaunchOnMac, loadSherpa, asrModel, threads, episode, mustExist, loadFull, readJson, readJsonLoose, writeJson, ff, measure, channelLevels, channelInfo, recordingsInfo, duration, fileSha, fmt, planSha, logStep, RATE, RATE16, planOrExit, cmd, takeLock, stuckFiles, stuckMsg, userError, longPathMsg } from '../lib/podcast.mjs';
const T0 = Date.now();

relaunchOnMac();
const dir = process.argv[2];
if (!dir) { console.error(`用法: ${cmd('check.mjs')} <节目目录>`); process.exit(2); }
mustExist(dir);
const e = episode(dir);
const mp3 = path.join(e.out, '精编版.mp3');
const edlFile = path.join(e.out, '剪辑表.json');
if (!fs.existsSync(mp3) || !fs.existsSync(edlFile)) { console.error(`还没有精编版。先运行 ${cmd('finish.mjs', e.work)}（剪精编版、机器检查、出简介一条命令做完）`); process.exit(1); }
const plan = planOrExit(e); // 方案写坏了直接说哪一行，不要报成"方案改过、精编版不是最新"
const lp = longPathMsg(e); // 节目目录太深：识别程序读不了 check16k.wav，只会报一句英文
if (lp) { console.error(lp); process.exit(1); }
takeLock(e, '检查'); // 检查时在 制作文件/ 写 check16k.wav：clean 看到这把锁就不清

const results = [];
const add = (name, status, detail) => results.push({ name, status, detail });
try {
  const edl = readJson(edlFile);
  const full = loadFull(e);
  // 只看会改变成品声音的部分（板块、句子范围、配乐、人声处理）；改简介、标题不算
  // 旧版剪辑表记的是整个方案文件的指纹：还对得上就算最新（和 status 一样）
  if (edl.plan !== planSha(plan, 'audio') && edl.plan !== fileSha(e.plan)) add('方案', '未通过', '编排方案.json 里的板块、句子范围、配乐或人声处理在剪完之后改过，精编版不是最新的，重新运行 ' + cmd('finish.mjs', e.work) + '（= 剪精编版 → 检查 → 出简介；单独跑 build 会删掉检查报告和节目简介）');

  // 1. 规格：响度、峰值、时长。build 出完 mp3 已经量过一次（剪辑表 measured），文件没变就直接用，不再量第二遍
  const mp3sha = fileSha(mp3);
  const m = edl.measured?.mp3 === mp3sha ? edl.measured : measure(mp3);
  const target = edl.lufs ?? -16;
  add('响度', Math.abs(m.lufs - target) <= 1 ? '通过' : '未通过', `${m.lufs} LUFS（目标 ${target}，±1）`);
  add('峰值', m.peak <= -1 ? '通过' : '未通过', `${m.peak} dBFS（不超过 -1）`);
  add('音量起伏', m.lra <= 10 ? '通过' : '提示', `${m.lra} LU${m.lra > 10 ? '，偏大，听感忽大忽小' : ''}`);
  // 左右声道差得多：人声只在一只耳朵里（录音只有一边声道有声音，旧版没认出来、当成立体声剪了）。
  // 整体响度把两边加在一起算，看不出来，要分开量。单声道录音剪出来两边一样，不用量；只量前 10 分钟（2026-11-22 审查 73）
  // 只有"重新转换真能改好"时才算没过：原始录音现在会被认成只有一边有声音，而上次转换没这样处理（旧版转的）。
  // 两边都有人声、只是一边小得多（一边话筒增益开得小、两人各占一边说话多少差很多）重新转换也一样，只提示，给 --mono 的改法；
  // 不然 finish 怎么都过不了，照提示做了也没用（2026-11-23 复核 73）
  if ((edl.channels ?? 2) !== 1) {
    const [l, r] = channelLevels(mp3, { t: 600 });
    const db = (x) => (x > -Infinity ? `${x.toFixed(1)} dB` : '没声音');
    const gap = l > -Infinity && r > -Infinity ? Math.abs(l - r) : Infinity;
    if (gap <= 10) add('左右声道', '通过', `左 ${db(l)}、右 ${db(r)}`);
    else {
      const side = r > -Infinity && r > l ? '右' : '左';
      const meta = readJsonLoose(path.join(e.mid, '录音.json'), {});
      let fixable = null; // null：原始录音找不到，说不准
      try {
        const recs = recordingsInfo(e).files;
        // 选了几条音轨一起用的文件：逐条看，有一条只有一边有声音、上次转换没单独处理它（旧版转的，录音.json 没有 streamOnly）也算能改好（2026-11-24 第 3 轮 3）
        if (recs.length && recs.every((f) => fs.existsSync(f))) fixable = recs.some((f, i) => (meta.sel?.[i]?.length > 1
          ? meta.sel[i].some((k, j) => { const c = channelInfo(f, k); return c.only != null && c.only !== (meta.streamOnly?.[i]?.[j] ?? null); })
          : ((c) => c.only != null && c.only !== (meta.only?.[i] ?? null))(channelInfo(f, meta.sel?.[i]?.[0] ?? 0))));
      } catch { /* 量不了原始录音就按说不准处理 */ }
      const MONO = `运行 ${cmd('transcribe.mjs', e.work, '--mono')} 把左右两边合成一路、按单声道重新转换（识别结果留着，句子编号不变），再重剪`;
      if (fixable) add('左右声道', '未通过', `左 ${db(l)}、右 ${db(r)}，差得太多：人声多半只在${side}耳。原始录音只有一边声道有声音，这份是旧版转的：删掉 制作文件/ 里的 原始_44k.wav、16k.wav 和 段响度.json，`
        + `运行 ${cmd('transcribe.mjs', e.work)} 重新转换（只取有声音的那边；识别结果留着，句子编号不变），再重剪`);
      else add('左右声道', '提示', `左 ${db(l)}、右 ${db(r)}，${side}边大得多。${fixable === false ? '原始录音两边都有声音' :'原始录音找不到，看不了'}，`
        + `多半是一边话筒增益开得小，或者两人各占一边、说话多少差很多。戴耳机听一下：听着人声偏在一只耳朵里，${MONO}；听着没问题就不用管`);
    }
  }
  const wantLen = edl.length ?? edl.voiceEnd + 11, got = duration(mp3);
  add('时长', Math.abs(got - wantLen) < 1.5 ? '通过' : '未通过', `${fmt(got)}（剪辑表算出来 ${fmt(wantLen)}）`);
  // 只有真放了片尾音乐，或者有节目片尾时才测（只关掉片尾音乐时，结尾本来就是安静的）
  // 名字和下面"节目片尾"分开：一个是人声结束后还有没有声音，一个是主理人自己的片尾放没放对（v0.7 审查 72）
  // 片尾的曲子很短（build 不循环、放完就结束）：只量曲子还在响的那一截，太短量不了就不量
  const tailMusic = edl.music?.find((p) => (p.part ?? '片尾') === '片尾' && p.at >= edl.voiceEnd - 5);
  const hasOutroAsset = edl.assets?.some((a) => a.name === 'outro');
  const tailEnd = hasOutroAsset || !tailMusic?.fout ? edl.voiceEnd + 4.5 : Math.min(edl.voiceEnd + 4.5, tailMusic.at + tailMusic.dur - tailMusic.fout / 2);
  const tailFrom = Math.max(edl.voiceEnd + 0.2, Math.min(edl.voiceEnd + 1.5, tailEnd - 1));
  if ((tailMusic || hasOutroAsset) && tailEnd - tailFrom >= 0.8) {
    const tail = measure(mp3, { ss: +tailFrom.toFixed(2), t: +(tailEnd - tailFrom).toFixed(2) });
    add('结尾余音', tail.lufs > -40 ? '通过' : '未通过', `人声结束后 ${tail.lufs} LUFS`);
  }
  // 片头片尾（主理人自己的音频）真的放进去了、响度和人声差不多
  for (const a of edl.assets ?? []) {
    const x = measure(mp3, { ss: a.at, t: Math.min(a.dur, 20) });
    const ok = x.lufs != null && Math.abs(x.lufs - target) <= 4;
    add(a.name === 'intro' ? '节目片头' : '节目片尾', ok ? '通过' : '提示', `${a.file} 在 ${fmt(a.at)}，${x.lufs} LUFS${ok ? '' : '，和人声响度差得多，去听一下'}`);
  }
  // 片头铺底、板块过渡的配乐真的在：只量没有人声的那一小段（片尾的在上面"结尾余音"量过）（v0.7 审查 64）
  const clipsAll = edl.items.filter((x) => x.kind === 'clip');
  const quietAround = (q) => { let a = 0, b = got; for (const c of clipsAll) { if (c.out[1] <= q) a = Math.max(a, c.out[1]); else if (c.out[0] > q) b = Math.min(b, c.out[0]); } return [a, b]; };
  const musLost = [], musSeen = [];
  for (const p of (edl.music ?? []).filter((p) => p.part === '片头' || p.part === '过渡')) {
    const [a, b] = quietAround(p.at + Math.min(p.fin + 0.3, p.dur / 2));
    const s = Math.max(a, p.at + p.fin * 0.5) + 0.1, t = Math.min(b, p.at + p.dur - p.fout * 0.5) - 0.1 - s;
    if (t < 0.5) continue;
    const x = measure(mp3, { ss: +s.toFixed(2), t: +t.toFixed(2) });
    (x.lufs != null && x.lufs > -40 ? musSeen : musLost).push(`${p.part} ${fmt(p.at)}`);
  }
  // 方案选的曲库曲子没下载下来、build 换成了默认的 Aurora：说出来，主理人确认的编排方案上写的是另一首（v0.7 审查 66）
  const swapped = (edl.musicTracks ?? []).filter((x) => x.wanted);
  if (musLost.length || musSeen.length || swapped.length) {
    add('配乐', musLost.length ? '未通过' : swapped.length ? '提示' : '通过', [
      musLost.length ? `这几处听不到配乐：${musLost.join('、')}，重新运行 ${cmd('finish.mjs', e.work)}（重剪、重新检查、重出简介）` : musSeen.length ? `铺配乐的地方都听得到（${musSeen.join('、')}）` : '',
      ...swapped.map((x) => `编排方案选的 ${x.wanted} 没用上（${x.reason ?? '没下载下来'}），${(x.swapped ?? x.parts).join('、')}换成了默认的 Aurora：告诉主理人；要用原来那首，补下载后重新运行 ${cmd('finish.mjs', e.work)}`),
    ].filter(Boolean).join('；'));
  }
  // 长段静音（中间掉音）、削顶：响度和峰值查不出来（v0.7 审查 64）
  //   静音：-50 dB 以下连着 3 秒以上、而且落在说话的段里（板块之间的空当、片尾不算）；
  //   削顶：build 调平时削掉的采样点；成品峰值只比平均音量高一点点（削顶后再压低音量的典型样子）
  const sv = ff(['-nostats', '-i', mp3, '-af', 'silencedetect=n=-50dB:d=3,volumedetect', '-f', 'null', '-'], '查静音和削顶');
  const silences = [...sv.matchAll(/silence_start:\s*(-?[\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g)].map((m) => [Math.max(0, +m[1]), +m[2]]);
  const holes = [];
  for (const [a, b] of silences) for (const c of clipsAll) {
    const s = Math.max(a, c.out[0]), t = Math.min(b, c.out[1]);
    if (t - s >= 2) holes.push({ at: s, len: t - s, section: c.section });
  }
  if (holes.length) add('静音', holes.some((h) => h.len >= 10) ? '未通过' : '提示', `说话的段里有 ${holes.length} 处几乎没声音：${holes.map((h) => `${fmt(h.at)} 起 ${h.len.toFixed(0)} 秒（${h.section}）`).join('、')}。去听一下：原录音本来就停了那么久，还是成品掉了音；掉了音就重新运行 ${cmd('finish.mjs', e.work)}（重剪、重新检查、重出简介）`);
  else add('静音', '通过', '说话的段里没有 3 秒以上的静音');
  const vMax = Number(sv.match(/max_volume:\s*(-?[\d.]+) dB/)?.[1]), vMean = Number(sv.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1]);
  const crest = Number.isFinite(vMax) && Number.isFinite(vMean) ? vMax - vMean : null;
  const voiceSamples = clipsAll.reduce((s, c) => s + c.out[1] - c.out[0], 0) * RATE * (edl.channels ?? 2);
  const clipRate = edl.clipped != null && voiceSamples ? edl.clipped / voiceSamples : 0;
  const clipNotes = [
    clipRate > 1e-4 ? `调平时削掉了 ${edl.clipped} 个采样点（${(clipRate * 100).toFixed(2)}%）` : '',
    crest != null && crest < 11 ? `峰值只比平均音量高 ${crest.toFixed(1)} dB（正常的人声一般高 13 dB 以上），像是削顶后又压低了音量` : '',
  ].filter(Boolean);
  add('削顶', clipNotes.length ? '提示' : '通过', clipNotes.length ? `${clipNotes.join('；')}：从头听几段，有没有发毛、破音` : `峰值比平均音量高 ${crest?.toFixed(1) ?? '?'} dB${edl.clipped != null ? `，调平削顶 ${edl.clipped} 个采样点` : ''}`);

  // 2. 接缝：每段单独重新识别，比对段首段尾 6 个字
  const BARE = /[，。！？、；：,.!?;:\s]/g;
  const ed = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
  // 最长公共子序列（按顺序相同的字数）
  const lcs = (a, b) => { let prev = new Array(b.length + 1).fill(0); for (let i = 1; i <= a.length; i++) { const cur = [0]; for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]); prev = cur; } return prev[b.length]; };
  const toks = full.flatMap((s) => s.toks);
  // 每段只认开头和结尾各 8 秒（一段内部是原录音连续的一截，只有两头是剪口；整段一两分钟一次认，模型自己会漏字，造成误报）
  const W = 8;
  const want = (a, b) => toks.filter((t) => t.s >= a - 0.02 && t.s < b).map((t) => t.t).join('').replace(BARE, '');
  const clips = edl.items.filter((x) => x.kind === 'clip');
  // 改了再出时，大部分剪口没变：同样的原录音片段、同样的处理、同样的响度、底下垫的配乐也一样，就用上次的识别结果
  const cacheFile = path.join(e.mid, '接缝缓存.json');
  const cache = readJsonLoose(cacheFile, {}); // 缓存坏了就重新识别接缝
  // 录音的指纹也算进去：换了录音（加了补录、重新导出）以后原录音时间一样，声音却不一样，不能套用旧的识别结果（2026-11-22 审查）
  const recSha = readJson(path.join(e.mid, '录音.json'), {}).wav16sha ?? null;
  const keyOf = (c, a, b) => JSON.stringify([edl.renderVersion ?? 1, recSha, c.src, edl.processed, edl.lufs, edl.channels ?? 2, +(a - c.out[0]).toFixed(3), +(b - a).toFixed(3),
    (edl.music ?? []).filter((p) => p.at < b && p.at + p.dur > a).map((p) => [p.file, p.from, +(p.at - c.out[0]).toFixed(2), p.dur, p.gain])]);
  const jobs = [];
  for (const c of clips) {
    const len = Math.min(W, c.out[1] - c.out[0]);
    for (const [a, b] of [[c.out[0], c.out[0] + len], [c.out[1] - len, c.out[1]]]) jobs.push({ a, b, key: keyOf(c, a, b) });
  }
  // 缓存只认"这个 mp3 就是 build 出的那个"：精编版.mp3 被换掉、改坏了（指纹和剪辑表记的对不上），每处都重新识别。
  // 只改标题（notes 改 ID3）会把记的指纹一起挪过去，缓存照用（v0.7 审查 63）
  const todo = edl.measured?.mp3 === mp3sha ? jobs.filter((j) => !(j.key in cache)) : jobs;
  if (todo.length) {
    const sherpa = loadSherpa(), model = asrModel();
    const w16 = path.join(e.mid, 'check16k.wav');
    ff(['-v', 'error', '-i', mp3, '-ar', RATE16, '-ac', 1, '-c:a', 'pcm_s16le', w16], '转 16k');
    const samples = sherpa.readWave(w16, false).samples;
    fs.rmSync(w16, { force: true });
    const T = threads(), lanes = Math.min(4, T);
    const rec = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: RATE16, featureDim: 80 }, modelConfig: { senseVoice: { model: model.model, language: 'zh', useInverseTextNormalization: 1 }, tokens: model.tokens, numThreads: Math.max(1, Math.floor(T / lanes)), provider: 'cpu', debug: 0 } });
    let next = 0;
    await Promise.all(Array.from({ length: lanes }, async () => {
      while (next < todo.length) {
        const j = todo[next++];
        const st = rec.createStream(); st.acceptWaveform({ sampleRate: RATE16, samples: samples.subarray(Math.round(j.a * RATE16), Math.round(j.b * RATE16)) });
        cache[j.key] = (await rec.decodeAsync(st)).text.replace(/<\|[^|]*\|>/g, '').replace(BARE, '');
      }
    }));
    // 只留这次用到的，免得越存越大。不是 build 出的那个 mp3 时不存（换回原来的 mp3 后不能用上坏文件的结果）
    if (edl.measured?.mp3 === mp3sha) writeJson(cacheFile, Object.fromEntries(jobs.map((j) => [j.key, cache[j.key]])), 0);
  }
  const seams = [];
  let chars = 0, dist = 0, k = 0;
  for (const c of clips) {
    const len = Math.min(W, c.out[1] - c.out[0]);
    const hw = want(c.src[0], c.src[0] + len - 0.3), hg = cache[jobs[k++].key];
    const tw = want(c.src[1] - len + 0.3, c.src[1]), tg = cache[jobs[k++].key];
    chars += hw.length + tw.length; dist += ed(hw, hg) + ed(tw, tg);
    // 两头对不上、而且成品明显少了字才像吞字；字数差不多只是认成了别的字（两次识别的正常出入），多认出半个字（垫音里的现场声）也不算
    const headBad = ed(hw.slice(0, 5), hg.slice(0, 5)) >= 3 && !hg.includes(hw.slice(1, 4)) && hw.length - hg.length >= 3;
    const tailBad = ed(tw.slice(-5), tg.slice(-5)) >= 3 && !tg.includes(tw.slice(-4, -1)) && tw.length - tg.length >= 3;
    if (headBad || tailBad) seams.push({ atSec: headBad ? c.out[0] : c.out[1], at: fmt(headBad ? c.out[0] : c.out[1]), where: headBad ? '段首' : '段尾', section: c.section, want: headBad ? hw.slice(0, 12) : tw.slice(-12), got: headBad ? hg.slice(0, 12) : tg.slice(-12) });
    // 字数差不多、内容却整段换了（剪到了别的话）：不是吞字，也要说出来
    else {
      // 同一句话两次都认错（同音字：VOL01 的"年年过必有规纳"和"念念不忘必有毁妙"）编辑距离也很大，可按顺序相同的字还有四成上下；
      // 真剪到了别的话，按顺序相同的字很少超过三分之一（VOL01 里随便取两段比，99.5% 不到 1/3）。两样都满足才算（2026-11-24 第 3 轮 7）
      const off = (w, g) => w.length >= 6 && ed(w, g) >= Math.max(4, w.length * 0.6) && lcs(w, g) < w.length / 3;
      const hOff = off(hw, hg), tOff = off(tw, tg);
      if (hOff || tOff) seams.push({ atSec: hOff ? c.out[0] : c.out[1], at: fmt(hOff ? c.out[0] : c.out[1]), where: hOff ? '段首（说的话对不上）' : '段尾（说的话对不上）', section: c.section, want: hOff ? hw.slice(0, 12) : tw.slice(-12), got: hOff ? hg.slice(0, 12) : tg.slice(-12) });
    }
  }
  // 整体差得太多（正常是几个百分点）：成品剪的不是全文里的那些话——多半是录音在转写之后换过、加了补录没重新转写，或者转写半路断了。
  // 这种情况一定不能算通过（2026-11-22 审查：差 112% 还判"通过"）
  const pct = dist / Math.max(1, chars) * 100, wrong = chars >= 30 && pct > 30;
  add('接缝', wrong ? '未通过' : seams.length ? '提示' : '通过', `${clips.length} 段的段首段尾重新识别${todo.length < jobs.length ? `（${jobs.length - todo.length} 处没变，用上次的结果）` : ''}，和原话差 ${pct.toFixed(1)}%（同一模型两次识别本身也有几个百分点的出入）`
    + (wrong ? `：差得太多，精编版剪的不是全文里的那些话。多半是录音在转写之后变过（加了补录、换了文件、改了录音顺序）或者转写半路断了：运行 ${cmd('status.mjs', e.work)} 看下一步，重新转写、核对方案后再出成品` : '')
    + (seams.length ? `；${seams.length} 处可能吞了字或剪错了地方，去听一下：${seams.map((s) => `${s.at}${s.where}`).join('、')}` : ''));
  // 3. 重点试听：把最该听的地方各剪 10 秒拼成一个短文件，主理人几分钟就能先听一遍
  //    可能吞字的剪口、每个板块开头、节目片头片尾、被调平拉得最大声的几句（底噪可能跟着变大）
  const pts = [];
  for (const s of seams) pts.push({ t: s.atSec - 4, why: /对不上/.test(s.where) ? `${s.where}：原话"${s.want}"` : `可能吞了字（${s.where}，原话"${s.want}"）`, pri: 0 });
  for (const h of holes) pts.push({ t: h.at - 3, why: `说话的段里 ${h.len.toFixed(0)} 秒几乎没声音`, pri: 0 });
  for (const a of edl.assets ?? []) pts.push({ t: a.at, why: a.name === 'intro' ? '节目片头接进来的地方' : '节目片尾接进来的地方', pri: 1 });
  const secSeen = new Set();
  for (const c of clips) if (!secSeen.has(c.section)) { secSeen.add(c.section); pts.push({ t: Math.max(0, c.out[0] - 1.5), why: `板块开头：${c.section}`, pri: 2 }); }
  const lv = readJson(e.levels, null);
  if (edl.processed && lv?.segs?.length) {
    const boost = [];
    for (const s of lv.segs) {
      if (s.db < -90 || s.end - s.start < 2) continue;
      const g = Math.min(8, (lv.median - s.db) * 0.8);
      const c = clips.find((c) => c.src[0] <= s.start && s.end <= c.src[1]);
      if (g >= 5 && c) boost.push({ t: c.out[0] + s.start - c.src[0], why: `声音小的人被拉大约 ${g.toFixed(0)} dB，听听底噪有没有跟着变大`, pri: 3, g });
    }
    pts.push(...boost.sort((a, b) => b.g - a.g).slice(0, 3));
  }
  const picked = [];
  for (const p of pts.sort((a, b) => a.pri - b.pri)) if (picked.length < 20 && picked.every((q) => Math.abs(q.t - p.t) > 12)) picked.push({ ...p, t: Math.max(0, p.t) });
  picked.sort((a, b) => a.t - b.t);
  const listen = path.join(e.out, '重点试听.mp3'), listenMd = path.join(e.out, '重点试听.md');
  // 重点试听被播放器开着、是只读的：说清楚，不打 ffmpeg 的英文报错（2026-11-22 审查 80）
  const stuck = stuckFiles(e.out, ['重点试听.mp3', '重点试听.md', '检查报告.json']);
  if (stuck.length) throw userError(stuckMsg(e.work, '精编版/', stuck));
  if (picked.length) {
    const SN = 10, GAPS = 0.8;
    ff(['-v', 'error', ...picked.flatMap((p) => ['-ss', p.t.toFixed(2), '-t', SN, '-i', mp3]), '-filter_complex',
      picked.map((_, i) => `[${i}:a]afade=t=in:d=0.05,afade=t=out:st=${SN - 0.3}:d=0.3,apad=pad_dur=${GAPS}[p${i}]`).join(';') + `;${picked.map((_, i) => `[p${i}]`).join('')}concat=n=${picked.length}:v=0:a=1[o]`,
      '-map', '[o]', '-c:a', 'libmp3lame', '-b:a', '128k', listen], '重点试听');
    fs.writeFileSync(listenMd, ['# 重点试听', '', `\`重点试听.mp3\` 把精编版里最该听的 ${picked.length} 处各剪了 ${SN} 秒，接在一起，一共约 ${fmt(picked.length * (SN + GAPS))}。先听这个，有问题记下"在精编版里"的时间点。时间允许，最好还是从头完整听一遍。`, '',
      '| 序号 | 在重点试听里 | 在精编版里 | 听什么 |', '|---|---|---|---|',
      ...picked.map((p, i) => `| ${i + 1} | ${fmt(i * (SN + GAPS))} | ${fmt(p.t)} | ${p.why.replace(/\|/g, '｜')} |`), ''].join('\n'), 'utf8');
  }
  writeJson(path.join(e.out, '检查报告.json'), { at: new Date().toISOString(), mp3: mp3sha, results, seams, listen: picked.map((p) => ({ t: +p.t.toFixed(2), why: p.why })) });
  if (picked.length) add('重点试听', '通过', `重点试听.mp3：${picked.length} 处、约 ${fmt(picked.length * 10.8)}，清单在 重点试听.md`);
  logStep(e, '机器检查', T0);
} catch (err) { console.error(err.message); process.exit(1); }

const w = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((k, ch) => k + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));
for (const r of results) console.log(`${w(r.status, 8)}${w(r.name, 10)}${r.detail}`);
const failed = results.filter((r) => r.status === '未通过');
console.log(failed.length ? `\n${failed.length} 项没过。` : '\n机器检查通过。通过不等于好听：请本人从头到尾听一遍。');
process.exit(failed.length ? 1 : 0);
