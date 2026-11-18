#!/usr/bin/env node
// 出节目简介草稿：标题、简介正文（编排方案.json 的 intro，由 Agent 写）、精确到每个小话题的时间轴、配乐署名、还没确认的事。
//
//   node tools/podcast/notes.mjs <节目目录>     → 精编版/节目简介.md
//
// 时间轴按精编版里的真实位置算（每个小话题第一句在成品里的时间），可以直接贴到小宇宙等平台。

import fs from 'node:fs';
import path from 'node:path';
import { episode, mustExist, loadFull, readJson, readInfo, infoBlank, fmt, MUSIC } from '../lib/podcast.mjs';
import { loadShow } from '../lib/show.mjs';

const dir = process.argv[2];
if (!dir) { console.error('用法: node tools/podcast/notes.mjs <节目目录>'); process.exit(2); }
mustExist(dir);
const e = episode(dir);
const edl = readJson(path.join(e.out, '剪辑表.json'), null);
const plan = readJson(e.plan, null);
if (!edl || !plan) { console.error('先剪出精编版：node tools/podcast/build.mjs <节目目录>'); process.exit(1); }
const full = loadFull(e);
const byId = new Map(full.map((s) => [s.id, s]));
const info = readInfo(e);
const clips = edl.items.filter((x) => x.kind === 'clip');

const lines = [];
const chapters = fs.readFileSync(path.join(e.out, '章节目录.txt'), 'utf8').trim().split('\n');
for (const sec of plan.sections) {
  const first = clips.find((c) => c.section === sec.name);
  if (!first) continue;
  if (sec.kind === 'hook') { lines.push(`00:00 ${sec.name}`); continue; }
  const head = chapters.find((l) => l.endsWith(` ${sec.name}`))?.split(' ')[0] ?? fmt(first.out[0]);
  lines.push('', `**${head} ${sec.name}**`);
  if (sec.parts.length < 2) continue;
  for (const p of sec.parts) {
    const s = byId.get(p.from);
    const c = clips.find((c) => c.section === sec.name && c.src[1] > s.start && c.src[0] < s.end);
    if (c) lines.push(`- ${fmt(c.out[0] + Math.max(0, s.start - c.src[0]))} ${p.label}`);
  }
}

const todo = [];
if (infoBlank(info['录音是否完整']) || /不确定|否|不是|没/.test(info['录音是否完整'] ?? '')) todo.push('录音是否完整还没确认：确认前不要写"共录了多久"之类的话');
if (infoBlank(info['本期主题']) || /不确定/.test(info['本期主题'] ?? '')) todo.push('本期主题的原话还没确认');
const solo = /单人|一个人|独白|^1$|^一$/.test((info['嘉宾'] ?? '').trim());
const skipped = readJson(e.state, {}).confirmed?.['认人']?.skipped;
if (!solo && (infoBlank(info['嘉宾是否同意']) || /不确定|否|没/.test(info['嘉宾是否同意'] ?? ''))) todo.push('参与者是否同意剪辑发布还没确认');
const names = [...new Set(full.map((s) => s.speaker).filter(Boolean))];
const named = new Set(full.filter((s) => s.name).map((s) => s.speaker));
if (!solo && !skipped && names.length > 1 && named.size < names.length) todo.push(`说话人还有 ${names.length - named.size} 个编号没对上人（说话人.md）：简介里提到具体的人之前先确认`);

const md = [`# 节目简介（草稿）`, '', `**标题**：${plan.title ?? '（待定）'}`, ''];
if (!infoBlank(info['节目名'])) md.push(`**节目**：${info['节目名']}`, '');
md.push(...(plan.intro?.length ? plan.intro.flatMap((p) => [p, '']) : ['（简介正文待写：在 编排方案.json 里加 intro，一段一个字符串）', '']));
md.push('## 时间轴', '', ...lines, '');
const extra = [];
const show = loadShow(e);
if (edl.music?.length && (edl.musicFile ?? 'default') === 'default' && fs.existsSync(MUSIC)) extra.push('配乐：Aurora by Trex0n（CC0，来自 OpenGameArt）');
else if (edl.music?.length) {
  const credit = show?.get('配乐署名');
  if (credit) extra.push(`配乐：${credit}`);
  else todo.push(`配乐用的是节目自己的 ${edl.musicFile}，节目档案里没写"配乐署名"：确认有授权，需要署名的补上`);
}
if (extra.length) md.push('## 其他', '', ...extra.map((x) => `- ${x}`), '');
if (todo.length) md.push('## 发布前要确认（发布时删掉这一节）', '', ...todo.map((x) => `- ${x}`), '');
fs.writeFileSync(path.join(e.out, '节目简介.md'), md.join('\n'), 'utf8');

// 给主理人的反馈表：和精编版一起发过去，收回来的意见就是改编排、改技能的依据
const len = fmt(edl.length ?? edl.voiceEnd + 11), orig = fmt(full.at(-1).end);
fs.writeFileSync(path.join(e.out, '主理人反馈表.md'), `# 精编版反馈表

节目：${info['节目名'] && !infoBlank(info['节目名']) ? info['节目名'] : path.basename(e.work)}　标题：${plan.title ?? '（待定）'}
原始录音 ${orig}，精编版 ${len}。一起发给你的还有：节目简介.md（带时间轴）、编排方案.md（留了什么、删了什么、为什么）${fs.existsSync(e.rollcall) ? '、声音点名.mp3（每个说话人约 10 秒）' : ''}。

请听完精编版再填。说不清的地方，直接写时间点（比如"12:30 那句"）就行。

## 1. 剪辑

- 删掉的内容里，有没有想留下的？（看 编排方案.md 的删减清单，写句子编号或原位置）
- 留下的内容里，有没有该删的？（写精编版里的时间点）
- 板块怎么分、顺序、片头那几句，合不合适？

## 2. 听感

- 有没有听着别扭的剪口（吞字、突然断、语气接不上）？写时间点：
- 音量：各人大小是否差不多？有没有忽大忽小？
- 配乐：喜不喜欢？片头、过渡、片尾哪里多余或不够？

## 3. 省了多少事

- 这期如果你自己剪，大概要花多久？
- 用这个流程，你实际花了多久（回答问题、看方案、听成品）？
- 你会直接发布这一版，还是要自己再改？要改的话，主要改哪里？

## 4. 要你确认的事
${[
  infoBlank(info['本期主题']) || /不确定/.test(info['本期主题'] ?? '') ? '- 本期主题的原话是什么？' : '',
  infoBlank(info['录音是否完整']) || /不确定|否|不是|没/.test(info['录音是否完整'] ?? '') ? '- 给的录音是不是全部？有没有没给的部分？' : '',
  fs.existsSync(e.names) && !/^(1|一|单人)$/.test(info['嘉宾'] ?? '') ? '- 声音点名里每个编号是谁？（在 说话人.md 的"是谁"一栏填，或者直接告诉我们）' : '',
  '- 片头用的几句原话，说话的人知道并同意吗？',
].filter(Boolean).join('\n')}

## 5. 其他想说的
`, 'utf8');
console.log(`节目简介写到 精编版/节目简介.md（时间轴 ${lines.filter((l) => l.startsWith('-')).length} 个小话题）。${todo.length ? `还有 ${todo.length} 件事要确认。` : ''}`);
