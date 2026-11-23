// 找到并真正执行一次 ffmpeg，确认它能用。setup、doctor 和播客脚本共用。
//
// 所有运行时的东西都装在技能目录里：node_modules/（识别程序）、.state/ffmpeg（自动下载的 ffmpeg）、
// models/（识别模型）。不往系统目录和用户目录里写。
// 查找顺序：环境变量 → 本机配置 boke-creator.local.json → 技能目录里的默认位置 → 系统常见位置。
// "文件在不在"不算数：winget 的 Links 目录里出现过 0 字节的 ffmpeg.exe，所以每个候选都要跑一次。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONFIG_FILE = path.join(ROOT, 'boke-creator.local.json'); // 只记本机路径，不进分发包
export const STATE_DIR = path.join(ROOT, '.state');
const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

// ---- 提示 AI 的命令 ----
// 输出里"下一步运行……"一律给能直接复制运行的命令：脚本的绝对路径 + 带引号的参数，从任何目录都能跑，
// AI 不用先 cd 到技能目录，也不用自己拼路径。script 写 'build.mjs'（tools/podcast 下）或 'tools/setup.mjs'（相对技能目录）。
// 参数：绝对路径、带空格的、"<录音文件>"这类占位都加引号（占位不加引号，PowerShell 照抄会报"The '<' operator is reserved"；
// 照抄前要把占位换成真的路径）；--confirm、素材这类原样放。
// 引号按本机的 shell 来（2026-11-20 审查 F2）：
//   Windows 按 PowerShell（cmd.exe 也认双引号）：平常用双引号；路径里有 $ ` 或中文双引号时改用单引号
//     （PowerShell 的双引号里 $xxx 会被展开、` 是转义符、“” 也算双引号），单引号里的 ' ‘ ’ 写两遍。
//   Mac / Linux 按 sh、zsh：有 $ ` " \ ! 时用单引号，里面的 ' 写成 '\''。
// 开头的 node：PATH 里找得到 node 就写 node；找不到（比如只有 WorkBuddy 自带的 node.exe）写正在跑的这个 node 的完整路径，
// Windows 上路径带空格时写成 PowerShell 的 & "…\node.exe"。
const WIN = process.platform === 'win32';
export function shQuote(s) {
  s = String(s);
  if (WIN) return /[$`"“”„]/.test(s) ? `'${s.replace(/(['‘’‚‛])/g, '$1$1')}'` : `"${s}"`;
  return /[$`"\\!]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : `"${s}"`;
}
let nodeCache = null;
export function nodeCmd() {
  if (nodeCache) return nodeCache;
  const names = WIN ? ['node.exe', 'node.cmd'] : ['node'];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (dirs.some((d) => names.some((n) => { try { return fs.statSync(path.join(d.replace(/^"|"$/g, ''), n)).isFile(); } catch { return false; } }))) return (nodeCache = 'node');
  const p = process.execPath;
  if (WIN) return (nodeCache = /^[^\s$`"“”'‘’&()^%!;,@{}]+$/.test(p) ? p : `& ${shQuote(p)}`);
  return (nodeCache = /^[\w./-]+$/.test(p) ? p : shQuote(p));
}
export function cmd(script, ...args) {
  const file = script.startsWith('tools/') ? path.join(ROOT, ...script.split('/')) : path.join(ROOT, 'tools', 'podcast', script);
  const arg = (a) => { a = String(a); return path.isAbsolute(a) || /^<.+>$/.test(a) || /\s/.test(a) ? shQuote(a) : a; };
  return [nodeCmd(), shQuote(file), ...args.filter((a) => a != null && a !== '').map(arg)].join(' ');
}

export function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  for (const k of Object.keys(next)) if (next[k] == null) delete next[k];
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

// 跑一次命令，返回第一行输出；跑不起来返回 null
export function tryRun(cmd, args, opts = {}) { return runFirstLine(cmd, args, opts).line; }
// 同上，另外说清是"根本没有这个命令"（missing）还是"有，但跑不起来"
function runFirstLine(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000, windowsHide: true, ...opts });
  if (r.error || r.status !== 0) return { line: null, missing: r.error?.code === 'ENOENT' };
  return { line: (r.stdout || r.stderr || '').split(/\r?\n/)[0].trim() || 'ok' };
}

function ffmpegCandidates(cfg) {
  const list = [];
  if (process.env.FFMPEG_DIR) list.push({ dir: process.env.FFMPEG_DIR, from: '环境变量 FFMPEG_DIR' });
  if (cfg.ffmpegDir) list.push({ dir: cfg.ffmpegDir, from: 'boke-creator.local.json' });
  list.push({ dir: path.join(STATE_DIR, 'ffmpeg', 'bin'), from: '技能目录（安装脚本下载的）' });
  list.push({ dir: null, from: '系统 PATH' });
  if (process.platform === 'win32') {
    const pk = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const p of fs.readdirSync(pk).filter((n) => /ffmpeg/i.test(n))) {
        for (const sub of fs.readdirSync(path.join(pk, p))) list.push({ dir: path.join(pk, p, sub, 'bin'), from: 'winget 安装目录' });
      }
    } catch { /* 没有 winget 目录 */ }
    list.push({ dir: 'C:\\ffmpeg\\bin', from: 'C:\\ffmpeg\\bin' });
  } else {
    for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) list.push({ dir: d, from: d });
  }
  return list;
}

// 返回 { ok, dir, from, version, tried }；dir 为 null 表示直接用 PATH 里的
export function findFfmpeg(cfg = loadConfig()) {
  const tried = [];
  for (const c of ffmpegCandidates(cfg)) {
    // 只要 ffmpeg 本身：时长、声道数也用它看，不再要求旁边有 ffprobe（以前装过的留着也不碍事）
    const ff = c.dir ? path.join(c.dir, exe('ffmpeg')) : 'ffmpeg';
    if (c.dir && !fs.existsSync(ff)) continue;
    const { line: v, missing } = runFirstLine(ff, ['-version']);
    if (v) return { ok: true, dir: c.dir, from: c.from, version: v.replace(/ Copyright.*/, ''), tried };
    if (missing && !c.dir) continue; // PATH 里根本没有 ffmpeg：不算"跑不起来"，一个都没找到时自检会说"哪里都没找到"
    tried.push(`${c.from}（${c.dir ?? 'PATH'}）：ffmpeg 跑不起来`);
  }
  return { ok: false, tried };
}

export const ffBin = (ffmpeg, name) => (ffmpeg?.dir ? path.join(ffmpeg.dir, exe(name)) : name);
export const platformName = () => `${os.type()} ${os.release()} ${os.arch()}`;
