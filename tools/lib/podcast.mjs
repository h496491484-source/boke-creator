// 播客精编几个工具共用的东西：节目目录里的文件位置、模型、识别程序、ffmpeg、节目信息。
//
// 一期节目一个文件夹（下文 <节目>）：
//   原始录音（一个或几个音频文件，放在第一层）      节目信息.md     说话人.md     声音点名.mp3
//   全文.txt / 全文.json     编排方案.json → 编排方案.md     处理前后对比/     精编版/     状态.json
//   制作文件/   中间文件（转好的 wav、识别结果、分说话人结果、段响度），删了会重建

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT, loadConfig, findFfmpeg, ffBin } from './env.mjs';
import { findSherpa, findModel } from '../asr.mjs';

export { ROOT };
export const RATE16 = 16000;
export const RATE = 44100;
export const PM_DIR = path.join(ROOT, 'models', 'podcast');
export const MUSIC = path.join(ROOT, 'template', '配乐', 'aurora_cc0.mp3');

// 播客精编额外要的三个模型（sherpa-onnx 项目转换发布的 onnx 文件），下载后按大小和 sha256 核对
const GH = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const HF = 'https://hf-mirror.com/csukuangfj';
export const PODCAST_MODELS = {
  vad: {
    file: 'silero_vad.onnx', bytes: 643854, sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
    what: '人声检测（Silero VAD，MIT）', urls: [`${GH}/asr-models/silero_vad.onnx`, `${HF}/vad/resolve/main/silero_vad.onnx`],
  },
  seg: {
    file: 'pyannote-segmentation-3-0.onnx', bytes: 5992913, sha256: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079',
    what: '说话人切分（pyannote segmentation 3.0，MIT）',
    urls: [{ archive: `${GH}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`, member: 'model.onnx' }, `${HF}/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx`],
  },
  emb: {
    file: '3dspeaker-eres2net-base-zh.onnx', bytes: 39593761, sha256: '1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b',
    what: '声纹（3D-Speaker ERes2Net base 中文，Apache-2.0）',
    urls: [`${GH}/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`, `${HF}/speaker-embedding-models/resolve/main/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`],
  },
};
export const pmPath = (key) => path.join(PM_DIR, PODCAST_MODELS[key].file);
export const pmReady = (key) => { try { return fs.statSync(pmPath(key)).size === PODCAST_MODELS[key].bytes; } catch { return false; } };
export const podcastModelsReady = () => Object.keys(PODCAST_MODELS).every(pmReady);

// ---- 识别程序 ----
// Mac 上要先告诉系统动态库在哪，再重新启动自己一次（和 asr.mjs 一样，没在 Mac 上试过）
export function relaunchOnMac() {
  if (process.platform !== 'darwin' || process.env.BOKE_ASR_CHILD) return;
  const s = findSherpa();
  const lib = s.ok ? path.join(s.dir, 'node_modules', `sherpa-onnx-darwin-${process.arch}`) : '';
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, BOKE_ASR_CHILD: '1', DYLD_LIBRARY_PATH: [lib, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':') } });
  process.exit(r.status ?? 1);
}
export function loadSherpa() {
  const s = findSherpa();
  if (!s.ok) throw new Error('没找到识别程序 sherpa-onnx-node。先运行 node tools/setup.mjs。');
  return createRequire(path.join(s.dir, 'x.js'))('sherpa-onnx-node');
}
export function asrModel() {
  const m = findModel();
  if (!m.ok) throw new Error('没找到识别模型（SenseVoice）。先运行 node tools/setup.mjs。');
  return m;
}
export function needPodcastModels(keys = Object.keys(PODCAST_MODELS)) {
  const miss = keys.filter((k) => !pmReady(k));
  if (miss.length) throw new Error(`缺播客用的模型：${miss.map((k) => PODCAST_MODELS[k].what).join('、')}。运行 node tools/setup.mjs 补上。`);
}
export const threads = () => Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2)));

// ---- ffmpeg ----
let ffCache = null;
export function ffmpeg() {
  ffCache ??= findFfmpeg(loadConfig());
  if (!ffCache.ok) throw new Error('没找到能用的 ffmpeg。先运行 node tools/setup.mjs。');
  return { ff: ffBin(ffCache, 'ffmpeg'), fp: ffBin(ffCache, 'ffprobe') };
}
// 跑 ffmpeg，失败抛错（带最后一段报错）；返回 stderr（loudnorm 之类的测量结果在里面）
export function ff(args, label) {
  const r = spawnSync(ffmpeg().ff, ['-hide_banner', '-y', ...args.map(String)], { encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true });
  if (r.status !== 0) throw new Error(`${label}失败：${(r.stderr || r.error?.message || '').slice(-1200)}`);
  return r.stderr;
}
export function duration(file) {
  const r = spawnSync(ffmpeg().fp, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8', windowsHide: true });
  return Number(r.stdout.trim()) || 0;
}
// 整体响度 / 真峰值 / 响度范围（ebur128）
export function measure(file, { ss, t } = {}) {
  const pre = ss != null ? ['-ss', ss, '-t', t] : [];
  const o = ff(['-nostats', ...pre, '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], '响度测量');
  const last = (re) => { const m = [...o.matchAll(re)]; return m.length ? Number(m.at(-1)[1]) : null; };
  return { lufs: last(/I:\s+(-?[\d.]+) LUFS/g), lra: last(/LRA:\s+([\d.]+) LU/g), peak: last(/Peak:\s+(-?[\d.]+|-inf) dBFS/g) };
}

// ---- 节目目录 ----
export const AUDIO = /\.(m4a|mp3|aac|flac|ogg|opus|wma|amr|wav)$/i;
export function episode(dir) {
  const work = path.resolve(dir);
  const mid = path.join(work, '制作文件');
  const j = (...p) => path.join(work, ...p);
  return {
    work, mid,
    info: j('节目信息.md'), names: j('说话人.md'), rollcall: j('声音点名.mp3'),
    full: j('全文.json'), fullTxt: j('全文.txt'), plan: j('编排方案.json'), planMd: j('编排方案.md'),
    compare: j('处理前后对比'), out: j('精编版'), state: j('状态.json'),
    wav44: path.join(mid, '原始_44k.wav'), wav44dn: path.join(mid, '原始_44k_降噪.wav'), wav16: path.join(mid, '16k.wav'),
    asr: path.join(mid, '识别.json'), diar: path.join(mid, '说话人分段.json'), levels: path.join(mid, '段响度.json'),
  };
}
export function mustExist(dir) {
  if (!fs.existsSync(dir)) { console.error(`没有这个目录：${dir}。新节目先运行 node tools/podcast/new.mjs <节目目录> <录音文件>`); process.exit(1); }
}
export const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
export const writeJson = (f, v, indent = 1) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, indent) + '\n', 'utf8'); };
export const sha = (data) => crypto.createHash('sha1').update(data).digest('hex').slice(0, 12);
export const fileSha = (f) => (fs.existsSync(f) ? sha(fs.readFileSync(f)) : null);

// 节目信息.md 里 "- 字段：值" 的行
export function readInfo(e) {
  const out = {};
  if (!fs.existsSync(e.info)) return out;
  for (const m of fs.readFileSync(e.info, 'utf8').matchAll(/^- ([^：:\n]+)[：:][ \t]*(.*)$/gm)) out[m[1].trim()] = m[2].trim();
  return out;
}
export const infoBlank = (v) => !v || /^（.*）$/.test(v);

// 原始录音：第一层的音频文件；有几个时按 节目信息.md 的"录音顺序"，没写就按文件名
export function recordings(e) {
  const files = fs.readdirSync(e.work).filter((n) => AUDIO.test(n) && n !== path.basename(e.rollcall));
  const order = readInfo(e)['录音顺序'];
  if (files.length > 1 && !infoBlank(order)) {
    const names = order.split(/[、,，\s]+/).filter(Boolean);
    const picked = names.map((n) => files.find((f) => f === n || path.parse(f).name === n)).filter(Boolean);
    if (picked.length === files.length) return picked.map((n) => path.join(e.work, n));
  }
  return files.sort((a, b) => a.localeCompare(b, 'zh')).map((n) => path.join(e.work, n));
}

// ---- 全文 ----
export const PUNCT = /^[，。！？、；：,.!?;:]$/;
export const fmt = (s) => { s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60); return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; };
export const mins = (s) => `${(s / 60).toFixed(1)} 分钟`;
export function loadFull(e) {
  const full = readJson(e.full, null);
  if (!full) throw new Error('还没有 全文.json。先运行 node tools/podcast/transcribe.mjs <节目目录>');
  return full;
}
// 在一句话的逐字时间里找一段原文，返回第一个和最后一个字的序号
export function findInSentence(s, text) {
  let joined = ''; const map = [];
  s.toks.forEach((t, k) => { for (const _ of t.t) map.push(k); joined += t.t; });
  const at = joined.indexOf(text);
  if (at < 0) return null;
  return { first: map[at], last: map[at + text.length - 1] };
}
