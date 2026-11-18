#!/usr/bin/env node
// 按 编排方案.json 剪精编版：取段 → 按逐字时间修边界 → 缩短长停顿、去掉段首"呃嗯" → 人声处理 → 片头/过渡/片尾配乐 → 统一响度。
//
//   node tools/podcast/build.mjs <节目目录>             出精编版（人声处理按方案里的 voice，默认处理）
//   node tools/podcast/build.mjs <节目目录> --compare   先出"处理前后对比"：自动挑两处音量差最大的 30 秒，处理前、处理后各一份
//
// 产物：精编版/（精编版.mp3、剪辑表.json、章节目录.txt），或 处理前后对比/。
// 人声处理（2026-11-17 用真实节目调过，见 references/播客_人声处理.md）：
//   ① 分人调平：每个识别段往全期中位响度拉 80%，最多 +8 / -5 dB，句间空隙取两边较小的增益（不把底噪拉上来），先整体让 9 dB 余量防削顶；
//   ② 低切 80Hz + 轻度降噪（afftdn nr=8）；③ 轻度压缩 2.5:1。最后人声和成品都调到 -16 LUFS（两遍法，线性）。

import fs from 'node:fs';
import path from 'node:path';
import { episode, mustExist, loadFull, readJson, writeJson, ff, measure, fmt, fileSha, MUSIC, RATE, PUNCT, findInSentence } from '../lib/podcast.mjs';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) { console.error('用法: node tools/podcast/build.mjs <节目目录> [--compare]'); process.exit(2); }
mustExist(dir);
const e = episode(dir);
const CH = 2, BPS = 4;
const GAP = { hookLead: 2.0, betweenQuotes: 0.7, afterHook: 2.5, section: 3.0, tail: 11 };
const LONG_PAUSE = 0.9, PAD = { tail: 0.35, head: 0.25, edge: 0.2 }, FADE = 0.015;
const FILLER = /^[呃嗯]$/;
const PROC = { headroom: 9, gainMax: 8, cutMax: 5, amount: 0.8, ramp: 0.08, denoise: 'highpass=f=80,afftdn=nr=8:nf=-60:tn=1', comp: 'acompressor=threshold=-20dB:ratio=2.5:attack=10:release=180:knee=4' };
const MUSIC_GAIN_DB = 2; // 配乐原曲约 -22 LUFS，单独响时到 -20 左右，比人声轻一点

const full = loadFull(e);
const plan = readJson(e.plan, null);
if (!plan) { console.error('还没有 编排方案.json'); process.exit(1); }
if (!fs.existsSync(e.planMd) || fs.statSync(e.planMd).mtimeMs < fs.statSync(e.plan).mtimeMs) { console.error('编排方案.json 改过之后还没检查。先运行 node tools/podcast/plan.mjs <节目目录>'); process.exit(1); }
if (!fs.existsSync(e.wav44)) { console.error('制作文件里没有转好的录音。先运行 node tools/podcast/transcribe.mjs <节目目录>'); process.exit(1); }
const byId = new Map(full.map((s) => [s.id, s]));
const prevEnd = (id) => byId.get(id - 1)?.end ?? 0;
const nextStart = (id) => byId.get(id + 1)?.start ?? Infinity;

// ---------- 方案 → 说话片段（span）→ 剪辑段（clip） ----------
function partSpans(p) {
  const spans = [];
  for (let id = p.from; id <= p.to; id++) {
    const s = byId.get(id);
    const words = s.toks.filter((t) => !PUNCT.test(t.t));
    if (p.from !== p.to && words.length && words.every((t) => FILLER.test(t.t) || t.t === '啊')) continue; // 整句只有"嗯""呃"
    spans.push({ id, s: s.start, e: s.end, hardStart: false, hardEnd: false });
  }
  const first = spans[0], last = spans.at(-1);
  if (p.startText) { const s = byId.get(first.id), m = findInSentence(s, p.startText); first.s = s.toks[m.first].s - 0.08; first.hardStart = true; }
  if (p.endText) {
    const s = byId.get(last.id), m = findInSentence(s, p.endText);
    const next = s.toks.slice(m.last + 1).find((t) => !PUNCT.test(t.t));
    last.e = next ? Math.min(next.s - 0.01, s.toks[m.last].s + 0.55) : s.end;
    last.hardEnd = true;
  }
  return spans;
}
function skipLeadingFiller(sp) {
  if (sp.hardStart) return;
  const toks = byId.get(sp.id).toks;
  if (!toks.length || !FILLER.test(toks[0].t)) return;
  const real = toks.find((t) => !FILLER.test(t.t) && !PUNCT.test(t.t));
  if (real && real.s - sp.s < 3) { sp.s = real.s - 0.06; sp.hardStart = true; }
}
function clipsOf(spans) {
  const clips = [];
  let cur = null, prev = null;
  for (const sp of spans) {
    if (prev && !prev.hardEnd && !sp.hardStart && sp.id === prev.id + 1 && sp.s - prev.e <= LONG_PAUSE) { cur.to = sp.e; cur.lastId = sp.id; cur.hardEnd = sp.hardEnd; prev = sp; continue; }
    if (cur) clips.push(cur);
    skipLeadingFiller(sp);
    const pad = prev ? PAD.head : PAD.edge;
    cur = { from: sp.hardStart ? sp.s : Math.max(sp.s - pad, prevEnd(sp.id) + 0.03), to: sp.e, firstId: sp.id, lastId: sp.id, hardEnd: sp.hardEnd };
    prev = sp;
  }
  clips.push(cur);
  clips.forEach((c, k) => { if (!c.hardEnd) c.to = Math.min(c.to + (k + 1 < clips.length ? PAD.tail : PAD.edge + 0.1), nextStart(c.lastId) - 0.03); });
  return clips;
}

const timeline = [];
const hookSecs = plan.sections.filter((s) => s.kind === 'hook');
for (const sec of hookSecs) {
  timeline.push({ kind: 'gap', dur: GAP.hookLead, section: sec.name });
  sec.parts.forEach((p, k) => {
    if (k) timeline.push({ kind: 'gap', dur: GAP.betweenQuotes, section: sec.name });
    for (const c of clipsOf(partSpans(p))) timeline.push({ kind: 'clip', ...c, section: sec.name, label: p.label });
  });
  timeline.push({ kind: 'gap', dur: GAP.afterHook, section: sec.name, music: 'swell' });
}
let firstBody = true;
for (const sec of plan.sections) {
  if (sec.kind === 'hook') continue;
  if (!firstBody) timeline.push({ kind: 'gap', dur: GAP.section, section: sec.name, music: 'transition' });
  firstBody = false;
  const spans = sec.parts.flatMap((p) => partSpans(p).map((sp) => ({ ...sp, label: p.label })));
  for (const c of clipsOf(spans)) timeline.push({ kind: 'clip', ...c, section: sec.name, label: spans.find((s) => s.id === c.firstId)?.label });
}

// ---------- 渲染一版 ----------
function render(processed, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  // 先删掉旧成品：剪到一半失败时不留旧文件，免得后面的检查查到旧的还说通过
  for (const f of ['精编版.mp3', '剪辑表.json', '章节目录.txt', '检查报告.json', '节目简介.md']) fs.rmSync(path.join(outDir, f), { force: true });
  let src = e.wav44;
  if (processed) {
    if (!fs.existsSync(e.wav44dn) || fs.statSync(e.wav44dn).mtimeMs < fs.statSync(e.wav44).mtimeMs) ff(['-v', 'error', '-i', e.wav44, '-af', PROC.denoise, '-c:a', 'pcm_s16le', e.wav44dn], '低切降噪');
    src = e.wav44dn;
  }
  const fd = fs.openSync(src, 'r');
  const hdr = Buffer.alloc(4096); fs.readSync(fd, hdr, 0, 4096, 0);
  let dataOff = 12; while (hdr.toString('ascii', dataOff, dataOff + 4) !== 'data') dataOff += 8 + hdr.readUInt32LE(dataOff + 4);
  dataOff += 8;

  // 分人调平的增益包络（原录音时间轴，每 10ms 一个 dB 值）
  let env = null;
  if (processed) {
    const lv = readJson(e.levels, null);
    if (!lv) throw new Error('没有 段响度.json，先运行 transcribe.mjs');
    const g = lv.segs.map((s) => (s.db < -90 ? 0 : Math.max(-PROC.cutMax, Math.min(PROC.gainMax, (lv.median - s.db) * PROC.amount))));
    const total = Math.ceil(lv.segs.at(-1).end + 5) * 100;
    env = new Float32Array(total);
    const put = (t0, t1, v0, v1) => { const a = Math.max(0, Math.round(t0 * 100)), b = Math.min(total, Math.round(t1 * 100)); for (let k = a; k < b; k++) env[k] = b - a > 1 ? v0 + (v1 - v0) * (k - a) / (b - a - 1) : v1; };
    put(0, lv.segs[0].start, g[0], g[0]);
    lv.segs.forEach((s, i) => {
      put(s.start, s.end, g[i], g[i]);
      const s2 = lv.segs[i + 1]?.start ?? total / 100, g2 = g[i + 1] ?? g[i];
      if (s2 - s.end < 2 * PROC.ramp) { put(s.end, s2, g[i], g2); return; }
      const quiet = Math.min(g[i], g2);
      put(s.end, s.end + PROC.ramp, g[i], quiet); put(s.end + PROC.ramp, s2 - PROC.ramp, quiet, quiet); put(s2 - PROC.ramp, s2, quiet, g2);
    });
  }

  const voiceRaw = path.join(outDir, 'voice.raw');
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
      t += n / RATE; continue;
    }
    const f0 = Math.round(item.from * RATE), n = Math.round(item.to * RATE) - f0;
    const buf = Buffer.alloc(n * BPS);
    fs.readSync(fd, buf, 0, n * BPS, dataOff + f0 * BPS);
    for (let k = 0; k < n; k++) {
      let gl = 1;
      if (env) { const x = (f0 + k) / RATE * 100, j = Math.min(Math.floor(x), env.length - 2), fr = x - j; gl = 10 ** ((env[j] * (1 - fr) + env[j + 1] * fr - PROC.headroom) / 20); }
      const fade = k < fadeN ? 0.5 - 0.5 * Math.cos(Math.PI * k / fadeN) : k >= n - fadeN ? 0.5 - 0.5 * Math.cos(Math.PI * (n - 1 - k) / fadeN) : 1;
      if (gl === 1 && fade === 1) continue;
      for (let c = 0; c < CH; c++) {
        const a = (k * CH + c) * 2;
        let v = Math.round(buf.readInt16LE(a) * gl * fade);
        if (v > 32767 || v < -32768) { clipped++; v = Math.max(-32768, Math.min(32767, v)); }
        buf.writeInt16LE(v, a);
      }
    }
    fs.writeSync(wfd, buf);
    edl.push({ kind: 'clip', section: item.section, label: item.label, ids: [item.firstId, item.lastId], src: [+item.from.toFixed(3), +item.to.toFixed(3)], out: [+t.toFixed(3), +(t + n / RATE).toFixed(3)] });
    t += n / RATE;
  }
  const voiceEnd = t;
  fs.writeSync(wfd, Buffer.alloc(Math.round(GAP.tail * RATE) * BPS)); // 片尾音乐的位置（压低音乐那一步在人声结束时会截断，所以补静音）
  fs.closeSync(wfd); fs.closeSync(fd);

  const loudnorm = (input, output, pre = '') => {
    const p = pre ? `${pre},` : '';
    const inA = ['-f', 's16le', '-ar', RATE, '-ac', CH, '-i', input]; // 原始 PCM 不带声道布局：滤镜末尾显式写 stereo（ffmpeg 6.0 不会自己猜，9.0 会）
    const m = ff([...inA, '-af', `${p}loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-'], '响度测量');
    const j = JSON.parse(m.slice(m.lastIndexOf('{'), m.lastIndexOf('}') + 1));
    ff([...inA, '-af', `${p}loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true,aresample=${RATE},aformat=sample_fmts=s16:channel_layouts=stereo`, '-c:a', 'pcm_s16le', output], '响度调整');
    return j;
  };
  const voiceWav = path.join(outDir, 'voice_norm.wav');
  loudnorm(voiceRaw, voiceWav, processed ? PROC.comp : '');

  // 配乐：片头铺底、板块过渡、片尾；人声出现时自动压低
  const swell = edl.find((x) => x.kind === 'swell');
  const pieces = [
    ...(swell ? [{ at: 0, from: 0, dur: swell.at + GAP.afterHook + 3.5, fin: 0.8, fout: 3.0 }] : []),
    ...edl.filter((x) => x.kind === 'transition').map((x, k) => ({ at: Math.max(0, x.at - 0.15), from: 12 + ((k * 9) % 55), dur: x.dur + 0.9, fin: 0.35, fout: 1.4 })),
    { at: voiceEnd - 2.5, from: 30, dur: 13, fin: 1.5, fout: 5 },
  ];
  const mixWav = path.join(outDir, 'mix.wav');
  if (plan.music !== false && fs.existsSync(MUSIC)) {
    const inputs = ['-i', voiceWav], filt = [];
    pieces.forEach((p, k) => {
      inputs.push('-stream_loop', '-1', '-i', MUSIC);
      filt.push(`[${k + 1}:a]atrim=start=${p.from.toFixed(2)}:duration=${p.dur.toFixed(2)},asetpts=PTS-STARTPTS,aresample=${RATE},aformat=channel_layouts=stereo,volume=${MUSIC_GAIN_DB}dB,afade=t=in:d=${p.fin},afade=t=out:st=${(p.dur - p.fout).toFixed(2)}:d=${p.fout},adelay=${Math.round(p.at * 1000)}:all=1[m${k}]`);
    });
    filt.push(`${pieces.map((_, k) => `[m${k}]`).join('')}amix=inputs=${pieces.length}:normalize=0:duration=longest[mus]`, '[0:a]asplit=2[v1][v2]',
      '[mus][v1]sidechaincompress=threshold=0.012:ratio=12:attack=20:release=450:makeup=1[duck]', '[v2][duck]amix=inputs=2:normalize=0:duration=longest[mix]');
    ff(['-v', 'error', ...inputs, '-filter_complex', filt.join(';'), '-map', '[mix]', '-c:a', 'pcm_s16le', mixWav], '混音');
  } else fs.copyFileSync(voiceWav, mixWav);

  const mixRaw = path.join(outDir, 'mix.raw'), finalWav = path.join(outDir, 'final.wav');
  ff(['-v', 'error', '-i', mixWav, '-f', 's16le', '-ar', RATE, '-ac', CH, mixRaw], '转格式');
  loudnorm(mixRaw, finalWav);
  const mp3 = path.join(outDir, '精编版.mp3');
  ff(['-v', 'error', '-i', finalWav, '-c:a', 'libmp3lame', '-b:a', '160k', '-id3v2_version', '3', '-metadata', `title=${plan.title ?? '精编版'}`, mp3], '出 mp3');
  for (const f of [voiceRaw, voiceWav, mixWav, mixRaw, finalWav]) fs.rmSync(f, { force: true });
  writeJson(path.join(outDir, '剪辑表.json'), { plan: fileSha(e.plan), processed, voiceEnd: +voiceEnd.toFixed(3), music: pieces, items: edl });
  fs.writeFileSync(path.join(outDir, '章节目录.txt'), chapters.map((c) => `${fmt(c.t)} ${c.name}`).join('\n') + '\n', 'utf8');
  return { mp3, edl, voiceEnd, clipped, chapters };
}

try {
  if (args.includes('--compare')) {
    console.log('出处理前、处理后两版（各要一两分钟）……');
    const A = render(false, path.join(e.mid, '对比_处理前'));
    const B = render(true, path.join(e.mid, '对比_处理后'));
    // 挑两处 30 秒：窗口里各段原始响度差得最多的地方
    const lv = readJson(e.levels);
    const clips = A.edl.filter((x) => x.kind === 'clip');
    const toOut = (t) => { const c = clips.find((c) => c.src[0] <= t && t <= c.src[1]); return c ? c.out[0] + t - c.src[0] : null; };
    const pts = lv.segs.filter((s) => s.end - s.start > 1 && s.db > -90).map((s) => ({ t: toOut((s.start + s.end) / 2), db: s.db })).filter((x) => x.t != null);
    const wins = [];
    for (let w = 0; w + 30 < A.voiceEnd; w += 5) { const xs = pts.filter((x) => x.t >= w && x.t < w + 30).map((x) => x.db); if (xs.length >= 3) wins.push({ w, spread: Math.max(...xs) - Math.min(...xs) }); }
    wins.sort((a, b) => b.spread - a.spread);
    const picks = [];
    for (const x of wins) if (picks.every((p) => Math.abs(p.w - x.w) >= 90)) { picks.push(x); if (picks.length === 2) break; }
    fs.mkdirSync(e.compare, { recursive: true });
    for (const [i, p] of picks.entries()) {
      const tag = `${i + 1}_${fmt(p.w).replace(/:/g, '分')}秒起`;
      const a = path.join(e.compare, `${tag}_A处理前.mp3`), b = path.join(e.compare, `${tag}_B处理后.mp3`);
      ff(['-v', 'error', '-ss', p.w, '-t', 30, '-i', A.mp3, '-c:a', 'libmp3lame', '-b:a', '160k', a], '切对比');
      ff(['-v', 'error', '-ss', p.w, '-t', 30, '-i', B.mp3, '-c:a', 'libmp3lame', '-b:a', '160k', b], '切对比');
      ff(['-v', 'error', '-i', a, '-f', 'lavfi', '-t', 1.5, '-i', `anullsrc=r=${RATE}:cl=stereo`, '-i', b, '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1', '-c:a', 'libmp3lame', '-b:a', '160k', path.join(e.compare, `${tag}_先A后B.mp3`)], '拼对比');
      const ma = measure(a), mb = measure(b);
      console.log(`  对比 ${i + 1}：成品 ${fmt(p.w)} 起 30 秒，这一段里各句响度差 ${p.spread.toFixed(1)} dB；音量起伏 处理前 ${ma.lra} LU → 处理后 ${mb.lra} LU`);
    }
    const wa = measure(A.mp3), wb = measure(B.mp3);
    console.log(`整期音量起伏：处理前 ${wa.lra} LU，处理后 ${wb.lra} LU。调平时削顶 ${B.clipped} 个采样点。`);
    console.log(`对比文件在 处理前后对比/。请本人听 ${picks.length} 个"先A后B"文件，`
      + '选处理还是不处理（编排方案.json 的 voice 写 "processed" 或 "raw"），再确认"声音"这一步。');
  } else {
    const processed = plan.voice !== 'raw';
    console.log(`剪精编版（${processed ? '带人声处理' : '不做人声处理'}）……`);
    const r = render(processed, e.out);
    const m = measure(r.mp3);
    console.log(`精编版：${fmt(r.voiceEnd + GAP.tail)}，${r.edl.filter((x) => x.kind === 'clip').length} 段，响度 ${m.lufs} LUFS，峰值 ${m.peak} dBFS，音量起伏 ${m.lra} LU${processed ? `，调平削顶 ${r.clipped} 个采样点` : ''}`);
    console.log(r.chapters.map((c) => `  ${fmt(c.t)} ${c.name}`).join('\n'));
    console.log('下一步：node tools/podcast/check.mjs <节目目录> 做机器检查，再 notes.mjs 出简介。');
  }
} catch (err) { console.error(err.message); process.exit(1); }
