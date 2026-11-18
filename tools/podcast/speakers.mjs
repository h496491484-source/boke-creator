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
import { relaunchOnMac, loadSherpa, needPodcastModels, pmPath, threads, episode, mustExist, readJson, writeJson, ff, fmt, RATE, trackWav, fileMap, lookupFile } from '../lib/podcast.mjs';
import { buildFull, readNames, speakerLabels, diarSource } from './fulltext.mjs';

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
      segmentation: { pyannote: { model: pmPath('seg') }, numThreads: threads(), provider: 'cpu', debug: 0 },
      embedding: { model: pmPath('emb'), numThreads: threads(), provider: 'cpu', debug: 0 },
      clustering: { numClusters: -1, threshold }, minDurationOn: 0.3, minDurationOff: 0.5,
    });
    const segs = sd.process(sherpa.readWave(e.wav16, false).samples).map((s) => ({ start: +s.start.toFixed(2), end: +s.end.toFixed(2), speaker: s.speaker }));
    writeJson(e.diar, segs, 0);
    console.log(`分说话人完成，用了 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
    if (hadNames) console.log('注意：重新分了说话人，编号可能变了。说话人.md 里原来填的称呼要对着新的声音点名重新核对。');
  }
  const src = diarSource(e);
  const { label, total, fragments } = speakerLabels(readJson(e.diar), src.source === 'tracks' ? 3 : undefined);
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
    const name = names[lab] ?? (src.source === 'tracks' ? src.names?.[k] : '') ?? '';
    rows.push(`| ${fmt(at)} | ${lab} | ${(total[k] / 60).toFixed(1)} 分钟 | ${fmt(best.start)} | ${best.text.slice(0, 24).replace(/\|/g, '｜')}…… | ${name} |`);
    at += dur + 1.2;
  }
  const filt = inputs.map((x, i) => `[${i}:a]aresample=${RATE},aformat=channel_layouts=stereo,afade=t=in:d=0.1,apad=pad_dur=1.2[a${i}]`).join(';')
    + `;${inputs.map((_, i) => `[a${i}]`).join('')}concat=n=${inputs.length}:v=0:a=1,loudnorm=I=-18[o]`;
  ff(['-v', 'error', ...inputs.flatMap((x) => ['-ss', x.ss.toFixed(2), '-t', x.dur.toFixed(2), '-i', e.wav44]), '-filter_complex', filt, '-map', '[o]', '-c:a', 'libmp3lame', '-b:a', '128k', e.rollcall], '声音点名');
  fs.writeFileSync(e.names, `# 说话人

${src.source === 'tracks' ? `多轨录音，按音轨认人：一条音轨就是一个人，共 ${rows.length} 条有人说话。称呼按 节目信息.md 的"音轨对应"预填，请核对。` : `机器分出了 ${rows.length} 个说话人编号（另有 ${fragments} 个插话碎片已并入相邻的人）。`}\`声音点名.mp3\` 按下表顺序每个编号放约 10 秒原声，请主理人听一遍，在"是谁"一栏填称呼。
同一个人被拆成了两个编号的，两行填同一个称呼。认不出来的空着。填完运行 \`node tools/podcast/fulltext.mjs <节目目录>\`，称呼会换进全文。

| 点名音频里 | 编号 | 说了多久 | 这段原声在原录音 | 开头的话 | 是谁 |
|---|---|---|---|---|---|
${rows.join('\n')}
`, 'utf8');
  if (Object.keys(readNames(e)).length) buildFull(dir); // 称呼（手填的，或多轨按音轨对应自动填的）换进全文
  if (src.source === 'tracks') {
    console.log(`${rows.length} 条音轨有人说话，已按音轨标好说话人${Object.keys(readNames(e)).length ? '，称呼按 节目信息.md 的"音轨对应"填好了' : '（节目信息.md 的"音轨对应"没填，称呼空着）'}。声音点名.mp3 和 说话人.md 已写好。`);
    console.log('下一步：请主理人听一下 声音点名.mp3，核对 说话人.md 的称呼，没问题就确认"认人"。');
  } else {
    console.log(`${rows.length} 个说话人编号，${fragments} 个碎片并入相邻的人。声音点名.mp3（${fmt(at)}）和 说话人.md 已写好，全文已标上编号。`);
    console.log('下一步：请主理人听 声音点名.mp3、在 说话人.md 填称呼（可以晚点做，不挡编排）。');
  }
} catch (err) { console.error(err.message); process.exit(1); }
