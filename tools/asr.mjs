#!/usr/bin/env node
// 本地识别：把录音认成"每个字带时间"的结果，给 align.mjs 用。只用 CPU，不要 Python，不联网。
//
//   node tools/asr.mjs <作品目录 | 音频文件> [--out 识别结果.json] [--whole]
//
// 用的是 sherpa-onnx（npm 包 sherpa-onnx-node）和 SenseVoice 模型。位置的查找顺序：
//   程序：环境变量 SHERPA_ONNX_DIR → boke-creator.local.json 的 sherpaDir → 技能目录（npm install 装的）
//   模型：环境变量 ASR_MODEL_DIR  → boke-creator.local.json 的 asrModelDir → 技能目录 models/sense-voice
// 识别结果只用来取时间，文字以稿子为准，所以认错同音字没关系。
// 100 秒以内整段识别；更长的先在停顿处切成 30–60 秒的小段（--whole 强制整段）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, loadConfig, findFfmpeg, ffBin } from './lib/env.mjs';

const RATE = 16000;
const WHOLE_UP_TO = 100;              // 不超过这么长就整段识别（实测 71 秒整段没问题，4.5 秒认完）
const CHUNK = { min: 30, max: 60 };   // 更长的录音，每段的长度范围（秒）
const MAX_CHAR = 0.35;                // 一个字最长算多久（模型只给起始时间）

export function findSherpa(cfg = loadConfig()) {
  const dirs = [process.env.SHERPA_ONNX_DIR, cfg.sherpaDir, ROOT].filter(Boolean);
  for (const d of dirs) {
    const pkg = path.join(d, 'node_modules', 'sherpa-onnx-node');
    if (fs.existsSync(path.join(pkg, 'package.json'))) return { ok: true, dir: d, pkg };
  }
  return { ok: false };
}
export function findModel(cfg = loadConfig()) {
  const dirs = [process.env.ASR_MODEL_DIR, cfg.asrModelDir, path.join(ROOT, 'models', 'sense-voice')].filter(Boolean);
  for (const d of dirs) {
    if (!fs.existsSync(path.join(d, 'tokens.txt'))) continue;
    const model = ['model.int8.onnx', 'model.onnx'].map((f) => path.join(d, f)).find((f) => fs.existsSync(f));
    if (model) return { ok: true, dir: d, model, tokens: path.join(d, 'tokens.txt') };
  }
  return { ok: false };
}

// 在停顿处找切点：把声音按 20 毫秒一格算音量，在 [min, max] 秒的范围里挑最长的一段安静，切在它中间
function cutPoints(samples) {
  const hop = RATE * 0.02, n = Math.floor(samples.length / hop);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = i * hop; k < (i + 1) * hop; k++) s += samples[k] * samples[k]; rms[i] = Math.sqrt(s / hop); }
  const sorted = Float32Array.from(rms).sort();
  const quiet = Math.max(sorted[Math.floor(n * 0.9)] * 0.08, 1e-4); // 比"响的时候"低很多就算安静
  const cuts = [];
  let start = 0;
  while ((n - start) * 0.02 > CHUNK.max) {
    const lo = start + CHUNK.min / 0.02, hi = start + CHUNK.max / 0.02;
    let best = null, run = null;
    for (let i = lo; i <= hi; i++) {
      if (rms[i] < quiet) { run = run ?? i; if (!best || i - run > best.len) best = { at: Math.floor((run + i) / 2), len: i - run }; }
      else run = null;
    }
    if (!best) { let m = lo; for (let i = lo; i <= hi; i++) if (rms[i] < rms[m]) m = i; best = { at: m }; } // 没有停顿就切在最轻的地方
    cuts.push(best.at * hop);
    start = best.at;
  }
  return cuts;
}

export function recognize(audioFile, { whole = false, tmpDir } = {}) {
  const sherpaAt = findSherpa(), modelAt = findModel(), ffmpeg = findFfmpeg();
  if (!sherpaAt.ok) throw new Error('没找到识别程序 sherpa-onnx-node。先运行 node tools/setup.mjs。');
  if (!modelAt.ok) throw new Error('没找到识别模型（SenseVoice）。先运行 node tools/setup.mjs。');
  if (!ffmpeg.ok) throw new Error('没找到 ffmpeg。先运行 node tools/setup.mjs。');
  // Mac 上要让系统找得到同目录的动态库；Windows 不需要
  const sherpa = createRequire(path.join(sherpaAt.dir, 'x.js'))('sherpa-onnx-node');

  // 统一转成 16k 单声道 wav（手机录音多半是 m4a、44.1k）
  fs.mkdirSync(tmpDir, { recursive: true });
  const wav16 = path.join(tmpDir, 'asr-16k.wav');
  const r = spawnSync(ffBin(ffmpeg, 'ffmpeg'), ['-y', '-v', 'error', '-i', audioFile, '-ar', String(RATE), '-ac', '1', '-c:a', 'pcm_s16le', wav16], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`音频转换失败：${(r.stderr || r.error?.message || '').trim()}`);
  const wave = sherpa.readWave(wav16, false);
  const samples = wave.samples, seconds = samples.length / RATE;

  const t0 = Date.now();
  const rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: modelAt.model, language: 'zh', useInverseTextNormalization: 0 }, // 不转写数字和标点：要的是"怎么读的"
      tokens: modelAt.tokens, numThreads: 2, provider: 'cpu', debug: 0,
    },
  });
  const bounds = [0, ...(whole || seconds <= WHOLE_UP_TO ? [] : cutPoints(samples)), samples.length];
  const out = [];
  for (let c = 0; c + 1 < bounds.length; c++) {
    const from = bounds[c], to = bounds[c + 1], offset = from / RATE, limit = to / RATE;
    const stream = rec.createStream();
    stream.acceptWaveform({ sampleRate: RATE, samples: samples.subarray(from, to) });
    rec.decode(stream);
    const res = rec.getResult(stream);
    const toks = (res.tokens ?? []).map((t, i) => ({ text: String(t).replace(/▁/g, ''), start: offset + res.timestamps[i] }))
      .filter((t) => t.text && !/^<\|.*\|>$/.test(t.text));
    toks.forEach((t, i) => {
      const next = i + 1 < toks.length ? toks[i + 1].start : limit;
      out.push({ start: +t.start.toFixed(3), end: +Math.min(next, t.start + MAX_CHAR, limit).toFixed(3), text: t.text });
    });
  }
  fs.rmSync(wav16, { force: true });
  return { words: out, seconds: +seconds.toFixed(2), chunks: bounds.length - 1, spent: +((Date.now() - t0) / 1000).toFixed(1), model: path.basename(modelAt.dir) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  if (!target) { console.error('用法: node tools/asr.mjs <作品目录 | 音频文件> [--out 识别结果.json] [--whole]'); process.exit(2); }
  // Mac 要先告诉系统动态库在哪，再重新启动自己一次（没在 Mac 上试过）
  if (process.platform === 'darwin' && !process.env.BOKE_ASR_CHILD) {
    const s = findSherpa();
    const lib = s.ok ? path.join(s.dir, 'node_modules', `sherpa-onnx-darwin-${process.arch}`) : '';
    const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, BOKE_ASR_CHILD: '1', DYLD_LIBRARY_PATH: [lib, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':') } });
    process.exit(r.status ?? 1);
  }
  const isDir = fs.statSync(target).isDirectory();
  const work = isDir ? path.resolve(target) : path.dirname(path.resolve(target));
  const audio = isDir ? path.join(work, 'voice.wav') : path.resolve(target);
  if (!fs.existsSync(audio)) { console.error(`找不到音频 ${audio}`); process.exit(1); }
  try {
    // 临时文件：给的是作品目录就放它的 制作文件/，给的是单个音频就放系统临时目录，不往别人的文件夹里建东西
    const tmpDir = isDir ? path.join(work, '制作文件') : fs.mkdtempSync(path.join(os.tmpdir(), 'boke-asr-'));
    const r = recognize(audio, { whole: args.includes('--whole'), tmpDir });
    if (!isDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    const out = opt('--out') ? path.resolve(opt('--out')) : path.join(work, '识别结果.json');
    fs.writeFileSync(out, JSON.stringify(r.words) + '\n', 'utf8');
    console.log(`识别完成：录音 ${r.seconds} 秒，分 ${r.chunks} 段，认出 ${r.words.length} 个字，用了 ${r.spent} 秒。结果写到 ${out}`);
    console.log(`认出的文字（只用来取时间，文字以稿子为准）：${r.words.map((w) => w.text).join('')}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
