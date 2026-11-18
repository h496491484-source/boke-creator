#!/usr/bin/env node
// 从国内镜像（npmmirror，ffmpeg-static 项目的 b6.0 构建）下载 ffmpeg 和 ffprobe，放到技能目录 .state/ffmpeg/bin。
// 国内不开代理也能下。Windows 版就是 gyan.dev 的 ffmpeg 6.0 essentials；Mac 有 Intel 和 Apple 芯片两种。
// 下载的是 .gz，按大小和 sha256 核对后解开。ffmpeg 按 GPL-3.0 分发，许可证随包下载到同一目录。
//
//   node tools/get-ffmpeg.mjs [--force]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { STATE_DIR, findFfmpeg } from './lib/env.mjs';

const BASE = 'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.0/';
const BUILDS = {
  'win32-x64': {
    ffmpeg: { bytes: 28894894, sha256: '450d66226c79405c724e821f291cab0911e934bfa9fa2231adcab587f3e07b50' },
    ffprobe: { bytes: 28830399, sha256: '3f33adbad509f324e6f72449a5e8428fd655fb2b2eebf1d782c7ef23c44eed6a' },
  },
  'darwin-x64': {
    ffmpeg: { bytes: 25067704, sha256: 'a12354fce7eb62361473bbe10d53a1893695babd35869ec8e92e5dfea8d0440b' },
    ffprobe: { bytes: 25015394, sha256: 'b75d816c5658bd417a2a05e174957963e2f9f85be3eb731b2a04467545a665dc' },
  },
  'darwin-arm64': {
    ffmpeg: { bytes: 19253088, sha256: '6be74d6f449889c2e87a75873894f8520cad56c08ac76f2a628d85b0519daaca' },
    ffprobe: { bytes: 19216948, sha256: 'a4db76bafdb8529312e138fb55aaf143cad21b6d672e2634c9dd07ae83c6a310' },
  },
};
export const FF_DIR = path.join(STATE_DIR, 'ffmpeg', 'bin');
const plat = `${process.platform}-${process.arch}`;
export const mirrorSupported = () => !!BUILDS[plat];

export async function getFfmpegFromMirror({ log = console.log } = {}) {
  const build = BUILDS[plat];
  if (!build) throw new Error(`国内镜像没有 ${plat} 的 ffmpeg`);
  fs.mkdirSync(FF_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boke-ff-'));
  try {
    for (const [name, want] of Object.entries(build)) {
      const url = `${BASE}${name}-${plat}.gz`;
      log(`  下载 ${name}（${Math.round(want.bytes / 1048576)} MB）：registry.npmmirror.com`);
      const gz = path.join(tmp, `${name}.gz`);
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(gz));
      const buf = fs.readFileSync(gz);
      if (buf.length !== want.bytes || crypto.createHash('sha256').update(buf).digest('hex') !== want.sha256) throw new Error(`${name} 校验不对，可能没下完整`);
      const exe = path.join(FF_DIR, process.platform === 'win32' ? `${name}.exe` : name);
      await pipeline(fs.createReadStream(gz), zlib.createGunzip(), fs.createWriteStream(exe));
      if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
    }
    try {
      const lic = await fetch(`${BASE}${plat}.LICENSE`, { signal: AbortSignal.timeout(60000) });
      if (lic.ok) fs.writeFileSync(path.join(FF_DIR, 'LICENSE.txt'), Buffer.from(await lic.arrayBuffer()));
    } catch { /* 许可证下不到不影响使用 */ }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const ff = findFfmpeg({ ffmpegDir: FF_DIR });
  if (!ff.ok) throw new Error('下载解开了，但跑不起来');
  return ff;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const ff = await getFfmpegFromMirror();
    console.log(`ffmpeg 已就绪：${ff.version}（${FF_DIR}）`);
  } catch (e) { console.error(`没成功：${e.message}`); process.exit(1); }
}
