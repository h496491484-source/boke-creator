#!/usr/bin/env node
// 检查 编排方案.json，算时长，写 编排方案.md（给主理人看的：板块、保留什么、删减清单和原因）。
//
//   node tools/podcast/plan.mjs <节目目录>            检查并出报告
//   node tools/podcast/plan.mjs <节目目录> --refresh  重新识别过、确认编号已改对之后，更新每段记的原文
//
// 编排方案.json 由 Agent 读 全文.txt 后写，格式见 references/播客_编排原则.md。要点：
//   sections[].parts[] 用句子编号 from/to（含两头）定位，可选 startText/endText 把开头结尾修到半句；
//   kind:"hook" 的板块是片头钩子（可以和正文重复）；正文没选进去的句子都算删掉，每段删减在 cuts[] 里写原因。
// 每段第一次检查时会记下开头结尾的原文（check）。之后句子编号和原文对不上（比如重新识别过），这里会报错，不会剪错地方。

import fs from 'node:fs';
import { episode, mustExist, loadFull, readJson, readInfo, findInSentence, fmt, mins } from '../lib/podcast.mjs';
import { isLibRef, libTrack } from '../lib/library.mjs';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) { console.error('用法: node tools/podcast/plan.mjs <节目目录> [--refresh]'); process.exit(2); }
mustExist(dir);
const e = episode(dir);
const PKG = { hookLead: 2.0, betweenQuotes: 0.7, afterHook: 2.5, section: 3.0, tail: 10 }; // 和 build.mjs 一致
const LONG_PAUSE = 0.9, KEEP_PAUSE = 0.6;

const full = loadFull(e);
const plan = readJson(e.plan, null);
if (!plan) { console.error('还没有 编排方案.json。读 全文.txt 后按 references/播客_编排原则.md 写。'); process.exit(1); }
const byId = new Map(full.map((s) => [s.id, s]));
const bare = (t) => t.replace(/[，。！？、；：,.!?;:\s]/g, '');
const anchor = (p) => `${bare(byId.get(p.from).text).slice(0, 6)}…${bare(byId.get(p.to).text).slice(-6)}`;
const errors = [], warns = [];
const ed = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };

// ---- 1. 逐段检查，算真实起止 ----
const parts = [];
plan.sections.forEach((sec, si) => {
  if (!sec.parts?.length) { errors.push(`板块「${sec.name}」没有内容`); return; }
  sec.parts.forEach((p, pi) => {
    const where = `「${sec.name}」第 ${pi + 1} 段（${p.label ?? ''}）`;
    const a = byId.get(p.from), b = byId.get(p.to);
    if (!a || !b || p.from > p.to) { errors.push(`${where}：句子编号 ${p.from}–${p.to} 不对（全文共 ${full.length} 句）`); return; }
    // 差两三个字算同一处（同一段录音重新识别，同音字可能认得不一样）；差得多才是编号错位
    if (p.check && !args.includes('--refresh') && ed(p.check, anchor(p)) > 3) {
      const head = p.check.split('…')[0];
      const guess = full.filter((s) => bare(s.text).startsWith(head)).map((s) => s.id);
      errors.push(`${where}：记的原文是「${p.check}」，现在 ${p.from}–${p.to} 句是「${anchor(p)}」，对不上（重新识别过？）。${guess.length ? `开头像第 ${guess.join('、')} 句。` : ''}改好编号后加 --refresh`);
      return;
    }
    p.check = anchor(p);
    let start = a.start, end = b.end;
    if (p.startText) { const m = findInSentence(a, p.startText); if (!m) { errors.push(`${where}：第 ${p.from} 句里找不到 startText「${p.startText}」`); return; } start = a.toks[m.first].s; }
    if (p.endText) {
      const m = findInSentence(b, p.endText); if (!m) { errors.push(`${where}：第 ${p.to} 句里找不到 endText「${p.endText}」`); return; }
      const next = b.toks.slice(m.last + 1).find((t) => !/^[，。！？、；：,.!?;:]$/.test(t.t));
      end = next ? Math.min(next.s, b.toks[m.last].s + 0.55) : b.end;
    }
    let saved = 0;
    for (let id = p.from; id < p.to; id++) { const g = byId.get(id + 1).start - byId.get(id).end; if (g > LONG_PAUSE) saved += g - KEEP_PAUSE; }
    parts.push({ sec, si, p, where, start, end, dur: end - start - saved, hook: sec.kind === 'hook' });
  });
});

if (!errors.length) {
  // ---- 2. 正文：重叠、顺序 ----
  const body = parts.filter((x) => !x.hook);
  const sorted = [...body].sort((x, y) => x.p.from - y.p.from);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].p.from <= sorted[i - 1].p.to) errors.push(`${sorted[i].where} 和 ${sorted[i - 1].where} 用了同一句话（第 ${sorted[i].p.from} 句），正文里一句只能出现一次`);
  for (let i = 1; i < body.length; i++) if (body[i].p.from < body[i - 1].p.from) { warns.push(`${body[i].where} 被挪到了原来在它后面的内容之后，改变了原来的顺序：要确认没有改变"谁在回应谁"，并请主理人特别留意`); }
  for (const h of parts.filter((x) => x.hook)) if (h.end - h.start > 25) warns.push(`${h.where} 有 ${Math.round(h.end - h.start)} 秒，片头钩子每句最好不超过 20 秒`);
}

// ---- 配乐：music 写了就核对曲库编号（build.mjs 按同样的规则解析） ----
let musicLine = '配乐：照节目档案（没有档案就用默认的 Aurora）';
const describe = (v) => {
  if (v === false || /^(无|没有|不要|不加)$/.test(String(v))) return '不要';
  if (!isLibRef(v)) return String(v);
  const t = libTrack(v);
  return `${t.title}（库:${t.id}，${(t.mood ?? []).join('/')}${t.kind === '过渡音' ? '，过渡音' : ''}）`;
};
if (plan.music === false) musicLine = '配乐：这期不要';
else if (plan.music != null) {
  const items = typeof plan.music === 'string' ? { 三处: plan.music } : plan.music;
  if (typeof items !== 'object') errors.push('music 写法不对：写 false、"库:<编号>"，或者 {"片头": "库:…", "过渡": "库:…", "片尾": "库:…"}');
  else {
    const said = [];
    for (const [k, v] of Object.entries(items)) {
      if (!['三处', '片头', '过渡', '片尾'].includes(k)) { errors.push(`music 里的"${k}"不认识，只能写 片头、过渡、片尾`); continue; }
      try {
        if (isLibRef(v) && libTrack(v).kind === '过渡音' && k !== '过渡') errors.push(`music.${k} 用了过渡音 ${v}：过渡音只有几秒，只能用在"过渡"`);
        said.push(`${k} ${describe(v)}`);
      } catch (err) { errors.push(`music${k === '三处' ? '' : `.${k}`}：${err.message}`); }
    }
    musicLine = `配乐：${said.join('；')}${plan.musicWhy ? `。为什么：${plan.musicWhy}` : ''}`;
    if (!plan.musicWhy) warns.push('选了配乐但没写为什么（musicWhy）：一句话说清这期为什么配这首，给主理人看');
  }
}

if (errors.length) {
  console.error(`编排方案有 ${errors.length} 处要改：\n${errors.map((x) => '  · ' + x).join('\n')}`);
  process.exit(1);
}
fs.writeFileSync(e.plan, JSON.stringify(plan, null, 2) + '\n', 'utf8'); // 记下每段的原文 check

// ---- 3. 删减清单：正文没选进去的连续句子 ----
const kept = new Set();
for (const x of parts) if (!x.hook) for (let id = x.p.from; id <= x.p.to; id++) kept.add(id);
const cuts = [];
for (let id = 1; id <= full.length; id++) {
  if (kept.has(id)) continue;
  let to = id; while (to + 1 <= full.length && !kept.has(to + 1)) to++;
  const why = (plan.cuts ?? []).filter((c) => c.to >= id && c.from <= to).map((c) => c.why);
  cuts.push({ from: id, to, start: byId.get(id).start, end: byId.get(to).end, why });
  id = to;
}
const noWhy = cuts.filter((c) => !c.why.length && c.end - c.start >= 8);
if (noWhy.length) warns.push(`${noWhy.length} 段删减没写原因（${noWhy.slice(0, 5).map((c) => `${c.from}–${c.to}`).join('、')}${noWhy.length > 5 ? '……' : ''}），在 cuts 里补上`);

// ---- 4. 时长 ----
const nBody = new Set(parts.filter((x) => !x.hook).map((x) => x.si)).size;
const nHook = parts.filter((x) => x.hook).length;
const speech = parts.reduce((s, x) => s + x.dur, 0);
const pack = (nHook ? PKG.hookLead + PKG.afterHook + PKG.betweenQuotes * (nHook - 1) : 0) + PKG.section * Math.max(0, nBody - 1) + PKG.tail;
const totalLen = full.at(-1).end;
const est = speech + pack;
const target = (readInfo(e)['目标时长'] ?? '').match(/\d+(\.\d+)?/g)?.map(Number);
if (target?.length) {
  const [lo, hi] = [Math.min(...target), Math.max(...target)];
  if (est / 60 < lo * 0.95 || est / 60 > hi * 1.05) warns.push(`预计成品 ${mins(est)}，目标是 ${lo === hi ? lo : `${lo}–${hi}`} 分钟`);
}

// ---- 5. 写报告 ----
const md = [`# 编排方案：${plan.title ?? '（还没定标题）'}`, ''];
if (plan.titleOptions?.length) md.push('**标题备选**', '', ...plan.titleOptions.map((t, i) => `${i + 1}. ${t}`), '');
if (plan.theme) md.push(`**一句话主题**：${plan.theme}`, '');
md.push(`原始录音 ${fmt(totalLen)}，保留的人声约 ${mins(speech)}（已扣掉缩短的长停顿），加上片头片尾和过渡音乐约 ${mins(pack)}，**成品约 ${mins(est)}**。人声处理：${plan.voice === 'raw' ? '不处理' : '分人调平 + 低切降噪 + 轻度压缩'}。`, '', `${musicLine}。`, '');
md.push('## 编排', '', '| 板块 | 内容 | 句子 | 原位置 | 时长 |', '|---|---|---|---|---|');
for (const sec of plan.sections) {
  const xs = parts.filter((x) => x.sec === sec);
  xs.forEach((x, i) => md.push(`| ${i ? '' : `**${sec.name}**`} | ${x.p.label ?? ''} | ${x.p.from}–${x.p.to} | ${fmt(x.start)}–${fmt(x.end)} | ${Math.round(x.dur)} 秒 |`));
  md.push(`| | *小计* | | | *${mins(xs.reduce((s, x) => s + x.dur, 0))}* |`);
}
md.push('', '## 删减清单', '', `正文没用到的整段，共 ${mins(cuts.reduce((s, c) => s + c.end - c.start, 0))}。句中的"呃""嗯"和长停顿另外自动处理，不在表里。`, '', '| 句子 | 原位置 | 时长 | 开头 | 为什么删 |', '|---|---|---|---|---|');
for (const c of cuts) md.push(`| ${c.from}–${c.to} | ${fmt(c.start)}–${fmt(c.end)} | ${Math.round(c.end - c.start)} 秒 | ${bare(full.slice(c.from - 1, c.to).map((s) => s.text).join('')).slice(0, 24)}…… | ${c.why.join('；') || '（没写原因）'} |`);
if (warns.length) md.push('', '## 要留意', '', ...warns.map((w) => `- ${w}`));
fs.writeFileSync(e.planMd, md.join('\n') + '\n', 'utf8');

console.log(`编排方案检查通过：${plan.sections.length} 个板块，成品约 ${mins(est)}，删掉 ${cuts.length} 段共 ${mins(cuts.reduce((s, c) => s + c.end - c.start, 0))}。报告写到 编排方案.md`);
if (warns.length) console.log(`要留意：\n${warns.map((w) => '  · ' + w).join('\n')}`);
