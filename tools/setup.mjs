#!/usr/bin/env node
// 一键安装：把剪播客要用的东西装进技能目录，装完自动自检。可以反复运行，已经装好的会跳过。
//
//   node tools/setup.mjs                      默认先走国内源，不开代理也能装（约 330 MB）
//   node tools/setup.mjs --official           先走官方源（GitHub、npm 官方），国外网络用
//   node tools/setup.mjs --model-file <压缩包>  识别模型用现成的压缩包（.tar.bz2）
//   node tools/setup.mjs --check              只看缺什么，不安装
//   （--mirror 是旧写法，现在默认就是它）
//
// 装的东西和位置（都在技能目录里，不动系统）：
//   node_modules/        sherpa-onnx 本地识别程序，来自 npmmirror
//   models/sense-voice   识别模型（约 230 MB），来自魔搭
//   models/podcast       人声检测、说话人切分、声纹三个小模型（约 45 MB），来自魔搭
//   .state/ffmpeg        找不到能用的 ffmpeg 时才下载，来自 npmmirror
// 唯一要自己先装的是 Node 18 以上。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, findFfmpeg } from './lib/env.mjs';
import { findSherpa, findModel } from './asr.mjs';
import { getModel, modelReady } from './get-model.mjs';
import { getFfmpegFromMirror, mirrorSupported } from './get-ffmpeg.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const cnFirst = !flag('--official'), checkOnly = flag('--check');
const NPM_MIRROR = 'https://registry.npmmirror.com';

const todo = [];   // 没装成、需要人处理的
const say = (s) => console.log(s);
let step = 0;
const head = (s) => say(`\n[${++step}/5] ${s}`);

// ---- Node ----
head('Node');
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  say(`✗ Node 版本是 v${process.versions.node}，需要 18 或更新。到 https://nodejs.org 下载安装 LTS 版，再运行一次。`);
  process.exit(1);
}
say(`✓ Node v${process.versions.node}`);

// npm install。优先用和当前 node 放在一起的 npm（有的电脑 PATH 里没有 npm）。
// 每个源最多等 15 分钟；npm 自己的重试调小，连不上的源尽快换下一个。
function npm(extra) {
  const dir = path.dirname(process.execPath);
  const cli = [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((p) => fs.existsSync(p));
  const a = ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error', '--update-notifier=false', '--fetch-retries=1', '--fetch-timeout=120000', ...extra];
  const o = { cwd: ROOT, stdio: 'inherit', windowsHide: true, timeout: 15 * 60 * 1000 };
  const r = cli ? spawnSync(process.execPath, [cli, ...a], o) : spawnSync('npm', a, { ...o, shell: true });
  if (r.error?.code === 'ETIMEDOUT') say('  等了 15 分钟还没装完，放弃这个源。');
  else if (r.error) say(`  npm 跑不起来（${r.error.message}）。`);
  return r.status === 0;
}

// ---- 识别程序 ----
head('识别程序（在本机把录音转成文字）');
const sherpaOk = () => findSherpa({}).ok;
if (sherpaOk()) say('✓ 已经装好');
else if (checkOnly) { say('✗ 还没装'); todo.push('识别程序'); }
else {
  const sources = [['国内镜像 npmmirror', [`--registry=${NPM_MIRROR}`]], ['npm 官方源', []]];
  let ok = false;
  for (const [label, extra] of cnFirst ? sources : sources.reverse()) {
    say(`从${label}安装……`);
    if (npm(extra) && sherpaOk()) { ok = true; break; }
    say(`  ${label}没装成。`);
  }
  if (ok) say('✓ 装好了');
  else { say('✗ 没装成。多半是网络问题：换个网络后再运行一次。'); todo.push('识别程序（npm install 没成功）'); }
}

// ---- 识别模型 ----
head('识别模型（约 230 MB）');
if (modelReady() || findModel().ok) say('✓ 已经有了');
else if (checkOnly) { say('✗ 还没下载'); todo.push('识别模型'); }
else {
  try {
    const r = await getModel({ file: opt('--model-file'), dir: opt('--model-dir'), mirrorFirst: cnFirst, log: say });
    say(`✓ 装好了（来源：${r.from}）`);
  } catch (e) { say(`✗ ${e.message}`); todo.push('识别模型'); }
}

// ---- 播客精编的三个小模型（人声检测、说话人切分、声纹） ----
head('播客精编用的模型（约 45 MB）');
const { podcastModelsReady } = await import('./lib/podcast.mjs');
if (podcastModelsReady()) say('✓ 已经有了');
else if (checkOnly) { say('✗ 还没下载'); todo.push('播客精编用的模型'); }
else {
  try {
    const { getPodcastModels } = await import('./get-model.mjs');
    await getPodcastModels({ dir: opt('--podcast-model-dir'), mirrorFirst: cnFirst, log: say });
    say('✓ 装好了');
  } catch (e) { say(`✗ ${e.message}`); todo.push('播客精编用的模型'); }
}

// ---- ffmpeg ----
head('ffmpeg（读写音频）');
let ff = findFfmpeg();
if (ff.ok) say(`✓ ${ff.version}（${ff.from}）`);
else if (checkOnly) { say('✗ 没找到'); todo.push('ffmpeg'); }
else {
  if (mirrorSupported()) {
    // 国内镜像 npmmirror（gyan.dev 的 ffmpeg 6.0，按 sha256 核对，国内不开代理也能下）
    say('没找到能用的 ffmpeg，下载一份放进技能目录（不动系统）……');
    try { await getFfmpegFromMirror({ log: say }); } catch (e) { say(`  国内镜像没成功（${e.message}）`); }
    ff = findFfmpeg();
  }
  if (ff.ok) say(`✓ 装好了：${ff.version}`);
  else {
    const fix = process.platform === 'win32' ? 'winget install Gyan.FFmpeg' : process.platform === 'darwin' ? 'brew install ffmpeg' : '用系统的包管理器安装 ffmpeg';
    say(`✗ 没装成。可以自己装：${fix}，装完重开终端再运行一次。`);
    todo.push(`ffmpeg（${fix}）`);
  }
}

// ---- 收尾：跑一次完整自检 ----
say('\n—— 自检 ——');
const doc = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'doctor.mjs')], { stdio: 'inherit', windowsHide: true });
if (todo.length) say(`\n还有 ${todo.length} 项要处理：\n${todo.map((t) => '  · ' + t).join('\n')}\n处理完再运行一次：node tools/setup.mjs`);
process.exit(doc.status === 0 && !todo.length ? 0 : 1);
