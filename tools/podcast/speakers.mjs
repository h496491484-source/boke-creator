#!/usr/bin/env node
// 分说话人 + 声音点名。慢（65 分钟、十来个人约 6–15 分钟），建议放后台跑，期间先读全文。
//
//   node tools/podcast/speakers.mjs <节目目录> [--threshold 0.9] [--force]
//
// 产物：制作文件/说话人分段.json；全文里标上 A、B、C……；声音点名.mp3（每个编号约 10 秒原声）和 说话人.md（给主理人填"是谁"）。
// 主理人填好 说话人.md 后运行 node tools/podcast/fulltext.mjs <节目目录>，把称呼换进全文。
//
// 阈值：越大分出的人越少。2026-11-17 用十来个人的线下录音试过：0.5 碎成几百个，固定人数 3 或 4 会塌成两个人，
// 0.9 最好（主要的人都稳定，同一人偶尔被拆成两个编号）。总时长不到 40 秒的编号当成插话碎片，并进相邻的人。

import fs from 'node:fs';
import path from 'node:path';
import { relaunchOnMac, loadSherpa, needPodcastModels, pmPath, threads, episode, mustExist, readJson, writeJson, ff, fmt, RATE } from '../lib/podcast.mjs';
import { buildFull, readNames, speakerLabels } from './fulltext.mjs';

relaunchOnMac();
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--threshold');
if (!dir) { console.error('用法: node tools/podcast/speakers.mjs <节目目录> [--threshold 0.9] [--force]'); process.exit(2); }
mustExist(dir);
const e = episode(dir);
const threshold = Number(opt('--threshold', 0.9));

try {
  if (!fs.existsSync(e.wav16) || !fs.existsSync(e.asr)) throw new Error('先运行 node tools/podcast/transcribe.mjs <节目目录>');
  const hadNames = Object.keys(readNames(e)).length;
  if (args.includes('--force') || !fs.existsSync(e.diar)) {
    needPodcastModels(['seg', 'emb']);
    const sherpa = loadSherpa();
    console.log(`分说话人（阈值 ${threshold}）……长录音要几分钟到十几分钟。`);
    const t0 = Date.now();
    const sd = new sherpa.OfflineSpeakerDiarization({
      segmentation: { pyannote: { model: pmPath('seg') }, numThreads: threads(), provider: 'cpu', debug: 0 },
      embedding: { model: pmPath('emb'), numThreads: threads(), provider: 'cpu', debug: 0 },
      clustering: { numClusters: -1, threshold }, minDurationOn: 0.3, minDurationOff: 0.5,
    });
    const segs = sd.process(sherpa.readWave(e.wav16, false).samples).map((s) => ({ start: +s.start.toFixed(2), end: +s.end.toFixed(2), speaker: s.speaker }));
    writeJson(e.diar, segs, 0);
    console.log(`分说话人完成，用了 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
    if (hadNames) console.log('注意：重新分了说话人，编号可能变了。说话人.md 里原来填的称呼要对着新的声音点名重新核对。');
  }
  const { label, total, fragments } = speakerLabels(readJson(e.diar));
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
  const names = readNames(e);
  const rows = [], inputs = [];
  let at = 0;
  for (const [k, lab] of order) {
    const best = turns.filter((t) => t.speaker === lab).sort((p, q) => (q.end - q.start) - (p.end - p.start))[0];
    if (!best) continue;
    const dur = Math.min(10, best.end - best.start + 0.2);
    inputs.push({ ss: Math.max(0, best.start - 0.1), dur });
    rows.push(`| ${fmt(at)} | ${lab} | ${(total[k] / 60).toFixed(1)} 分钟 | ${fmt(best.start)} | ${best.text.slice(0, 24).replace(/\|/g, '｜')}…… | ${names[lab] ?? ''} |`);
    at += dur + 1.2;
  }
  const filt = inputs.map((x, i) => `[${i}:a]aresample=${RATE},aformat=channel_layouts=stereo,afade=t=in:d=0.1,apad=pad_dur=1.2[a${i}]`).join(';')
    + `;${inputs.map((_, i) => `[a${i}]`).join('')}concat=n=${inputs.length}:v=0:a=1,loudnorm=I=-18[o]`;
  ff(['-v', 'error', ...inputs.flatMap((x) => ['-ss', x.ss.toFixed(2), '-t', x.dur.toFixed(2), '-i', e.wav44]), '-filter_complex', filt, '-map', '[o]', '-c:a', 'libmp3lame', '-b:a', '128k', e.rollcall], '声音点名');
  fs.writeFileSync(e.names, `# 说话人

机器分出了 ${rows.length} 个说话人编号（另有 ${fragments} 个插话碎片已并入相邻的人）。\`声音点名.mp3\` 按下表顺序每个编号放约 10 秒原声，请主理人听一遍，在"是谁"一栏填称呼。
同一个人被拆成了两个编号的，两行填同一个称呼。认不出来的空着。填完运行 \`node tools/podcast/fulltext.mjs <节目目录>\`，称呼会换进全文。

| 点名音频里 | 编号 | 说了多久 | 这段原声在原录音 | 开头的话 | 是谁 |
|---|---|---|---|---|---|
${rows.join('\n')}
`, 'utf8');
  console.log(`${rows.length} 个说话人编号，${fragments} 个碎片并入相邻的人。声音点名.mp3（${fmt(at)}）和 说话人.md 已写好，全文已标上编号。`);
  console.log('下一步：请主理人听 声音点名.mp3、在 说话人.md 填称呼（可以晚点做，不挡编排）。');
} catch (err) { console.error(err.message); process.exit(1); }
