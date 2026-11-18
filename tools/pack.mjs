#!/usr/bin/env node
// 打分发包（给维护者用，学员用不到）。
//
//   node tools/pack.mjs                  轻量包：只有技能本身（约 45 MB，主要是字体），对方自己运行 setup 下载其余的
//   node tools/pack.mjs --with-runtime   离线完整包：连同已装好的渲染程序、浏览器、识别模型一起打（约 600 MB）
//                                        只能给**同一种系统**的人用（Windows 打的包给 Windows），对方解压后不用联网
//       [--out <目录>]                   输出目录，默认 dist/
//
// 永远不打进去的：本机路径 boke-creator.local.json、示例跑出来的音视频、dist/、.git。
// 压缩包自己写，不调系统的压缩命令：文件名统一 UTF-8、路径统一正斜杠，Windows 和 Mac 解出来都不乱码。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from './lib/env.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const full = args.includes('--with-runtime');
const outDir = path.resolve(opt('--out', path.join(ROOT, 'dist')));
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const TOP = 'boke-creator'; // 压缩包里的顶层文件夹名

const RUNTIME = ['node_modules', '.state', 'models'];
const TOP_SKIP = new Set(['boke-creator.local.json', 'dist', '.git']);      // 只在技能目录第一层排除（依赖包里也有叫 dist 的目录，那些要留）
const JUNK = new Set(['.DS_Store', 'Thumbs.db']);                     // 在哪一层都不要
function wanted(rel) { // rel 用正斜杠
  const parts = rel.split('/');
  if (TOP_SKIP.has(parts[0]) || parts.some((p) => JUNK.has(p))) return false;
  if (RUNTIME.includes(parts[0])) {
    if (!full) return false;
    if (parts.includes('.bin')) return false;                               // 里面是指向别处的快捷方式
    if (parts[0] === '.state' && !['browser', 'ffmpeg'].includes(parts[1])) return false; // 锁文件、更新检查记录
    if (/\.tmp-/.test(rel)) return false;
    return true;
  }
  if (parts[0] === 'examples' && parts.length > 2) return parts.length === 3 && parts[2] === '口播稿.txt'; // 示例只带稿子
  return true;
}

const files = [];
(function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name, p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { if (!TOP_SKIP.has(r) && (full || !RUNTIME.includes(r))) walk(p, r); continue; }
    if (e.isFile() && wanted(r)) files.push({ rel: r, abs: p });
  }
})(ROOT, '');
files.sort((a, b) => a.rel.localeCompare(b.rel));

if (full) {
  const missing = ['node_modules/@veedstudio/openedit-cli/cli/dist/cli.js', 'node_modules/sherpa-onnx-node/package.json', 'models/sense-voice/model.int8.onnx',
    'models/podcast/silero_vad.onnx', 'models/podcast/pyannote-segmentation-3-0.onnx', 'models/podcast/3dspeaker-eres2net-base-zh.onnx']
    .filter((f) => !files.some((x) => x.rel === f));
  if (missing.length || !files.some((x) => x.rel.startsWith('.state/browser/'))) {
    console.error('这台电脑上还没装全，打不了离线完整包。先运行 node tools/setup.mjs，自检通过后再打。');
    process.exit(1);
  }
}

// ---- 写 zip ----
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = zlib.crc32 ? (b) => zlib.crc32(b) >>> 0 : (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const dosTime = (d) => ({ time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() });
const STORE_OVER = 64 * 1024 * 1024; // 大文件（模型）不压缩，省内存也省时间

const plat = `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : process.platform}-${process.arch}`;
fs.mkdirSync(outDir, { recursive: true });
const zipFile = path.join(outDir, full ? `boke-creator-v${version}-离线完整包-${plat}.zip` : `boke-creator-v${version}.zip`);
const fd = fs.openSync(zipFile, 'w');
let offset = 0;
const write = (buf) => { fs.writeSync(fd, buf); offset += buf.length; };
const central = [];
let raw = 0;

for (const f of files) {
  const st = fs.statSync(f.abs);
  const data = fs.readFileSync(f.abs);
  const name = Buffer.from(`${TOP}/${f.rel}`, 'utf8');
  const store = data.length > STORE_OVER || data.length === 0;
  const body = store ? data : zlib.deflateRawSync(data, { level: 6 });
  const method = store ? 0 : 8, crc = crc32(data), { time, date } = dosTime(st.mtime);
  if (offset + body.length > 0xfffffff0 || files.length > 65000) { console.error('包太大，超出了普通 zip 的上限。'); process.exit(1); }
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); // 0x0800：文件名是 UTF-8
  head.writeUInt16LE(method, 8); head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12);
  head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
  const at = offset;
  write(head); write(name); write(body);
  // 记下权限位：Mac 上浏览器和动态库要有"可执行"才能跑
  central.push({ name, method, time, date, crc, csize: body.length, size: data.length, at, mode: st.mode & 0xffff });
  raw += data.length;
}
const cdStart = offset;
for (const c of central) {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE((3 << 8) | 20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0800, 8);
  h.writeUInt16LE(c.method, 10); h.writeUInt16LE(c.time, 12); h.writeUInt16LE(c.date, 14);
  h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(c.csize, 20); h.writeUInt32LE(c.size, 24);
  h.writeUInt16LE(c.name.length, 28); h.writeUInt32LE((c.mode << 16) >>> 0, 38); h.writeUInt32LE(c.at, 42);
  write(h); write(c.name);
}
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
end.writeUInt32LE(offset - cdStart, 12); end.writeUInt32LE(cdStart, 16);
write(end);
fs.closeSync(fd);

const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
console.log(`已打包：${zipFile}`);
console.log(`${files.length} 个文件，原始 ${mb(raw)}，压缩后 ${mb(offset)}。${full ? `离线完整包，只能给 ${plat} 的电脑用。` : '轻量包，对方解压后运行 node tools/setup.mjs 下载其余的。'}`);
console.log(`对方解压后会得到一个 ${TOP} 文件夹，放进助手的技能目录即可。`);
