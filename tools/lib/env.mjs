// 找到并真正执行一次 ffmpeg / OpenEdit，确认它们能用。setup、doctor、make 共用。
//
// 所有运行时的东西都装在技能目录里：node_modules/（OpenEdit、识别程序）、.state/（渲染浏览器、
// 自动下载的 ffmpeg）、models/（识别模型）。不往系统目录和用户目录里写。
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
export const OPENEDIT_PKG = path.join(ROOT, 'node_modules', '@veedstudio', 'openedit-cli');
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

export function findOpenedit(cfg = loadConfig()) {
  const cands = [
    [process.env.OPENEDIT_CLI, '环境变量 OPENEDIT_CLI'],
    [cfg.openeditCli, 'boke-creator.local.json'],
    [path.join(OPENEDIT_PKG, 'cli', 'dist', 'cli.js'), '技能目录 node_modules'],
  ].filter(([p]) => p);
  const tried = [];
  for (const [cli, from] of cands) {
    if (!fs.existsSync(cli)) { tried.push(`${from}：文件不在`); continue; }
    if (tryRun(process.execPath, [cli, '--help'], { env: { ...process.env, OPENEDIT_STATE_DIR: STATE_DIR } })) {
      let version = '';
      try {
        let d = path.dirname(cli);
        for (let i = 0; i < 5 && !version; i++, d = path.dirname(d)) {
          const pj = path.join(d, 'package.json');
          if (fs.existsSync(pj)) version = JSON.parse(fs.readFileSync(pj, 'utf8')).version ?? '';
        }
      } catch { /* 读不到版本号不要紧 */ }
      return { ok: true, cli, from, version, tried };
    }
    tried.push(`${from}：跑不起来`);
  }
  return { ok: false, tried };
}

// 渲染用的浏览器。两种来源：安装脚本下载到状态目录里的那个（首选，版本固定）；
// 或者本机已有的 Chrome / Edge（下载不下来时的退路，路径记在 boke-creator.local.json 的 chromePath）。
// 返回 { ok, dir, from, chrome? }：dir 是 OpenEdit 的状态目录，chrome 有值表示用本机浏览器。
export function findStateDir(cfg = loadConfig()) {
  const cands = [
    [process.env.OPENEDIT_STATE_DIR, '环境变量 OPENEDIT_STATE_DIR'],
    [cfg.openeditStateDir, 'boke-creator.local.json'],
    [STATE_DIR, '技能目录 .state'],
  ].filter(([p]) => p);
  for (const [dir, from] of cands) {
    const b = path.join(dir, 'browser');
    try { if (fs.readdirSync(b).some((n) => !n.includes('.tmp-'))) return { ok: true, dir, from }; } catch { /* 下一个 */ }
  }
  const chrome = process.env.OPENEDIT_CHROME || cfg.chromePath;
  if (chrome && fs.existsSync(chrome)) return { ok: true, dir: STATE_DIR, from: '本机已有的浏览器', chrome };
  return { ok: false };
}

// 本机已有的 Chrome / Edge（下载不到固定版本时的退路）
export function systemBrowsers() {
  const list = process.platform === 'win32'
    ? ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].flatMap((k) => (process.env[k] ? [
      path.join(process.env[k], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env[k], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ] : []))
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return list.filter((p) => fs.existsSync(p));
}

// 给子进程用的环境变量。OpenEdit 的状态目录永远指到技能目录里，不让它往用户目录写东西。
export function childEnv({ ffmpeg, state } = {}) {
  const env = { ...process.env };
  if (ffmpeg?.dir) { env.FFMPEG_DIR = ffmpeg.dir; env.OPENEDIT_FFMPEG = path.join(ffmpeg.dir, exe('ffmpeg')); }
  env.OPENEDIT_STATE_DIR = state?.dir ?? STATE_DIR;
  if (state?.chrome) env.OPENEDIT_CHROME = state.chrome;
  return env;
}

export const ffBin = (ffmpeg, name) => (ffmpeg?.dir ? path.join(ffmpeg.dir, exe(name)) : name);
export const platformName = () => `${os.type()} ${os.release()} ${os.arch()}`;
