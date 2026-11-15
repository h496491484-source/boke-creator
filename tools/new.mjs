#!/usr/bin/env node
// 开一条新作品：建作品目录，放好表达卡和口播稿的空白底稿。
//
//   node tools/new.mjs <作品目录> [--title 标题] [--brand 署名] [--accent #d9b566]
//
// 已经有文件的目录不会被覆盖：缺哪个补哪个。

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d = '') => { const i = args.indexOf(n); return i >= 0 ? (args[i + 1] ?? d) : d; };
const target = args.find((a, i) => !a.startsWith('--') && !['--title', '--brand', '--accent'].includes(args[i - 1]));
if (!target) { console.error('用法: node tools/new.mjs <作品目录> [--title 标题] [--brand 署名] [--accent #d9b566]'); process.exit(2); }
const work = path.resolve(target);
const title = opt('--title'), brand = opt('--brand'), accent = opt('--accent');
if (accent && !/^#[0-9a-fA-F]{6}$/.test(accent)) { console.error(`强调色「${accent}」看不懂。写成 # 加 6 位十六进制，比如 #d9b566`); process.exit(2); }
fs.mkdirSync(work, { recursive: true });

const made = [];
const put = (name, text) => {
  const f = path.join(work, name);
  if (fs.existsSync(f)) return;
  fs.writeFileSync(f, text, 'utf8'); made.push(name);
};

put('表达卡.md', `# 表达卡

> 只写本人明确说过的话。Agent 推断出来的内容一律标"（待确认）"，本人点头后再去掉标记。

## 说给谁听
（一类具体的人，和他们现在卡在哪里）

## 我想说的一件事
（一句话。讲不完说明题目还太大）

## 依据
（亲身经历、见过的具体事例、数字。每条写清时间、地点、发生了什么）
-

## 希望对方看完做什么
（一个今天就能做的小动作）

## 不想被说成什么
（容易被改歪的地方：哪些话不是我的意思）

## 确认记录
- 本人确认：（未确认）
`);

put('口播稿.txt', `// 只改这一个文件。写法见技能目录 references/稿子写法.md。
// 字幕按标点切开，屏幕上不显示标点；一条字幕最多 30 个字。
标题：${title || '（不超过 8 个字）'}
署名：${brand || '（你的名字或账号名）'}
${accent ? `强调色：${accent}\n` : ''}---
# 第一个小标题
（正文。一行一句，句末带标点。）
`);

console.log(`作品目录：${work}`);
console.log(made.length ? `新建了：${made.join('、')}` : '文件都在，没有改动。');
console.log('下一步：先和本人把 表达卡.md 聊清楚并确认，再写 口播稿.txt。');
