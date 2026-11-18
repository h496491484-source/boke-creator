#!/usr/bin/env node
// 一键安装：把出片需要的东西都装进技能目录，装完自动自检。可以反复运行，已经装好的会跳过。
//
//   node tools/setup.mjs                      自动安装（先试官方地址，连不上自动换国内镜像）
//   node tools/setup.mjs --mirror             先试国内镜像（在国内、没有代理时用这个更快）
//   node tools/setup.mjs --model-file <压缩包>  识别模型用现成的压缩包（老师发的 .tar.bz2）
//   node tools/setup.mjs --check              只看缺什么，不安装
//
// 装的东西和位置（都在技能目录里，不动系统）：
//   node_modules/   OpenEdit（渲染）和 sherpa-onnx（本地识别）
//   .state/browser  渲染用的浏览器（约 120 MB）
//   .state/ffmpeg   ffmpeg（只有 Windows 上找不到 ffmpeg 时才下载）
//   models/         识别模型（约 240 MB）；models/podcast 播客精编用的三个小模型（约 45 MB）
// 唯一要自己先装的是 Node 18 以上。Mac 上的 ffmpeg 也要自己装（brew install ffmpeg）。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, STATE_DIR, OPENEDIT_PKG, findFfmpeg, findOpenedit, findStateDir, systemBrowsers, saveConfig, loadConfig } from './lib/env.mjs';
import { findSherpa, findModel } from './asr.mjs';
import { getModel, modelReady } from './get-model.mjs';
import { getFfmpegFromMirror, mirrorSupported } from './get-ffmpeg.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const mirrorFirst = flag('--mirror'), checkOnly = flag('--check');
const NPM_MIRROR = 'https://registry.npmmirror.com';
const CHROME_OFFICIAL = 'https://storage.googleapis.com/chrome-for-testing-public/';
const CHROME_MIRROR = 'https://cdn.npmmirror.com/binaries/chrome-for-testing/';

const todo = [];   // 没装成、需要人处理的
const say = (s) => console.log(s);
const head = (n, s) => say(`\n[${n}/5] ${s}`);

// ---- 1. Node ----
head(1, 'Node');
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  say(`✗ Node 版本是 v${process.versions.node}，需要 18 或更新。到 https://nodejs.org 下载安装 LTS 版，再运行一次。`);
  process.exit(1);
}
say(`✓ Node v${process.versions.node}`);

// ---- 2. OpenEdit 和识别程序（npm install） ----
head(2, '渲染程序和识别程序');
const depsOk = () => fs.existsSync(path.join(OPENEDIT_PKG, 'cli', 'dist', 'cli.js')) && findSherpa({}).ok;
function npm(extra) {
  // 优先用和当前 node 放在一起的 npm（有的电脑 PATH 里没有 npm）
  const dir = path.dirname(process.execPath);
  const cli = [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((p) => fs.existsSync(p));
  const a = ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error', ...extra];
  const r = cli
    ? spawnSync(process.execPath, [cli, ...a], { cwd: ROOT, stdio: 'inherit', windowsHide: true })
    : spawnSync('npm', a, { cwd: ROOT, stdio: 'inherit', shell: true, windowsHide: true });
  return r.status === 0;
}
if (depsOk()) say('✓ 已经装好');
else if (checkOnly) { say('✗ 还没装'); todo.push('渲染程序和识别程序'); }
else {
  const tries = mirrorFirst ? [['国内镜像', [`--registry=${NPM_MIRROR}`]], ['官方地址', []]] : [['官方地址', []], ['国内镜像', [`--registry=${NPM_MIRROR}`]]];
  let ok = false;
  for (const [label, extra] of tries) {
    say(`从${label}安装（第一次要几分钟）……`);
    if (npm(extra) && depsOk()) { ok = true; break; }
    say(`  ${label}没装成。`);
  }
  if (ok) say('✓ 装好了');
  else { say('✗ 没装成。多半是网络问题：换个网络或开代理后再运行一次。'); todo.push('渲染程序和识别程序（npm install 没成功）'); }
}

// ---- 3. 渲染用的浏览器 ----
head(3, '渲染用的浏览器');
const browserOk = () => findStateDir(loadConfig()).ok;
if (browserOk()) say(`✓ 已经有了（${findStateDir(loadConfig()).from}）`);
else if (checkOnly) { say('✗ 还没装'); todo.push('渲染用的浏览器'); }
else if (!fs.existsSync(OPENEDIT_PKG)) { say('… 跳过：要先装好上一步'); }
else {
  process.env.OPENEDIT_STATE_DIR = STATE_DIR;
  let done = false;
  try {
    // 用 OpenEdit 自己的安装函数（它会核对文件大小和校验值），只是把下载地址换成可选的镜像
    const mod = await import(pathToFileURL(path.join(OPENEDIT_PKG, 'cli', 'dist', 'render', 'browser.js')).href);
    const bases = mirrorFirst ? [['国内镜像', CHROME_MIRROR], ['官方地址', CHROME_OFFICIAL]] : [['官方地址', CHROME_OFFICIAL], ['国内镜像', CHROME_MIRROR]];
    for (const [label, base] of bases) {
      try {
        say(`从${label}下载（约 120 MB）……`);
        await mod.installChrome({
          log: (l) => { if (/%|installed|checksum/.test(l)) say('  ' + l.replace(/^browser: /, '')); },
          fetchImpl: (url, o) => fetch(String(url).replace(CHROME_OFFICIAL, base), o),
        });
        done = true; break;
      } catch (e) { say(`  ${label}没成功（${String(e.message).split('\n')[0].slice(0, 120)}）`); }
    }
  } catch (e) { say(`  安装函数调用失败（${e.message}），改用命令行安装……`); }
  if (!done) {
    const r = spawnSync(process.execPath, [path.join(OPENEDIT_PKG, 'cli', 'dist', 'cli.js'), 'install-browser'], { stdio: 'inherit', env: { ...process.env, OPENEDIT_STATE_DIR: STATE_DIR }, windowsHide: true });
    done = r.status === 0 && browserOk();
  }
  if (done) { saveConfig({ chromePath: null }); say('✓ 装好了'); }
  else {
    // 退路：用电脑上已有的 Chrome 或 Edge
    const sys = systemBrowsers();
    if (sys.length) {
      saveConfig({ chromePath: sys[0] });
      say(`△ 固定版本的浏览器没下载下来，先用电脑上已有的：${sys[0]}\n  能出片，但不同版本的浏览器画面可能有细微差别。网络好的时候再运行一次本脚本，会换回固定版本。`);
    } else { say('✗ 没下载下来，电脑上也没找到 Chrome 或 Edge。'); todo.push('渲染用的浏览器（装一个 Chrome 后再运行一次）'); }
  }
}

// ---- 4. 识别模型 ----
head(4, '识别模型（给本人录音打时间轴用）');
if (modelReady() || findModel().ok) say('✓ 已经有了');
else if (checkOnly) { say('✗ 还没下载'); todo.push('识别模型'); }
else {
  try {
    const r = await getModel({ file: opt('--model-file'), dir: opt('--model-dir'), mirrorFirst, log: say });
    say(`✓ 装好了（来源：${r.from}）`);
  } catch (e) { say(`✗ ${e.message}`); todo.push('识别模型'); }
}
// 播客精编还要三个小模型（人声检测、说话人切分、声纹，合计约 45 MB）
const { podcastModelsReady } = await import('./lib/podcast.mjs');
if (podcastModelsReady()) say('✓ 播客精编用的模型已经有了');
else if (checkOnly) { say('✗ 播客精编用的模型还没下载'); todo.push('播客精编用的模型'); }
else {
  say('下载播客精编用的模型（约 45 MB）……');
  try {
    const { getPodcastModels } = await import('./get-model.mjs');
    await getPodcastModels({ dir: opt('--podcast-model-dir'), mirrorFirst, log: say });
    say('✓ 装好了');
  } catch (e) { say(`✗ ${e.message}`); todo.push('播客精编用的模型（只做口播视频的话可以不管）'); }
}

// ---- 5. ffmpeg ----
head(5, 'ffmpeg（转录音格式、合成视频）');
let ff = findFfmpeg();
if (ff.ok) say(`✓ ${ff.version}（${ff.from}）`);
else if (checkOnly) { say('✗ 没找到'); todo.push('ffmpeg'); }
else if (mirrorSupported() || (process.platform === 'win32' && fs.existsSync(OPENEDIT_PKG))) {
  say('没找到能用的 ffmpeg，下载一份放进技能目录（不动系统）……');
  // 先走国内镜像 npmmirror（gyan.dev 的 ffmpeg 6.0，按 sha256 核对，国内不开代理也能下）
  if (mirrorSupported()) {
    try { await getFfmpegFromMirror({ log: say }); } catch (e) { say(`  国内镜像没成功（${e.message}）`); }
    ff = findFfmpeg();
  }
  // 退路（Windows）：OpenEdit 自带的下载，从 gyan.dev（国外）下。要加 --force：PATH 里有跑不起来的 ffmpeg（比如 winget 留下的 0 字节文件）时，不加它会以为"已经装了"（2026-11-15 实测）
  if (!ff.ok && process.platform === 'win32' && fs.existsSync(OPENEDIT_PKG)) {
    say('  改从 gyan.dev 下载（约 100 MB）……');
    spawnSync(process.execPath, [path.join(OPENEDIT_PKG, 'cli', 'dist', 'cli.js'), 'install-ffmpeg', '--force'], { stdio: 'inherit', env: { ...process.env, OPENEDIT_STATE_DIR: STATE_DIR }, windowsHide: true });
    ff = findFfmpeg();
  }
  if (ff.ok) say(`✓ 装好了：${ff.version}`);
  else {
    say(process.platform === 'win32' ? '✗ 没装成。可以自己装：在终端运行 winget install Gyan.FFmpeg，装完重开终端。' : '✗ 没装成。可以自己装：brew install ffmpeg（没有 brew 先到 https://brew.sh 装）');
    todo.push(process.platform === 'win32' ? 'ffmpeg（winget install Gyan.FFmpeg）' : 'ffmpeg（brew install ffmpeg）');
  }
} else {
  say(process.platform === 'darwin'
    ? '✗ 没找到 ffmpeg。在终端运行：brew install ffmpeg（没有 brew 的话先到 https://brew.sh 装）'
    : '✗ 没找到 ffmpeg。用系统的包管理器安装 ffmpeg 后再运行一次。');
  todo.push('ffmpeg');
}

// ---- 收尾：跑一次完整自检 ----
say('\n—— 自检 ——');
const doc = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'doctor.mjs')], { stdio: 'inherit', windowsHide: true });
if (todo.length) say(`\n还有 ${todo.length} 项要处理：\n${todo.map((t) => '  · ' + t).join('\n')}\n处理完再运行一次：node tools/setup.mjs`);
process.exit(doc.status === 0 && !todo.length ? 0 : 1);
