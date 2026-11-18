#!/usr/bin/env node
// 自检。每一项都真的执行一次，不只看文件在不在。
//
//   node tools/doctor.mjs
//
// 全部通过退出码 0；有必需项没过退出码 1。缺东西时运行 node tools/setup.mjs，它会把能装的都装上。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CONFIG_FILE, loadConfig, saveConfig, findFfmpeg, findOpenedit, findStateDir, tryRun, platformName } from './lib/env.mjs';
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
  // 找到的位置记下来，出片时不用再挨个试
  if (ff.dir && cfg.ffmpegDir !== ff.dir && !process.env.FFMPEG_DIR && !ff.dir.startsWith(ROOT)) saveConfig({ ffmpegDir: ff.dir });
} else {
  add('ffmpeg', '未通过', ff.tried.length ? ff.tried.join('；') : '哪里都没找到',
    process.platform === 'win32' ? `${SETUP}（会下载一份放进技能目录）` : '安装：brew install ffmpeg');
}

// 3. OpenEdit
const oe = findOpenedit(cfg);
add('渲染程序', oe.ok ? '通过' : '未通过', oe.ok ? `OpenEdit ${oe.version || '版本未知'}，来自${oe.from}` : (oe.tried.join('；') || '没找到'), oe.ok ? null : SETUP);

// 4. 渲染用的浏览器
const st = findStateDir(cfg);
add('渲染浏览器', st.ok ? (st.chrome ? '提示' : '通过') : '未通过',
  st.ok ? (st.chrome ? `用的是电脑上已有的浏览器：${st.chrome}（能出片；想换成固定版本就再运行一次 setup）` : `已下载，来自${st.from}`) : '还没下载',
  st.ok ? null : SETUP);

// 5. 模板
const tplRoot = path.join(ROOT, 'template');
const tpls = fs.existsSync(tplRoot) ? fs.readdirSync(tplRoot).filter((n) => fs.existsSync(path.join(tplRoot, n, 'style.css'))) : [];
add('模板', tpls.length ? '通过' : '未通过', tpls.length ? tpls.join('、') : 'template 目录里没有可用模板', tpls.length ? null : '重新解压技能包');

// 6. 识别程序和模型（用本人录音做片子时，靠它们给每个字定时间）
const sh = findSherpa(cfg);
const shLoads = sh.ok && tryRun(process.execPath, ['-e', `require(${JSON.stringify(sh.pkg)})`]);
add('识别程序', shLoads ? '通过' : '未通过', shLoads ? `sherpa-onnx-node ${JSON.parse(fs.readFileSync(path.join(sh.pkg, 'package.json'), 'utf8')).version}` : (sh.ok ? '文件在，但加载不起来' : '没装'), shLoads ? null : SETUP);
const md = findModel(cfg);
add('识别模型', md.ok ? '通过' : '未通过', md.ok ? `SenseVoice，在 ${md.dir}` : '没下载', md.ok ? null : SETUP);

// 6b. 播客精编用的模型（只做口播视频用不到，所以缺了只算"提示"）
const { PODCAST_MODELS, pmReady, MUSIC } = await import('./lib/podcast.mjs');
const pmMiss = Object.keys(PODCAST_MODELS).filter((k) => !pmReady(k));
add('播客模型', pmMiss.length ? '提示' : '通过', pmMiss.length ? `缺：${pmMiss.map((k) => PODCAST_MODELS[k].what).join('、')}。只做口播视频不受影响` : '人声检测、说话人切分、声纹', pmMiss.length ? SETUP : null);
add('播客配乐', fs.existsSync(MUSIC) ? '通过' : '提示', fs.existsSync(MUSIC) ? 'Aurora（CC0）' : '技能包里的配乐文件不在，精编版会没有片头片尾音乐', fs.existsSync(MUSIC) ? null : '重新解压技能包');

// 7. 示例用的朗读声音（只有跑示例才需要，不影响做自己的片子）
let voice = null;
if (process.platform === 'win32') {
  voice = tryRun('powershell', ['-NoProfile', '-Command',
    "Add-Type -AssemblyName System.Speech; $v=(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1; if ($v) { $v.VoiceInfo.Name } else { exit 1 }"]);
} else if (process.platform === 'darwin') {
  const out = tryRun('sh', ['-c', "say -v '?' | grep -m1 zh_CN"]);
  voice = out ? out.split(/\s+/)[0] : null;
}
add('示例朗读声音', voice ? '通过' : '提示', voice ? voice : '没找到中文朗读声音，示例跑不了；做自己的片子不受影响',
  voice ? null : (process.platform === 'win32' ? '设置 → 时间和语言 → 语音 → 添加中文语音' : '系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音，下载"婷婷"'));

// ---- 输出 ----
const w = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((k, ch) => k + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));
for (const r of rows) {
  console.log(`${w(r.status, 8)}${w(r.name, 14)}${r.detail}`);
  if (r.fix) console.log(`${' '.repeat(22)}→ ${r.fix}`);
}
const failed = rows.filter((r) => r.status === '未通过');
console.log(failed.length
  ? `\n有 ${failed.length} 项没过：${failed.map((r) => r.name).join('、')}。按箭头后面的办法处理，再跑一次自检。`
  : '\n自检通过。剪播客：node tools/podcast/new.mjs <节目目录> <录音文件>；口播视频可以先跑一遍示例：node tools/make.mjs examples/示例_只说一件事 --demo-voice');
if (fs.existsSync(CONFIG_FILE)) console.log(`本机路径记在 ${CONFIG_FILE}`);
process.exit(failed.length ? 1 : 0);
