#!/usr/bin/env node
// 一条命令出片：稿子检查 → 生成页面 → 渲染 → 合音 → 成片检查。
//
//   node tools/make.mjs <作品目录>              出成片（改过的地方只重渲那几秒）
//   node tools/make.mjs <作品目录> --preview    先出开头 12 秒的低清预览
//   node tools/make.mjs <作品目录> --full       不管有没有旧片段，整片重渲
//   node tools/make.mjs <作品目录> --demo-voice 没有音轨时，用电脑自带朗读生成一条（只给示例用）
//
// 作品目录里要有：口播稿.txt 和 voice.wav（本人录音或配音）。
// timing.json（逐字时间）有就用；没有就自动识别录音、对到稿子上（asr.mjs + align.mjs）。
// 产出：成片.mp4（上一版改名为 成片_上一版.mp4）、检查报告.json、状态.json；中间文件都在 制作文件/ 里。
// 机器检查通过不等于验收：成片要本人从头到尾看一遍。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, findFfmpeg, findOpenedit, findStateDir, childEnv, ffBin } from './lib/env.mjs';
import { parseScript } from './lib/script.mjs';
import { makeDemoVoice } from './demo-voice.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const workArg = args.find((a) => !a.startsWith('--'));
const PREVIEW_SECONDS = 12;

const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
if (!workArg) die('用法: node tools/make.mjs <作品目录> [--preview] [--full] [--demo-voice]', 2);
const work = path.resolve(workArg);
const scriptFile = path.join(work, '口播稿.txt');
if (!fs.existsSync(scriptFile)) die(`${work} 里没有 口播稿.txt。`);

// ---- 环境 ----
const ffmpeg = findFfmpeg(), openedit = findOpenedit(), state = findStateDir();
const missing = [!ffmpeg.ok && 'ffmpeg', !openedit.ok && 'OpenEdit', !state.ok && '渲染浏览器'].filter(Boolean);
if (missing.length) die(`环境没准备好：${missing.join('、')}。先运行 node tools/setup.mjs。`);
const env = childEnv({ ffmpeg, state });

const t0 = Date.now();
const secs = (from) => ((Date.now() - from) / 1000).toFixed(1);
function step(label, cmd, cmdArgs, { show = false } = {}) {
  const t = Date.now();
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.error || r.status !== 0) {
    console.log(`✗ ${label}（${secs(t)} 秒）`);
    if (out) console.log(out);
    if (r.error) console.log(r.error.message);
    return { ok: false, out };
  }
  console.log(`✓ ${label}（${secs(t)} 秒）`);
  if (show && out) console.log(out.split(/\r?\n/).map((l) => '  ' + l).join('\n'));
  return { ok: true, out };
}
const node = (label, file, a, o) => step(label, process.execPath, [file, ...a], o);
const sha = (file) => (fs.existsSync(file) ? crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex') : null);
const readJson = (file, def) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; } };

// ---- 稿子头部：标题、模板 ----
const { meta } = parseScript(fs.readFileSync(scriptFile, 'utf8'));
const tplName = meta.template || '黑金水墨';
const tplDir = path.join(ROOT, 'template', tplName);
if (!fs.existsSync(path.join(tplDir, 'style.css'))) {
  const have = fs.readdirSync(path.join(ROOT, 'template')).filter((n) => fs.existsSync(path.join(ROOT, 'template', n, 'style.css')));
  die(`没有叫「${tplName}」的模板。现有：${have.join('、')}。`);
}

const buildDir = path.join(work, '制作文件');
const pageDir = path.join(buildDir, 'page');
fs.mkdirSync(pageDir, { recursive: true });
const timelineFile = path.join(buildDir, 'timeline.json');
const builtFile = path.join(pageDir, 'timeline.built.json');
const picture = path.join(buildDir, 'picture.mp4');
const makeStateFile = path.join(buildDir, 'make-state.json');
const makeState = readJson(makeStateFile, {});
const saveState = (patch) => { Object.assign(makeState, patch); fs.writeFileSync(makeStateFile, JSON.stringify(makeState) + '\n', 'utf8'); };

// ---- 手机录音（m4a、mp3 等）先转成 voice.wav；原文件不动 ----
const voiceFile = path.join(work, meta.audio || 'voice.wav');
{
  const AUDIO = /\.(m4a|mp3|aac|flac|ogg|opus|wma|amr|mp4|mov|wav)$/i;
  const SKIP = /^(voice|voice_原始|预览|成片.*)\./;
  const sources = fs.readdirSync(work).filter((n) => AUDIO.test(n) && !SKIP.test(n));
  const have = fs.existsSync(voiceFile);
  if (sources.length > 1 && !have) die(`作品目录里有 ${sources.length} 个录音（${sources.join('、')}），不知道用哪个。只留一个，或在稿子头部写"配音：文件名"。`);
  if (sources.length === 1) {
    const src = path.join(work, sources[0]), srcSha = sha(src);
    // voice.wav 不在，或者它是上次从这个录音转出来的、而录音已经换了，才转；自己放的 voice.wav 不碰
    if (!have || (makeState.srcAudio && makeState.srcAudio !== srcSha)) {
      if (!step(`把 ${sources[0]} 转成 voice.wav`, ffBin(ffmpeg, 'ffmpeg'), ['-y', '-v', 'error', '-i', src, '-vn', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', voiceFile]).ok) die('\n录音转换失败。');
      fs.rmSync(path.join(work, 'voice_原始.wav'), { force: true }); // 上一份录音剪之前的备份，已经没用了
      saveState({ srcAudio: srcSha });
    }
  }
}

// ---- 示例音轨 ----
if (!fs.existsSync(voiceFile)) {
  if (!flag('--demo-voice')) die(`找不到音轨 ${voiceFile}。\n做自己的片子：把录音或配音放到这里。\n只是跑示例：加上 --demo-voice，用电脑自带朗读生成一条。`);
  const t = Date.now();
  try {
    const r = makeDemoVoice(work);
    console.log(`✓ 生成示例音轨（${secs(t)} 秒）：${r.seconds} 秒，朗读声音「${r.voice}」，只用来跑通流程`);
  } catch (e) { die(`✗ 生成示例音轨：${e.message}`); }
}

// ---- 0. 本人录音：没有时间轴就自己打轴（识别 → 对到稿子上） ----
// 时间轴是别处给的（配音服务、示例朗读）就不动它；是这里打出来的，每次都按当前稿子重新对一遍，
// 这样改了稿子里的错别字不用管时间轴，改得和录音对不上了也会当场指出来。
const timingFile = path.join(work, meta.timing || 'timing.json');
const asrFile = path.join(work, '识别结果.json');
if (!fs.existsSync(timingFile) || fs.existsSync(asrFile)) {
  if (meta.timing && meta.timing !== 'timing.json') die(`稿子头部的"时间轴：${meta.timing}"找不到。删掉这一行，就会按录音自动打轴。`);
  const voiceNow = sha(voiceFile);
  if (!fs.existsSync(asrFile) || makeState.asrVoice !== voiceNow) {
    if (!node('识别录音（只取每个字的时间）', path.join(here, 'asr.mjs'), [work]).ok) die('\n录音没识别出来。先运行 node tools/setup.mjs。');
    saveState({ asrVoice: voiceNow });
  }
  if (!node('把稿子对到录音上', path.join(here, 'align.mjs'), [work, '--asr', asrFile], { show: true }).ok) {
    die('\n稿子和录音没对上，没有继续出片。三种办法：\n  1. 录音里多出来的口头语、重复和长停顿，可以剪掉：node tools/clean.mjs <作品目录>（先看它列的清单，剪完要自己听一遍）\n  2. 重录有问题的那一句\n  3. 把稿子改成实际说的话');
  }
}

// ---- 1. 稿子检查，算出时间线 ----
const check = () => node('检查稿子并对齐声音', path.join(here, 'storyboard.mjs'), [scriptFile, '--out', timelineFile], { show: true });
let checked = check();
// 只差"超过 3 秒没有画面变化"这一条：可以自动补节点
const onlyGap = (out) => /没有画面变化/.test(out) && !out.split(/\r?\n/).some((l) => l.startsWith('错误') && !/没有画面变化|^错误\s{3}/.test(l));
if (!checked.ok && onlyGap(checked.out)) {
  if (!flag('--auto-beats')) {
    die('\n有的地方超过 3 秒画面没变化。可以自动补画面节点：\n  node tools/beats.mjs <作品目录> --plan    先看打算补哪里、写什么字\n  node tools/beats.mjs <作品目录> --apply   确认后写进稿子\n或者出片时加 --auto-beats，直接用从原句截的词补上。');
  }
  if (!node('自动补画面节点', path.join(here, 'beats.mjs'), [work], { show: true }).ok) die('\n画面节点没补全，看上面的提示。');
  checked = check();
}
if (!checked.ok) die('\n稿子没通过检查。按上面的提示改 口播稿.txt，再运行一次。');

// ---- 2. 生成页面 ----
const oldBuilt = sha(builtFile);
if (!node('生成画面页面', path.join(here, 'build.mjs'), [timelineFile, '--out', pageDir, '--template', tplDir]).ok) die('\n页面没生成出来。');
const built = readJson(path.join(pageDir, 'build-result.json'), {});
const D = built.duration, fps = built.fps ?? 30;
const page = path.join(pageDir, 'index.html');

// ---- 预览：只出开头十几秒的低清版 ----
if (flag('--preview')) {
  const len = Math.min(PREVIEW_SECONDS, D);
  const draft = path.join(buildDir, 'preview.draft.mp4');
  const out = path.join(work, '预览.mp4');
  if (!node(`渲染开头 ${len} 秒的低清预览`, openedit.cli, ['render', page, '--out', draft, '--draft', '--fps', String(fps), '--duration', String(len), '--no-text-floor']).ok) die('\n预览没渲染出来。');
  if (!step('合上声音', ffBin(ffmpeg, 'ffmpeg'), ['-y', '-v', 'error', '-i', draft, '-i', path.join(pageDir, 'voice.wav'), '-t', String(len), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', out]).ok) die('\n预览合音失败。');
  writeStatus({ kind: '预览', file: '预览.mp4', render: `开头 ${len} 秒，低清` });
  console.log(`\n预览已出：${out}（共用 ${secs(t0)} 秒）\n请看一遍：风格、字幕、节奏对不对。没问题再出成片。`);
  process.exit(0);
}

// ---- 3. 渲染：能局部就局部 ----
const cacheOk = fs.existsSync(picture) && fs.existsSync(picture + '.render') && makeState.rendered === oldBuilt && makeState.template === tplName;
const base = ['render', page, '--out', picture, '--fps', String(fps), '--duration', String(D), '--crf', '18', '--preset', 'veryfast', '--no-text-floor'];
const voiceSha = sha(path.join(pageDir, 'voice.wav'));
let renderNote;
if (!flag('--full') && cacheOk && built.patch === 'none') {
  if (makeState.voice === voiceSha && fs.existsSync(path.join(work, '成片.mp4'))) {
    console.log(`\n稿子、声音、画面都和上一次一样，成片没有变：${path.join(work, '成片.mp4')}\n想强制重出，加 --full。`);
    process.exit(0);
  }
  renderNote = '画面没变，未重渲';
  console.log('✓ 画面和上次一样，不用重渲');
} else if (!flag('--full') && cacheOk && built.patch?.from != null) {
  renderNote = `只重渲 ${built.patch.from}–${built.patch.to} 秒`;
  if (!node(`渲染改动的部分（${built.patch.from}–${built.patch.to} 秒）`, openedit.cli, [...base, '--from', String(built.patch.from), '--to', String(built.patch.to)]).ok) die('\n渲染失败。');
} else {
  renderNote = '整片渲染';
  if (!node(`整片渲染（${D} 秒）`, openedit.cli, base).ok) die('\n渲染失败。');
}
saveState({ rendered: sha(builtFile), template: tplName, voice: voiceSha });

// ---- 4. 调平响度再合音 ----
// 手机录音音量忽大忽小，直接整体放大会爆音（实测真峰值到过 +1.2 dBFS）。
// 这里自己调到 -14 LUFS、峰值不超过 -1.5 dBFS，再让 OpenEdit 原样合上去。
const final = path.join(buildDir, 'final.mp4');
const leveled = path.join(buildDir, 'voice.leveled.wav');
if (!step('调平音量', ffBin(ffmpeg, 'ffmpeg'), ['-y', '-v', 'error', '-i', path.join(pageDir, 'voice.wav'), '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'pcm_s16le', leveled]).ok) die('\n音量调平失败。');
if (!node('合上声音', openedit.cli, ['mux-audio', '--video', picture, '--audio', leveled, '--out', final, '--no-loudnorm']).ok) die('\n合音失败。');

// ---- 5. 成片检查 ----
const reportFile = path.join(work, '检查报告.json');
const qc = node('成片机器检查', path.join(here, 'qc.mjs'), [final, '--json', reportFile], { show: true });
const report = readJson(reportFile, { results: [] });

// ---- 6. 交付 ----
const name = qc.ok ? '成片.mp4' : '成片_未通过检查.mp4';
const dest = path.join(work, name);
if (qc.ok && fs.existsSync(dest)) fs.renameSync(dest, path.join(work, '成片_上一版.mp4'));
fs.copyFileSync(final, dest);
if (qc.ok) fs.rmSync(path.join(work, '成片_未通过检查.mp4'), { force: true });
writeStatus({ kind: '成片', file: name, render: renderNote, qc: { passed: qc.ok, items: report.results } });

console.log(qc.ok
  ? `\n成片已出：${dest}（${D} 秒，${renderNote}，共用 ${secs(t0)} 秒）\n机器检查通过，但还不算验收：请从头到尾看一遍，对照表达卡确认意思没被改歪。`
  : `\n片子出来了，但机器检查没过：${dest}\n按上面"未通过"的几项处理后再运行一次。`);
process.exit(qc.ok ? 0 : 1);

// 状态文件：给人、给 Agent、给以后的工作台看"这条片子走到哪了"
function writeStatus(last) {
  const file = path.join(work, '状态.json');
  const old = readJson(file, {});
  fs.writeFileSync(file, JSON.stringify({
    version: 0,
    work: path.basename(work),
    title: meta.title ?? '',
    template: tplName,
    updated: new Date().toISOString(),
    duration: D,
    confirmed: old.confirmed ?? {},          // 本人确认过的步骤，由 Agent 在本人说"确认"后填，这里不动
    last: { ...last, seconds_spent: Number(secs(t0)) },
    history: [...(old.history ?? []), { at: new Date().toISOString(), kind: last.kind, render: last.render, passed: last.qc?.passed ?? null }].slice(-20),
  }, null, 2) + '\n', 'utf8');
}
