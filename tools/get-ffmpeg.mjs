#!/usr/bin/env node
// 下载 ffmpeg（ffmpeg-static 项目的 b6.0 构建），放到技能目录 .state/ffmpeg/bin。
// 只下 ffmpeg 一个：时长、声道数也用它看（lib/podcast.mjs 的 probe），不再下 ffprobe（省一半，约 28 MB）。
// 来源：国内镜像 npmmirror（国内不开代理也能下）→ GitHub 上 ffmpeg-static 的发布页（同一批文件）。--official 时 GitHub 在前。
// Windows 版就是 gyan.dev 的 ffmpeg 6.0 essentials；Mac 有 Intel 和 Apple 芯片两种。
// 下载的是 .gz，断了能接着下，按大小和 sha256 核对后解开。ffmpeg 按 GPL-3.0 分发，许可证随包下载到同一目录。
//
//   node tools/get-ffmpeg.mjs [--official]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { STATE_DIR, findFfmpeg } from './lib/env.mjs';
import { fetchAll, fetchFile, mb } from './lib/download.mjs';

const BASES = {
  cn: 'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.0/',
  official: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/',
};
const BUILDS = {
  'win32-x64': {
    ffmpeg: { bytes: 28894894, sha256: '450d66226c79405c724e821f291cab0911e934bfa9fa2231adcab587f3e07b50' },
  },
  'darwin-x64': {
    ffmpeg: { bytes: 25067704, sha256: 'a12354fce7eb62361473bbe10d53a1893695babd35869ec8e92e5dfea8d0440b' },
  },
  'darwin-arm64': {
    ffmpeg: { bytes: 19253088, sha256: '6be74d6f449889c2e87a75873894f8520cad56c08ac76f2a628d85b0519daaca' },
  },
};
export const FF_DIR = path.join(STATE_DIR, 'ffmpeg', 'bin');
// Windows ARM（骁龙）电脑没有单独的构建：Windows 11 能跑 x64 程序，用 x64 那份（下完会真的跑一次，跑不起来就报错）。
// Windows 10 ARM 跑不了 x64，只能自己装
const winArmOk = () => process.platform === 'win32' && process.arch === 'arm64' && Number(os.release().split('.')[2]) >= 22000;
const plat = winArmOk() ? 'win32-x64' : `${process.platform}-${process.arch}`;
export const mirrorSupported = () => !!BUILDS[plat];
const bases = (official) => (official ? [BASES.official, BASES.cn] : [BASES.cn, BASES.official]);

export async function getFfmpegFromMirror({ official = false, log = console.log } = {}) {
  const build = BUILDS[plat];
  if (!build) throw new Error(`没有 ${process.platform}-${process.arch} 的现成 ffmpeg`);
  fs.mkdirSync(FF_DIR, { recursive: true });
  const names = Object.keys(build);
  const gz = (name) => path.join(FF_DIR, `${name}-${plat}.gz`); // 下完解开就删；.part 留着能接着下
  log(`  下载 ${names.join('、')}（共 ${mb(names.reduce((s, n) => s + build[n].bytes, 0))}）`);
  const rs = await fetchAll(names.map((name) => ({
    dest: gz(name), ...build[name], log, label: name,
    urls: bases(official).map((b) => `${b}${name}-${plat}.gz`),
  })));
  const bad = rs.filter((r) => !r.ok);
  if (bad.length) throw new Error(bad.map((r) => r.error).join('；'));
  for (const name of names) {
    const exe = path.join(FF_DIR, process.platform === 'win32' ? `${name}.exe` : name);
    await pipeline(fs.createReadStream(gz(name)), zlib.createGunzip(), fs.createWriteStream(`${exe}.tmp`));
    fs.renameSync(`${exe}.tmp`, exe);
    if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
    fs.rmSync(gz(name), { force: true });
  }
  // 许可证：下不到不影响使用
  await fetchFile({ dest: path.join(FF_DIR, 'LICENSE.txt'), urls: bases(official).map((b) => `${b}${plat}.LICENSE`) }).catch(() => {});
  const ff = findFfmpeg({ ffmpegDir: FF_DIR });
  if (!ff.ok) throw new Error('下载解开了，但跑不起来');
  return ff;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const ff = await getFfmpegFromMirror({ official: process.argv.includes('--official') });
    console.log(`ffmpeg 已就绪：${ff.version}（${FF_DIR}）`);
  } catch (e) { console.error(`没成功：${e.message}`); process.exit(1); }
}
