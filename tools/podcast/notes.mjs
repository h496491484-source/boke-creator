#!/usr/bin/env node
// 出节目简介草稿：标题、简介正文（编排方案.json 的 intro，由 Agent 写）、精确到每个小话题的时间轴、配乐署名、还没确认的事。
//
//   node tools/podcast/notes.mjs <节目目录>     → 精编版/节目简介.md
//
// 时间轴按精编版里的真实位置算（每个小话题第一句在成品里的时间），可以直接贴到小宇宙等平台。

import fs from 'node:fs';
import path from 'node:path';
import { episode, mustExist, loadFull, readJson, readInfo, infoBlank, fmt, MUSIC } from '../lib/podcast.mjs';

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
if (infoBlank(info['嘉宾是否同意']) || /不确定|否|没/.test(info['嘉宾是否同意'] ?? '')) todo.push('参与者是否同意剪辑发布还没确认');
const names = [...new Set(full.map((s) => s.speaker).filter(Boolean))];
const named = new Set(full.filter((s) => s.name).map((s) => s.speaker));
if (names.length && named.size < names.length) todo.push(`说话人还有 ${names.length - named.size} 个编号没对上人（说话人.md）：简介里提到具体的人之前先确认`);

const md = [`# 节目简介（草稿）`, '', `**标题**：${plan.title ?? '（待定）'}`, ''];
if (!infoBlank(info['节目名'])) md.push(`**节目**：${info['节目名']}`, '');
md.push(...(plan.intro?.length ? plan.intro.flatMap((p) => [p, '']) : ['（简介正文待写：在 编排方案.json 里加 intro，一段一个字符串）', '']));
md.push('## 时间轴', '', ...lines, '');
const extra = [];
if (edl.music?.length && fs.existsSync(MUSIC)) extra.push('片头片尾音乐：Aurora by Trex0n（CC0，来自 OpenGameArt）');
if (extra.length) md.push('## 其他', '', ...extra.map((x) => `- ${x}`), '');
if (todo.length) md.push('## 发布前要确认（发布时删掉这一节）', '', ...todo.map((x) => `- ${x}`), '');
fs.writeFileSync(path.join(e.out, '节目简介.md'), md.join('\n'), 'utf8');
console.log(`节目简介写到 精编版/节目简介.md（时间轴 ${lines.filter((l) => l.startsWith('-')).length} 个小话题）。${todo.length ? `还有 ${todo.length} 件事要确认。` : ''}`);
