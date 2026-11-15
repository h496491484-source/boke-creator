#!/usr/bin/env node
// 看一条作品走到哪一步了；记下本人确认过的步骤。Agent 每次开工先跑它，不靠聊天记忆。
//
//   node tools/status.mjs <作品目录>                       报告现状和下一步
//   node tools/status.mjs <作品目录> --confirm <步骤>       本人明确说"确认"之后才记
//   node tools/status.mjs <作品目录> --unconfirm <步骤>     改了稿子等情况下撤回确认
//   node tools/status.mjs <作品目录> --skip 表达卡          本人自带写好的稿子，不用从头聊
//   node tools/status.mjs <作品目录> --json                 给程序读
//
// 步骤名：表达卡、口播稿、录音、画面、成片。
// 确认记录里带着当时文件的指纹：文件后来改过，确认就自动失效，要重新确认。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseScript } from './lib/script.mjs';

const STEPS = ['表达卡', '口播稿', '录音', '画面', '成片'];
const SPEED = 4.8; // 自己念稿大约每秒几个字，只用来估时长
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const target = args.find((a, i) => !a.startsWith('--') && !['--confirm', '--unconfirm', '--skip'].includes(args[i - 1]));
if (!target) { console.error('用法: node tools/status.mjs <作品目录> [--confirm 步骤 | --unconfirm 步骤] [--json]'); process.exit(2); }
const work = path.resolve(target);
if (!fs.existsSync(work)) { console.error(`没有这个目录：${work}。新作品先运行 node tools/new.mjs <作品目录>`); process.exit(1); }

const f = (name) => path.join(work, name);
const has = (name) => fs.existsSync(f(name)) && fs.statSync(f(name)).size > 0;
const hash = (data) => crypto.createHash('sha1').update(data).digest('hex').slice(0, 12);
const fileSha = (name) => (has(name) ? hash(fs.readFileSync(f(name))) : null);
// "口播稿"确认的是要说的话：之后往稿子里加画面记号、关键词、改标题，都不算改稿，确认不失效
const spokenSha = () => {
  if (!has('口播稿.txt')) return null;
  const p = parseScript(fs.readFileSync(f('口播稿.txt'), 'utf8'));
  return hash(p.storyboard.segments.map((s) => s.say ?? s.text).join('\n'));
};
const sha = (name, step) => (step === '口播稿' ? spokenSha() : fileSha(name));
const readJson = (name, def) => { try { return JSON.parse(fs.readFileSync(f(name), 'utf8')); } catch { return def; } };
const stateFile = f('状态.json');
const state = readJson('状态.json', { version: 0, work: path.basename(work), confirmed: {} });
state.confirmed ??= {};

// 每一步确认的是哪个文件
const AUDIO = /\.(m4a|mp3|aac|flac|ogg|opus|wma|amr|wav)$/i;
const recording = fs.readdirSync(work).find((n) => AUDIO.test(n) && !/^(voice_原始|预览|成片)/.test(n) && n !== 'voice.wav');
const subject = { 表达卡: '表达卡.md', 口播稿: '口播稿.txt', 录音: has('voice.wav') ? 'voice.wav' : recording, 画面: '口播稿.txt', 成片: '成片.mp4' };

const cardText = has('表达卡.md') ? fs.readFileSync(f('表达卡.md'), 'utf8') : '';
const cardFilled = !!cardText && !/（一句话。讲不完说明题目还太大）/.test(cardText);
const scriptText = has('口播稿.txt') ? fs.readFileSync(f('口播稿.txt'), 'utf8') : '';
const scriptDraft = !scriptText || /（正文。一行一句|（不超过 8 个字）|（你的名字或账号名）/.test(scriptText);

const one = opt('--confirm') ?? opt('--unconfirm') ?? opt('--skip');
if (one) {
  if (!STEPS.includes(one)) { console.error(`不认识的步骤「${one}」。可用：${STEPS.join('、')}`); process.exit(2); }
  if (opt('--skip')) {
    // 只有表达卡可以跳过：本人带着写好的稿子来，不需要再从头聊
    if (one !== '表达卡') { console.error('只有「表达卡」可以跳过（本人自带写好的稿子时）。'); process.exit(2); }
    state.confirmed[one] = { at: new Date().toISOString(), skipped: true };
  } else if (opt('--confirm')) {
    if (!subject[one] || !has(subject[one])) { console.error(`「${one}」还没有可确认的东西（${subject[one] ?? '文件'} 不在）。`); process.exit(1); }
    if (one === '表达卡' && !cardFilled) { console.error('表达卡.md 还是空白底稿，先填好再确认。'); process.exit(1); }
    if ((one === '口播稿' || one === '画面') && scriptDraft) { console.error('口播稿.txt 还是空白底稿（标题、署名或正文没填），先写好再确认。'); process.exit(1); }
    state.confirmed[one] = { at: new Date().toISOString(), file: subject[one], sha: sha(subject[one], one) };
  } else delete state.confirmed[one];
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
  console.log(opt('--skip') ? '已记下：本人自带稿子，跳过表达卡。' : opt('--confirm') ? `已记下：本人确认了「${one}」。` : `已撤回「${one}」的确认。`);
}

// 确认是否还有效（文件没改过）
const ok = (step) => {
  const c = state.confirmed[step];
  if (!c) return false;
  if (typeof c === 'string' || c.skipped) return true; // 旧格式只有日期；跳过的不看文件
  return c.sha === sha(c.file, step);
};
const stale = (step) => state.confirmed[step] && !ok(step);

// 稿子概况
let script = null;
if (has('口播稿.txt')) {
  const p = parseScript(fs.readFileSync(f('口播稿.txt'), 'utf8'));
  const chars = p.storyboard.segments.reduce((n, s) => n + [...(s.say ?? s.text)].length, 0);
  const beats = p.storyboard.scenes.reduce((n, s) => n + s.beats.length, 0);
  const draft = scriptDraft;
  script = { chars, seconds: Math.round(chars / SPEED), captions: p.storyboard.segments.length, scenes: p.storyboard.scenes.length, beats, errors: p.errors, draft, title: p.meta.title ?? '' };
}
const report = readJson('检查报告.json', null);
const qcPassed = report ? !report.results?.some((r) => r.status === '未通过') : null;
const filmFresh = has('成片.mp4') && has('口播稿.txt') && fs.statSync(f('成片.mp4')).mtimeMs >= fs.statSync(f('口播稿.txt')).mtimeMs;

// 下一步
let next;
if (ok('表达卡')) next = null;
else if (!cardFilled) next = '第 1 步：和本人聊清楚想说什么，写 表达卡.md（本人自带写好的稿子，可以 --skip 表达卡）';
else next = '第 1 步：把 表达卡.md 逐条念给本人确认，确认后 --confirm 表达卡';
if (next) { /* 停在第 1 步 */ }
else if (!ok('表达卡')) next = '第 1 步：把 表达卡.md 逐条念给本人确认，确认后 --confirm 表达卡';
else if (!script || script.draft || !script.chars) next = '第 2 步：按表达卡写 口播稿.txt';
else if (script.errors.length) next = `第 2 步：口播稿有写法问题要先改（${script.errors[0]}）`;
else if (!ok('口播稿')) next = '第 2 步：请本人出声读一遍 口播稿.txt，改顺口，确认后 --confirm 口播稿';
else if (!subject.录音) next = '第 3 步：请本人照着口播稿录音，把录音文件放进作品目录';
else if (!has('timing.json')) next = '第 3 步：运行 make.mjs --preview，让它识别录音并对到稿子上';
else if (!has('预览.mp4') && !has('成片.mp4')) next = '第 4 步：配好画面节点后运行 make.mjs --preview 出预览';
else if (!ok('画面')) next = '第 4 步：请本人看 预览.mp4，对画面和字幕提意见，确认后 --confirm 画面';
else if (!has('成片.mp4') || !filmFresh) next = '第 5 步：运行 make.mjs 出成片';
else if (qcPassed === false) next = '第 5 步：成片的机器检查没过，按 检查报告.json 处理后重出';
else if (!ok('成片')) next = '第 5 步：请本人从头到尾看一遍 成片.mp4，对照表达卡确认意思没被改歪，确认后 --confirm 成片';
else next = '已完成。要改稿就直接改 口播稿.txt 再运行 make.mjs；要做下一条就 new.mjs 开新目录';

const out = {
  work, title: script?.title ?? '',
  files: { 表达卡: has('表达卡.md'), 口播稿: has('口播稿.txt'), 录音: subject.录音 ?? null, 时间轴: has('timing.json'), 预览: has('预览.mp4'), 成片: has('成片.mp4') },
  script, qcPassed,
  confirmed: Object.fromEntries(STEPS.map((s) => [s, ok(s) ? '已确认' : stale(s) ? '确认后文件改过，要重新确认' : '未确认'])),
  next,
};
if (args.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

const mark = (b) => (b ? '有' : '无');
console.log(`作品：${path.basename(work)}${out.title ? `（${out.title}）` : ''}`);
console.log(`文件：表达卡 ${mark(out.files.表达卡)}　口播稿 ${mark(out.files.口播稿)}　录音 ${out.files.录音 ?? '无'}　时间轴 ${mark(out.files.时间轴)}　预览 ${mark(out.files.预览)}　成片 ${mark(out.files.成片)}`);
if (script && !script.draft) {
  const tip = script.seconds < 45 ? '（偏短）' : script.seconds > 100 ? '（偏长，目标 60–90 秒）' : '';
  console.log(`稿子：${script.chars} 个字，念出来大约 ${script.seconds} 秒${tip}；${script.captions} 条字幕，${script.scenes} 个小标题，${script.beats} 个画面节点`);
}
if (qcPassed != null) console.log(`成片机器检查：${qcPassed ? '通过' : '未通过'}`);
console.log(`确认：${STEPS.map((s) => `${s} ${out.confirmed[s]}`).join('　')}`);
console.log(`下一步：${next}`);
