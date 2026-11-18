#!/usr/bin/env node
// 自检。每一项都真的执行一次，不只看文件在不在。
//
//   node tools/doctor.mjs
//
// 全部通过退出码 0；有必需项没过退出码 1。缺东西时运行 node tools/setup.mjs，它会把能装的都装上。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CONFIG_FILE, loadConfig, saveConfig, findFfmpeg, tryRun, platformName } from './lib/env.mjs';
import { findSherpa, findModel } from './asr.mjs';

const rows = [];
const add = (name, status, detail, fix) => rows.push({ name, status, detail, fix });
const cfg = loadConfig();
const SETUP = '运行：node tools/setup.mjs';

// 1. Node
const major = Number(process.versions.node.split('.')[0]);
add('Node', major >= 18 ? '通过' : '未通过', `v${process.versions.node}（${platformName()}）`, major >= 18 ? null : '请安装 Node 18 或更新的版本：https://nodejs.org');

// 2. ffmpeg + ffprobe
const ff = findFfmpeg(cfg);
if (ff.ok) {
  add('ffmpeg', '通过', `${ff.version}，来自${ff.from}`);
  // 找到的位置记下来，下次不用再挨个试
  if (ff.dir && cfg.ffmpegDir !== ff.dir && !process.env.FFMPEG_DIR && !ff.dir.startsWith(ROOT)) saveConfig({ ffmpegDir: ff.dir });
} else {
  add('ffmpeg', '未通过', ff.tried.length ? ff.tried.join('；') : '哪里都没找到', `${SETUP}（会下载一份放进技能目录）`);
}

// 3. 识别程序和模型
const sh = findSherpa(cfg);
const shLoads = sh.ok && tryRun(process.execPath, ['-e', `require(${JSON.stringify(sh.pkg)})`]);
add('识别程序', shLoads ? '通过' : '未通过', shLoads ? `sherpa-onnx-node ${JSON.parse(fs.readFileSync(path.join(sh.pkg, 'package.json'), 'utf8')).version}` : (sh.ok ? '文件在，但加载不起来' : '没装'), shLoads ? null : SETUP);
const md = findModel(cfg);
add('识别模型', md.ok ? '通过' : '未通过', md.ok ? `SenseVoice，在 ${md.dir}` : '没下载', md.ok ? null : SETUP);

// 4. 播客精编用的模型和配乐
const { PODCAST_MODELS, pmReady, MUSIC } = await import('./lib/podcast.mjs');
const pmMiss = Object.keys(PODCAST_MODELS).filter((k) => !pmReady(k));
add('播客模型', pmMiss.length ? '未通过' : '通过', pmMiss.length ? `缺：${pmMiss.map((k) => PODCAST_MODELS[k].what).join('、')}` : '人声检测、说话人切分、声纹', pmMiss.length ? SETUP : null);
add('配乐', fs.existsSync(MUSIC) ? '通过' : '提示', fs.existsSync(MUSIC) ? 'Aurora（CC0）' : '技能包里的配乐文件不在，精编版会没有片头片尾音乐', fs.existsSync(MUSIC) ? null : '重新解压技能包');

// ---- 输出 ----
const w = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((k, ch) => k + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));
for (const r of rows) {
  console.log(`${w(r.status, 8)}${w(r.name, 12)}${r.detail}`);
  if (r.fix) console.log(`${' '.repeat(20)}→ ${r.fix}`);
}
const failed = rows.filter((r) => r.status === '未通过');
console.log(failed.length
  ? `\n有 ${failed.length} 项没过：${failed.map((r) => r.name).join('、')}。按箭头后面的办法处理，再跑一次自检。`
  : '\n自检通过，可以剪播客：node tools/podcast/new.mjs <节目目录> <录音文件>');
if (fs.existsSync(CONFIG_FILE)) console.log(`本机路径记在 ${CONFIG_FILE}`);
process.exit(failed.length ? 1 : 0);
