#!/usr/bin/env node
// 下载识别模型（SenseVoice，int8，约 240 MB），放到技能目录 models/sense-voice。
//
//   node tools/get-model.mjs                   自动下载：先试 GitHub，不行换国内镜像
//   node tools/get-model.mjs --mirror          先试国内镜像
//   node tools/get-model.mjs --file <压缩包>   用已经下载好的压缩包（比如老师用 U 盘发的 .tar.bz2）
//   node tools/get-model.mjs --dir <文件夹>    用已经解开的文件夹（里面有 model.int8.onnx 和 tokens.txt）
//   node tools/get-model.mjs --podcast [--mirror] [--dir <文件夹>]   播客精编用的三个小模型，放到 models/podcast
//
// 模型来自 sherpa-onnx 项目转换的 SenseVoiceSmall（阿里 FunAudioLLM）。
// 许可：FunASR 模型开源协议 1.1，可以使用、复制、修改、分享，条件是注明来源和作者、保留模型名称。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { ROOT } from './lib/env.mjs';

const NAME = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
const MODEL_BYTES = 239233841; // model.int8.onnx 的大小，下载完核对
const SOURCES = {
  github: { label: 'GitHub', archive: `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${NAME}.tar.bz2` },
  mirror: {
    label: '国内镜像 hf-mirror.com',
    files: {
      'model.int8.onnx': 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx',
      'tokens.txt': 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt',
    },
  },
};
export const MODEL_DIR = path.join(ROOT, 'models', 'sense-voice');
const SV_FILES = {
  'model.int8.onnx': { bytes: MODEL_BYTES, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
  'tokens.txt': { bytes: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' },
};

// 国内模型地址：放着全部模型文件的地方（<地址>/sense-voice/model.int8.onnx、<地址>/podcast/silero_vad.onnx ……）。
// 2026-11-18 起 hf-mirror.com 会跳转到 huggingface.co，国内不开代理下不了，GitHub 也常断，所以要有一个国内的地址。
// 来源（依次）：环境变量 BOKE_MODEL_MIRROR（逗号分隔可写几个）→ boke-creator.local.json 的 modelMirror → 下面内置的。
// 魔搭上的转存仓库（2026-11-18 建，原样转存，带来源和许可证说明）：https://modelscope.cn/models/jimmy444629/boke-creator-models
export const CN_MODEL_MIRRORS = ['https://modelscope.cn/models/jimmy444629/boke-creator-models/resolve/master'];
export function modelMirrors() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'boke-creator.local.json'), 'utf8')); } catch { /* 没有本机配置 */ }
  return [...(process.env.BOKE_MODEL_MIRROR ?? '').split(','), ...[cfg.modelMirror ?? []].flat(), ...CN_MODEL_MIRRORS].map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}
const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;

export const modelReady = (dir = MODEL_DIR) => {
  try { return fs.statSync(path.join(dir, 'model.int8.onnx')).size === MODEL_BYTES && fs.statSync(path.join(dir, 'tokens.txt')).size > 1000; } catch { return false; }
};

// 下载到文件。连不上、中途 60 秒没有数据、或者太慢（GitHub 在国内常被限速到每分钟几十 KB，
// 不报错但永远下不完），都放弃，换下一个来源。
const MIN_SPEED = 50 * 1024; // 每秒字节数；开头 45 秒不算，之后平均低于这个就换来源
async function download(url, dest, log) {
  const ctl = new AbortController();
  let timer = setTimeout(() => ctl.abort(), 30000);
  let slow = false;
  const res = await fetch(url, { redirect: 'follow', signal: ctl.signal });
  if (!res.ok || !res.body) { clearTimeout(timer); throw new Error(`HTTP ${res.status}`); }
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0, mark = 0.25;
  const t0 = Date.now();
  const speed = setInterval(() => {
    const s = (Date.now() - t0) / 1000;
    if (s > 45 && got / s < MIN_SPEED && (!total || got < total)) { slow = true; ctl.abort(); }
  }, 5000);
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => {
    got += c.length;
    clearTimeout(timer); timer = setTimeout(() => ctl.abort(), 60000);
    if (total && got / total >= mark && mark < 1) { log(`  ${Math.round(mark * 100)}%（${mb(got)}）`); mark += 0.25; }
  });
  try { await pipeline(body, fs.createWriteStream(dest)); }
  catch (e) { if (slow) throw new Error(`太慢（每秒不到 ${MIN_SPEED / 1024} KB）`); throw e; }
  finally { clearTimeout(timer); clearInterval(speed); }
  return got;
}

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

// 返回 { ok, from } 或抛错。opts: { file, dir, mirrorFirst, force, log }
export async function getModel({ file, dir, mirrorFirst = false, force = false, log = console.log } = {}) {
  if (modelReady() && !force) return { ok: true, from: '已经在了' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boke-model-'));
  try {
    if (dir) { install(path.resolve(dir)); return { ok: true, from: dir }; }
    if (file) { install(unpack(path.resolve(file), tmp)); return { ok: true, from: file }; }
    // 国内模型地址排最前（有的话）；其余按 --mirror 决定 hf-mirror 和 GitHub 的先后
    const cn = modelMirrors().map((base, i) => [`cn${i}`, { label: `国内模型地址 ${new URL(base).host}`, files: Object.fromEntries(Object.keys(SV_FILES).map((n) => [n, `${base}/sense-voice/${n}`])), verify: true }]);
    const all = { ...Object.fromEntries(cn), ...SOURCES };
    const order = [...cn.map(([k]) => k), ...(mirrorFirst ? ['mirror', 'github'] : ['github', 'mirror'])];
    const failed = [];
    for (const key of order) {
      const src = all[key];
      try {
        log(`从 ${src.label} 下载识别模型（约 ${src.archive ? '160' : '230'} MB）……`);
        if (src.archive) {
          const a = path.join(tmp, `${NAME}.tar.bz2`);
          await download(src.archive, a, log);
          install(unpack(a, tmp));
        } else {
          const d = path.join(tmp, 'files');
          fs.mkdirSync(d, { recursive: true });
          for (const [name, url] of Object.entries(src.files)) await download(url, path.join(d, name), log);
          for (const [name, want] of Object.entries(SV_FILES)) if (sha256File(path.join(d, name)) !== want.sha256) throw new Error(`${name} 校验不对`);
          install(d);
        }
        return { ok: true, from: src.label };
      } catch (e) {
        const why = e.name === 'AbortError' ? '连不上或中途断了' : e.message;
        failed.push(`${src.label}：${why}`);
        log(`  没成功（${why}）`);
      }
    }
    throw new Error(`识别模型没下载下来。${failed.join('；')}。\n可以让已经装好的人把模型压缩包发给你，然后：node tools/get-model.mjs --file <压缩包>`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- 播客精编用的三个小模型（人声检测、说话人切分、声纹，合计约 45 MB）----
// 每个都按大小和 sha256 核对；dir 给了就从那个文件夹里按校验值认文件（不看文件名）
export async function getPodcastModels({ dir, mirrorFirst = false, force = false, log = console.log } = {}) {
  const { PODCAST_MODELS, PM_DIR, pmReady, pmPath } = await import('./lib/podcast.mjs');
  const crypto = await import('node:crypto');
  const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  fs.mkdirSync(PM_DIR, { recursive: true });
  const failed = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boke-pm-'));
  try {
    const local = dir ? fs.readdirSync(path.resolve(dir), { recursive: true }).map((n) => path.join(path.resolve(dir), String(n))).filter((f) => fs.statSync(f).isFile()) : [];
    for (const [key, m] of Object.entries(PODCAST_MODELS)) {
      if (pmReady(key) && !force) continue;
      const accept = (f) => fs.statSync(f).size === m.bytes && sha256(f) === m.sha256;
      const hit = local.find((f) => fs.statSync(f).size === m.bytes && accept(f));
      if (hit) { fs.copyFileSync(hit, pmPath(key)); log(`  ${m.what}：从 ${hit} 拷来`); continue; }
      if (dir) { failed.push(`${m.what}（文件夹里没有）`); continue; }
      const urls = [...modelMirrors().map((b) => `${b}/podcast/${m.file}`), ...(mirrorFirst ? [...m.urls].reverse() : m.urls)];
      let ok = false;
      for (const u of urls) {
        const url = typeof u === 'string' ? u : u.archive;
        try {
          log(`  下载${m.what}（${mb(m.bytes)}）：${new URL(url).host}`);
          const dest = path.join(tmp, path.basename(new URL(url).pathname));
          await download(url, dest, () => {});
          let file = dest;
          if (typeof u !== 'string') {
            const x = path.join(tmp, `x-${key}`); fs.mkdirSync(x, { recursive: true });
            const r = spawnSync('tar', ['-xjf', dest, '-C', x], { encoding: 'utf8', windowsHide: true });
            if (r.status !== 0) throw new Error('解压失败');
            file = fs.readdirSync(x, { recursive: true }).map((n) => path.join(x, String(n))).find((f) => path.basename(f) === u.member);
            if (!file) throw new Error('压缩包里没有模型文件');
          }
          if (!accept(file)) throw new Error('文件校验不对');
          fs.copyFileSync(file, pmPath(key));
          ok = true; break;
        } catch (e) { log(`    没成功（${e.name === 'AbortError' ? '连不上或中途断了' : e.message}）`); }
      }
      if (!ok) failed.push(m.what);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  if (failed.length) throw new Error(`播客用的模型没下全：${failed.join('、')}。可以让已经装好的人把技能目录里的 models/podcast 文件夹拷给你，然后：node tools/get-model.mjs --podcast --dir <文件夹>`);
  return { ok: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  if (args.includes('--podcast')) {
    try {
      await getPodcastModels({ dir: opt('--dir'), mirrorFirst: args.includes('--mirror'), force: args.includes('--force') });
      console.log('播客用的模型已就绪：models/podcast');
    } catch (e) { console.error(e.message); process.exit(1); }
    process.exit(0);
  }
  try {
    const r = await getModel({ file: opt('--file'), dir: opt('--dir'), mirrorFirst: args.includes('--mirror'), force: args.includes('--force') });
    console.log(`识别模型已就绪：${MODEL_DIR}（来源：${r.from}）`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
