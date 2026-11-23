#!/usr/bin/env node
// 下载识别模型（SenseVoice，int8，约 240 MB），放到技能目录 models/sense-voice。
//
//   node tools/get-model.mjs                   自动下载：先走国内（魔搭），不行换 hf-mirror、GitHub
//   node tools/get-model.mjs --official        先走官方源（GitHub、Hugging Face），国外网络用
//   node tools/get-model.mjs --file <压缩包>   用已经下载好的压缩包（比如老师用 U 盘发的 .tar.bz2）
//   node tools/get-model.mjs --dir <文件夹>    用已经解开的文件夹（里面有 model.int8.onnx 和 tokens.txt）
//   node tools/get-model.mjs --podcast [--official] [--dir <文件夹>]   播客精编用的三个小模型，放到 models/podcast
//   node tools/get-model.mjs --music           配乐曲库，放到 models/music
//   （--mirror 是旧写法，现在默认就是国内优先；--force 删掉重下）
//
// 下载用 lib/download.mjs：断点续传（中途断了再跑一次接着下）、卡住或太慢自动换源、几个文件同时下，
// 每个文件按大小和 sha256 核对。
//
// 模型来自 sherpa-onnx 项目转换的 SenseVoiceSmall（阿里 FunAudioLLM）。
// 许可：FunASR 模型开源协议 1.1，可以使用、复制、修改、分享，条件是注明来源和作者、保留模型名称。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, cmd } from './lib/env.mjs';
import { fetchFile, fetchAll, sha256File, mb } from './lib/download.mjs';

const NAME = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
const MODEL_BYTES = 239233841; // model.int8.onnx 的大小，下载完核对
const GH_ARCHIVE = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${NAME}.tar.bz2`;
const HF_BASE = 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main';
export const MODEL_DIR = path.join(ROOT, 'models', 'sense-voice');
const DL_DIR = path.join(ROOT, 'models', '.download'); // 压缩包下到这里（能接着下），解开后删掉
const SV_FILES = {
  'model.int8.onnx': { bytes: MODEL_BYTES, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
  'tokens.txt': { bytes: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' },
};

// 国内模型地址：放着全部模型文件的地方（<地址>/sense-voice/model.int8.onnx、<地址>/podcast/silero_vad.onnx ……）。
// 2026-11-18 起 hf-mirror.com 会跳转到 huggingface.co，国内不开代理下不了，GitHub 也常断，所以要有一个国内的地址。
// 来源（依次）：环境变量 BOKE_MODEL_MIRROR（逗号分隔可写几个）→ boke-creator.local.json 的 modelMirror → 下面内置的。
// 魔搭上的转存仓库（2026-11-18 建，原样转存，带来源和许可证说明）：https://modelscope.cn/models/jimmy444629/boke-creator-models
export const CN_MODEL_MIRRORS = ['https://modelscope.cn/models/jimmy444629/boke-creator-models/resolve/master'];
const clean = (list) => list.map((s) => String(s).trim().replace(/\/+$/, '')).filter(Boolean);
// 自己配的地址（环境变量、本机配置），任何时候都排最前
function userMirrors() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'boke-creator.local.json'), 'utf8')); } catch { /* 没有本机配置 */ }
  return clean([...(process.env.BOKE_MODEL_MIRROR ?? '').split(','), ...[cfg.modelMirror ?? []].flat()]);
}
export function modelMirrors() { return [...new Set([...userMirrors(), ...clean(CN_MODEL_MIRRORS)])]; }
// 来源排序：自己配的 → 国内（魔搭）→ 官方；official 时官方排在魔搭前面
function order(sub, officialUrls, official) {
  const mine = userMirrors().map((b) => `${b}/${sub}`);
  const cn = clean(CN_MODEL_MIRRORS).map((b) => `${b}/${sub}`);
  return [...new Set([...mine, ...(official ? [...officialUrls, ...cn] : [...cn, ...officialUrls])])];
}

export const modelReady = (dir = MODEL_DIR) => {
  try { return fs.statSync(path.join(dir, 'model.int8.onnx')).size === MODEL_BYTES && fs.statSync(path.join(dir, 'tokens.txt')).size > 1000; } catch { return false; }
};

function unpack(archive, tmp) {
  const size = fs.statSync(archive).size;
  if (size < 100 * 1024 * 1024) throw new Error(`压缩包只有 ${mb(size)}，不完整`);
  const out = path.join(tmp, 'x');
  fs.mkdirSync(out, { recursive: true });
  const r = spawnSync('tar', ['-xjf', archive, '-C', out], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`解压失败：${(r.stderr || r.error?.message || '').trim().split(/\r?\n/)[0]}`);
  return path.join(out, fs.readdirSync(out)[0]);
}

function install(fromDir) {
  if (!fs.existsSync(path.join(fromDir, 'model.int8.onnx'))) throw new Error('里面没有 model.int8.onnx，可能不是这个模型');
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  for (const f of ['model.int8.onnx', 'tokens.txt', 'LICENSE', 'README.md']) {
    if (fs.existsSync(path.join(fromDir, f))) fs.copyFileSync(path.join(fromDir, f), path.join(MODEL_DIR, f));
  }
  if (!modelReady()) throw new Error('模型文件大小不对，可能没下完整');
}

// 返回 { ok, from } 或抛错。opts: { file, dir, official, force, log }
export async function getModel({ file, dir, official = false, force = false, log = console.log } = {}) {
  if (modelReady() && !force) return { ok: true, from: '已经在了' };
  if (dir) { install(path.resolve(dir)); return { ok: true, from: dir }; }
  if (file) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boke-model-'));
    try { install(unpack(path.resolve(file), tmp)); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    return { ok: true, from: file };
  }
  // 两种下法：逐个文件（魔搭、hf-mirror，按 sha256 核对，两个文件同时下）；GitHub 的整个压缩包（解开再核对大小）
  const files = async () => {
    const rs = await fetchAll(Object.entries(SV_FILES).map(([n, w]) => ({
      dest: path.join(MODEL_DIR, n), ...w, force, log, label: `识别模型 ${n}`,
      urls: order(`sense-voice/${n}`, [`${HF_BASE}/${n}`], official),
    })));
    const bad = rs.filter((r) => !r.ok);
    if (bad.length) throw new Error(bad.map((r) => r.error).join('；'));
    if (!modelReady()) throw new Error('模型文件大小不对');
    return [...new Set(rs.map((r) => r.from).filter((f) => f !== '已经在了'))].join('、') || '已经在了';
  };
  const archive = async () => {
    const a = path.join(DL_DIR, `${NAME}.tar.bz2`);
    await fetchFile({ dest: a, urls: [GH_ARCHIVE], force, log, label: '识别模型压缩包' });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boke-model-'));
    try { install(unpack(a, tmp)); } catch (e) { fs.rmSync(a, { force: true }); throw e; } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    fs.rmSync(a, { force: true });
    return 'GitHub';
  };
  const failed = [];
  for (const way of official ? [archive, files] : [files, archive]) {
    try { return { ok: true, from: await way() }; } catch (e) { failed.push(e.message); }
  }
  throw new Error(`识别模型没下载下来。${failed.join('；')}。\n再运行一次会接着下（已下的部分留着）。也可以让已经装好的人把模型压缩包发给你，然后：${cmd('tools/get-model.mjs', '--file', '<压缩包>')}（"<压缩包>"换成压缩包的完整路径）`);
}

// ---- 播客精编用的三个小模型（人声检测、说话人切分、声纹，合计约 45 MB）----
// 每个都按大小和 sha256 核对，三个同时下；dir 给了就从那个文件夹里按校验值认文件（不看文件名）
export async function getPodcastModels({ dir, official = false, force = false, log = console.log } = {}) {
  const { PODCAST_MODELS, PM_DIR, pmReady, pmPath } = await import('./lib/podcast.mjs');
  fs.mkdirSync(PM_DIR, { recursive: true });
  const failed = [];
  const keys = Object.keys(PODCAST_MODELS).filter((k) => force || !pmReady(k));
  if (dir) {
    const root = path.resolve(dir);
    const local = fs.readdirSync(root, { recursive: true }).map((n) => path.join(root, String(n))).filter((f) => fs.statSync(f).isFile());
    for (const key of keys) {
      const m = PODCAST_MODELS[key];
      let hit = null;
      for (const f of local) if (fs.statSync(f).size === m.bytes && (await sha256File(f)) === m.sha256) { hit = f; break; }
      if (hit) { fs.copyFileSync(hit, pmPath(key)); log(`  ${m.what}：从 ${hit} 拷来`); } else failed.push(`${m.what}（文件夹里没有）`);
    }
  } else {
    await Promise.all(keys.map(async (key) => {
      const m = PODCAST_MODELS[key];
      const plain = m.urls.filter((u) => typeof u === 'string');
      const job = { dest: pmPath(key), bytes: m.bytes, sha256: m.sha256, force, log, label: m.what };
      try {
        await fetchFile({ ...job, urls: order(`podcast/${m.file}`, official ? plain : [...plain].reverse(), official) });
        return;
      } catch (e) { if (!m.urls.some((u) => typeof u !== 'string')) { failed.push(m.what); return log(`  ${e.message}`); } }
      // 最后一招：GitHub 上的压缩包，解开取出模型文件
      for (const u of m.urls.filter((x) => typeof x !== 'string')) {
        const a = path.join(DL_DIR, path.basename(new URL(u.archive).pathname));
        const x = fs.mkdtempSync(path.join(os.tmpdir(), 'boke-pm-'));
        try {
          await fetchFile({ dest: a, urls: [u.archive], log, label: `${m.what}（压缩包）` });
          const r = spawnSync('tar', ['-xjf', a, '-C', x], { encoding: 'utf8', windowsHide: true });
          if (r.status !== 0) { fs.rmSync(a, { force: true }); throw new Error('解压失败'); }
          const f = fs.readdirSync(x, { recursive: true }).map((n) => path.join(x, String(n))).find((p) => path.basename(p) === u.member);
          if (!f || fs.statSync(f).size !== m.bytes || (await sha256File(f)) !== m.sha256) { fs.rmSync(a, { force: true }); throw new Error('压缩包里的模型文件校验不对'); }
          fs.copyFileSync(f, pmPath(key));
          fs.rmSync(a, { force: true });
          return;
        } catch (e) { log(`  ${m.what}：${e.message}`); } finally { fs.rmSync(x, { recursive: true, force: true }); }
      }
      failed.push(m.what);
    }));
  }
  if (failed.length) throw new Error(`播客用的模型没下全：${failed.join('、')}。再运行一次会接着下。也可以让已经装好的人把技能目录里的 models/podcast 文件夹拷给你，然后：${cmd('tools/get-model.mjs', '--podcast', '--dir', '<文件夹>')}（"<文件夹>"换成那个文件夹的完整路径）`);
  return { ok: true };
}

// ---- 配乐曲库：曲库.json 里有 url 的曲子，下载到 models/music/（合计约 52 MB）----
// 来源依次：自己配的地址 → 国内模型地址（魔搭转存仓库）的 music/<文件> → 曲库.json 里记的 url。按大小和 sha256 核对，几首同时下。
// ids 不给就下全部缺的；返回 { got, failed, why: { 编号: 没下下来的原因 }, broken: [本地文件坏了、重下的编号] }，
// 不抛错（缺几首不影响剪辑：用到时会再下，下不下来用 Aurora）。
// 本地已有的按 sha256 核对（有缓存，见 library.mjs 的 trackGood）：大小对、内容坏了的删掉重下（v0.7 审查 69）
export async function getMusic({ ids, force = false, log = console.log } = {}) {
  const { loadLibrary, trackReady, trackGood, MUSIC_DIR } = await import('./lib/library.mjs');
  const want = [], broken = [];
  for (const t of loadLibrary().filter((t) => t.url && (!ids || ids.includes(t.id)))) {
    if (force) { want.push(t); continue; }
    if (await trackGood(t)) continue;
    if (trackReady(t)) { broken.push(t.id); log(`  配乐 ${t.id}：本地文件大小对、内容不对（校验值不一样），删掉重下`); }
    want.push(t);
  }
  const got = [], failed = [], why = {};
  if (!want.length) return { got, failed, why, broken };
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  let done = 0;
  const total = want.reduce((s, t) => s + (t.bytes ?? 0), 0);
  const tick = want.length > 1 ? setInterval(() => log(`  配乐：已下 ${done} / ${want.length} 首（共约 ${mb(total)}）`), 8000) : null;
  const rs = await fetchAll(want.map((t) => ({
    dest: t.path, bytes: t.bytes, sha256: t.sha256, force: force || broken.includes(t.id), log, label: `配乐 ${t.id}`,
    urls: [...modelMirrors().map((b) => `${b}/music/${t.file}`), t.url],
    onDone: () => done++,
  }))).finally(() => tick && clearInterval(tick));
  rs.forEach((r, i) => { (r.ok ? got : failed).push(want[i].id); if (!r.ok) why[want[i].id] = String(r.error ?? '').replace(/^配乐 \S+ 没下载下来/, '').replace(/^（(.*)）$/, '$1').replace(/，已删掉重下/g, '') || '原因不明'; });
  log(`  配乐：下好 ${got.length} 首${failed.length ? `，${failed.length} 首没下下来（${failed.map((id) => `${id}：${why[id]}`).join('；')}）` : ''}`);
  return { got, failed, why, broken };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const official = args.includes('--official'), force = args.includes('--force');
  if (args.includes('--music')) {
    const r = await getMusic({ force });
    process.exit(r.failed.length ? 1 : 0);
  }
  if (args.includes('--podcast')) {
    try {
      await getPodcastModels({ dir: opt('--dir'), official, force });
      console.log('播客用的模型已就绪：models/podcast');
    } catch (e) { console.error(e.message); process.exit(1); }
    process.exit(0);
  }
  try {
    const r = await getModel({ file: opt('--file'), dir: opt('--dir'), official, force });
    console.log(`识别模型已就绪：${MODEL_DIR}（来源：${r.from}）`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
