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
export function tryRun(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000, windowsHide: true, ...opts });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || r.stderr || '').split(/\r?\n/)[0].trim() || 'ok';
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
    const ff = c.dir ? path.join(c.dir, exe('ffmpeg')) : 'ffmpeg';
    const fp = c.dir ? path.join(c.dir, exe('ffprobe')) : 'ffprobe';
    if (c.dir && !fs.existsSync(ff)) continue;
    const v = tryRun(ff, ['-version']);
    const vp = v && tryRun(fp, ['-version']);
    if (v && vp) return { ok: true, dir: c.dir, from: c.from, version: v.replace(/ Copyright.*/, ''), tried };
    tried.push(`${c.from}（${c.dir ?? 'PATH'}）：${v ? 'ffprobe 跑不起来' : 'ffmpeg 跑不起来'}`);
  }
  return { ok: false, tried };
}

export const ffBin = (ffmpeg, name) => (ffmpeg?.dir ? path.join(ffmpeg.dir, exe(name)) : name);
export const platformName = () => `${os.type()} ${os.release()} ${os.arch()}`;
