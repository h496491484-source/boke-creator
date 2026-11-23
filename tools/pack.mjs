#!/usr/bin/env node
// 打分发包（给维护者用，学员用不到）。
//
//   node tools/pack.mjs                  轻量包：只有技能本身（约 2 MB），对方自己运行 setup 下载其余的
//   node tools/pack.mjs --with-runtime   离线完整包：连同已装好的识别程序、模型、ffmpeg 一起打（2026-11-22 实测压缩后约 357 MB，解开约 374 MB）
//                                        只能给**同一种系统**的人用（Windows 打的包给 Windows），对方解压后不用联网。
//                                        ffmpeg 必须在技能目录 .state/ffmpeg 里（用系统装的 ffmpeg 时先运行 tools/get-ffmpeg.mjs）
//       [--out <目录>]                   输出目录，默认 dist/
//
// 只打白名单里的东西（TOP_FILES、TOP_DIRS，完整包再加识别程序、模型、ffmpeg）。在 git 仓库里时，
// 白名单里的文件还要是 git 跟踪的：技能目录里自己放的笔记、节目档案、.env、编辑器配置、.claude/worktrees 都不会打进去。
// 点开头的文件和文件夹、boke-creator.local.json（本机路径）在哪一层都不打。开发说明.md 是维护者文档，不打。
// 打之前再查一遍：有不该出现的东西、SKILL.md 不止一份、文本里写着本机路径，就不打。
// 压缩包自己写，不调系统的压缩命令：文件名统一 UTF-8、路径统一正斜杠，Windows 和 Mac 解出来都不乱码。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { ROOT, cmd } from './lib/env.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const full = args.includes('--with-runtime');
const outDir = path.resolve(opt('--out', path.join(ROOT, 'dist')));
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const TOP = 'boke-creator'; // 压缩包里的顶层文件夹名

const RUNTIME = ['node_modules', '.state', 'models'];
// 白名单：技能目录第一层只打这些（template 下只打 配乐/）。新加了第一层的文件或文件夹，要写进这里才会打进去
const TOP_FILES = new Set(['SKILL.md', 'README.md', 'LICENSE', '第三方授权.md', 'package.json', 'package-lock.json']);
const TOP_DIRS = new Set(['agents', 'references', 'tools', 'template']);
const JUNK = new Set(['Thumbs.db', 'desktop.ini']);                        // 在哪一层都不要（点开头的另外整个排除）
const dotted = (parts) => parts.some((p, i) => p.startsWith('.') && !(i === 0 && p === '.state') && !(i === 1 && parts[0] === 'node_modules' && p === '.package-lock.json'));
function wanted(rel) { // rel 用正斜杠
  const parts = rel.split('/');
  if (dotted(parts) || parts.some((p) => JUNK.has(p) || p === 'boke-creator.local.json')) return false;
  if (RUNTIME.includes(parts[0])) {
    if (!full) return false;
    if (parts[0] === 'node_modules' && !/^(sherpa-onnx|\.package-lock\.json$)/.test(parts[1])) return false; // 旧版安装留下的依赖不带
    if (parts[0] === '.state' && parts[1] !== 'ffmpeg') return false;       // 只带 ffmpeg（旧安装的浏览器、锁文件不带）
    if (parts[0] === '.state' && /^ffprobe(\.exe)?$/.test(parts.at(-1))) return false; // 旧安装下的 ffprobe 现在用不着了，不带
    if (/\.tmp-|\.tmp$/.test(rel) || rel.endsWith('.part') || (parts[0] === 'models' && parts[1] === '.download')) return false; // 下到一半的、解压用的临时文件
    return true;
  }
  if (parts.length === 1) return TOP_FILES.has(parts[0]);
  if (!TOP_DIRS.has(parts[0])) return false;
  if (parts[0] === 'template' && parts[1] !== '配乐') return false;          // 旧版模板
  return true;
}

// 在 git 仓库里（技能目录就是仓库根）：白名单里的文件只打 git 跟踪的。不是仓库（比如拷来的一份）就只按白名单
function gitTracked() {
  const git = (...a) => spawnSync('git', ['-c', 'core.quotepath=off', ...a], { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1048576 });
  const top = git('rev-parse', '--show-toplevel');
  if (top.error || top.status !== 0) return null;
  const real = (p) => { try { return fs.realpathSync.native(p).toLowerCase(); } catch { return path.resolve(p).toLowerCase(); } };
  if (real(top.stdout.trim()) !== real(ROOT)) return null;               // 技能目录只是别的仓库里的一个子文件夹：不按它的 git 来
  const r = git('ls-files', '-z');
  return r.status === 0 ? new Set(r.stdout.split('\0').filter(Boolean)) : null;
}
const tracked = gitTracked();

const files = [], untracked = [];
(function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name, p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      const parts = r.split('/');
      if (dotted(parts)) continue;
      if (parts.length === 1 && !TOP_DIRS.has(r) && !(full && RUNTIME.includes(r))) continue;
      walk(p, r); continue;
    }
    if (!e.isFile() || !wanted(r)) continue;
    if (tracked && !RUNTIME.includes(r.split('/')[0]) && !tracked.has(r)) { untracked.push(r); continue; }
    files.push({ rel: r, abs: p });
  }
})(ROOT, '');
files.sort((a, b) => a.rel.localeCompare(b.rel));
if (untracked.length) console.log(`这些文件没进 git，没打进去（要打的话先 git add）：\n${untracked.map((r) => `  · ${r}`).join('\n')}`);
if (!tracked) console.log('技能目录不是 git 仓库，只按白名单打包：references、tools、template/配乐 里自己放的文件也会打进去，打完看一眼清单。');

// 给 AI 看的文档先查一遍：```json 示例能解析、编号列表不断号、表格有分隔行（审查修复 F2 时有过整份文档的 1 和 - 被换掉）
function docProblems(rel, text) {
  const bad = [], lines = text.split(/\r?\n/);
  let inCode = false, lang = '', buf = [], start = 0, prevNum = 0;
  lines.forEach((l, i) => {
    const n = i + 1;
    if (/^```/.test(l)) {
      if (!inCode) { inCode = true; lang = l.slice(3).trim(); buf = []; start = n; }
      else { inCode = false; if (lang === 'json') { try { JSON.parse(buf.join('\n')); } catch (e) { bad.push(`${rel}:${start} json 示例解析不了（${e.message}）`); } } }
      return;
    }
    if (inCode) { buf.push(l); return; }
    const m = /^(\d+)\. /.exec(l);
    if (m) { const k = Number(m[1]); if (k > 1 && k !== prevNum + 1) bad.push(`${rel}:${n} 编号列表断了（上一条是 ${prevNum || '无'}，这条是 ${k}）`); prevNum = k; }
    else if (l.trim() && !/^\s/.test(l)) prevNum = 0;
    if (/^\.\. /.test(l)) bad.push(`${rel}:${n} 行首是"..",像是编号被换掉了`);
    if (/^ {2}\S/.test(l) && !/^ {2}([-*+]|\d+\.) /.test(l) && /^ {2}\S/.test(lines[i + 1] || '') && !(lines[i - 1] || '').trim()) bad.push(`${rel}:${n} 连着几行只缩进两格，像是列表的"- "被去掉了`);
    if (/^\|/.test(l) && !/^\|/.test(lines[i - 1] || '') && !/^\|\s*:?-{3,}/.test(lines[i + 1] || '')) bad.push(`${rel}:${n} 表格第二行不是 |---| 分隔行`);
  });
  return bad;
}
const docs = files.filter((f) => /^(SKILL|README)\.md$|^references\/.*\.md$/.test(f.rel));
const docBad = docs.flatMap((f) => docProblems(f.rel, fs.readFileSync(f.abs, 'utf8')));
if (docBad.length) { console.error(`文档有坏的地方，先改好再打包：\n${docBad.map((s) => `  · ${s}`).join('\n')}`); process.exit(1); }

if (full) {
  const win = process.platform === 'win32';
  const sherpaPlat = `sherpa-onnx-${win ? 'win' : process.platform}-${process.arch}`;
  const need = ['node_modules/sherpa-onnx-node/package.json', `node_modules/${sherpaPlat}/sherpa-onnx.node`, 'models/sense-voice/model.int8.onnx',
    'models/podcast/silero_vad.onnx', 'models/podcast/pyannote-segmentation-3-0.onnx', 'models/podcast/3dspeaker-eres2net-base-zh.onnx'];
  const missing = need.filter((f) => !files.some((x) => x.rel === f));
  if (missing.length) {
    console.error(`这台电脑上还没装全（缺 ${missing.join('、')}），打不了离线完整包。先运行 ${cmd('tools/setup.mjs')}，自检通过后再打。`);
    process.exit(1);
  }
  // ffmpeg 要在技能目录里：用的是系统装的（PATH、winget、boke-creator.local.json）时 .state 里是空的，对方解压后会缺 ffmpeg
  const ffNeed = [`.state/ffmpeg/bin/ffmpeg${win ? '.exe' : ''}`, '.state/ffmpeg/bin/LICENSE.txt'].filter((f) => !files.some((x) => x.rel === f));
  if (ffNeed.length) {
    console.error(`技能目录里没有 ffmpeg（缺 ${ffNeed.join('、')}），打出来的包对方解压后会缺 ffmpeg。先运行 ${cmd('tools/get-ffmpeg.mjs')} 把 ffmpeg 和它的许可证下载进技能目录，再打。`);
    process.exit(1);
  }
}

// 打之前再查一遍：不该出现的、SKILL.md 不止一份、文本里写着本机路径的，都不打
const problems = [];
for (const f of files) {
  const parts = f.rel.split('/');
  if (parts.some((p) => p === 'boke-creator.local.json' || p === '.claude' || p === '.git' || /^\.env/.test(p) || p === '.vscode' || p === '.idea')) problems.push(`${f.rel}：不该打进包`);
}
const skillMds = files.filter((f) => path.posix.basename(f.rel) === 'SKILL.md');
if (skillMds.length !== 1) problems.push(`SKILL.md 有 ${skillMds.length} 份（${skillMds.map((f) => f.rel).join('、')}），应该只有一份`);
const LOCAL_PATH = /[A-Za-z]:[\\/]+(?:claude文件|Codex文件)|[\\/]Users[\\/]+[A-Za-z0-9._-]+[\\/]/i;
for (const f of files) {
  if (RUNTIME.includes(f.rel.split('/')[0]) || !/\.(md|mjs|js|json|ya?ml|txt)$/i.test(f.rel)) continue;
  fs.readFileSync(f.abs, 'utf8').split(/\r?\n/).forEach((line, i) => { if (LOCAL_PATH.test(line)) problems.push(`${f.rel} 第 ${i + 1} 行写着本机路径：${line.trim().slice(0, 80)}`); });
}
if (problems.length) {
  console.error(`有 ${problems.length} 处不对，没打包：\n${problems.map((p) => `  · ${p}`).join('\n')}`);
  process.exit(1);
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
  // 记下权限位：Mac 上 ffmpeg 和动态库要有"可执行"才能跑。只记"能不能执行"，别人一律不能写（0755 / 0644）：
  // 原样照抄的话，Windows 上的文件都是 0666，Mac/Linux 解压后谁都能改脚本（unzip 不套 umask）
  central.push({ name, method, time, date, crc, csize: body.length, size: data.length, at, mode: 0o100000 | (st.mode & 0o111 ? 0o755 : 0o644) });
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
console.log(`${files.length} 个文件，原始 ${mb(raw)}，压缩后 ${mb(offset)}。${full ? `离线完整包，只能给 ${plat} 的电脑用。` : '轻量包，对方解压后运行解压出来的技能目录里的 tools/setup.mjs 下载其余的（node "<技能目录>/tools/setup.mjs"）。'}`);
console.log(`对方解压后会得到一个 ${TOP} 文件夹，放进助手的技能目录即可。`);
