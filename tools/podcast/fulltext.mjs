#!/usr/bin/env node
// 识别结果（+ 分说话人结果 + 说话人.md 里填的名字）→ 全文.json / 全文.txt。
// transcribe.mjs 和 speakers.mjs 会自动调用；主理人在 说话人.md 里填好名字后，单独跑一次把名字换进全文：
//
//   node tools/podcast/fulltext.mjs <节目目录>
//
// 全文.json 每句：{ id, start, end, speaker(编号 A/B…，没分说话人时为空), name(填过的称呼), text, toks:[{t 字, s 起始秒}] }
// 句子编号是 编排方案.json 定位用的。重新识别后编号会变，编排方案里每段记着原文，plan.mjs 会发现对不上。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { episode, readJson, writeJson, fmt, PUNCT } from '../lib/podcast.mjs';
import { loadShow, applyFixes } from '../lib/show.mjs';

const END = /^[。！？.!?]$/;
export const MIN_SPEAKER_SECONDS = 40; // 总共说不到这么多秒的"说话人"多半是插话、附和、串音的碎片，并到相邻的人

// 说话人.md 里填的称呼：表格第 2 列是编号，最后一列是"是谁"
export function readNames(e) {
  const names = {};
  if (!fs.existsSync(e.names)) return names;
  for (const line of fs.readFileSync(e.names, 'utf8').split(/\r?\n/)) {
    const c = line.split('|').map((x) => x.trim());
    if (c.length < 8 || !/^[A-Z]$/.test(c[2])) continue;
    if (c[6] && !/^[-—]+$/.test(c[6])) names[c[2]] = c[6];
  }
  return names;
}

// 说话人分段的来源：'model'（声纹模型分的，要并掉碎片）或 'tracks'（多轨按音轨认的，每条轨就是一个人）
export const diarSource = (e) => readJson(path.join(e.mid, '说话人来源.json'), { source: 'model' });

export function speakerLabels(diar, minSeconds = MIN_SPEAKER_SECONDS) {
  const all = {};
  for (const d of diar) all[d.speaker] = (all[d.speaker] ?? 0) + d.end - d.start;
  const major = Object.keys(all).filter((k) => all[k] >= minSeconds).sort((a, b) => all[b] - all[a]);
  return { segs: diar.filter((d) => all[d.speaker] >= minSeconds), label: Object.fromEntries(major.map((k, i) => [k, String.fromCharCode(65 + i)])), total: Object.fromEntries(major.map((k) => [k, all[k]])), fragments: Object.keys(all).length - major.length };
}

export function buildFull(dir) {
  const e = episode(dir);
  const asr = readJson(e.asr, null);
  if (!asr) throw new Error('还没有识别结果。先运行 node tools/podcast/transcribe.mjs <节目目录>');
  const diarRaw = readJson(e.diar, null);
  const { segs: dia, label } = diarRaw ? speakerLabels(diarRaw, diarSource(e).source === 'tracks' ? 3 : MIN_SPEAKER_SECONDS) : { segs: [], label: {} };
  const names = readNames(e);

  const speakerAt = (t) => {
    let best = null, dist = Infinity;
    for (const d of dia) {
      if (d.start <= t && t <= d.end) { if (dist > 0 || d.start > best.start) { best = d; dist = 0; } continue; }
      const g = t < d.start ? d.start - t : t - d.end;
      if (dist > 0 && g < dist) { best = d; dist = g; }
    }
    return best && dist < 2 ? label[best.speaker] : null;
  };

  // 1. 每个识别段按标点切成小句，小句的说话人取多数
  const clauses = [];
  for (const seg of asr) {
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      const words = cur.filter((x) => !PUNCT.test(x.t));
      if (!words.length) { if (clauses.length) { clauses.at(-1).toks.push(...cur); } cur = []; return; }
      const votes = {};
      for (const w of words) { const k = speakerAt(w.s) ?? ''; votes[k] = (votes[k] ?? 0) + 1; }
      const sp = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
      clauses.push({ start: words[0].s, toks: cur, speaker: sp, ends: END.test(cur.at(-1).t), segEnd: seg.end });
      cur = [];
    };
    for (const tk of seg.toks) { cur.push(tk); if (PUNCT.test(tk.t)) flush(); }
    flush();
    if (clauses.length) clauses.at(-1).ends = true;
  }
  clauses.forEach((c, i) => { c.end = Math.min(c.segEnd, clauses[i + 1]?.start ?? c.segEnd); });

  // 2. 小句拼成句子：遇到句号或停顿超过 1.5 秒就断。断句不看说话人，这样分说话人前后句子编号不变（编排方案靠编号定位）；
  //    一句的说话人取这句里多数字的说话人
  const sents = [];
  for (const c of clauses) {
    const last = sents.at(-1);
    if (last && !last.closed && c.start - last.end < 1.5) { last.toks.push(...c.toks); last.end = c.end; last.closed = c.ends; last.cl.push(c); }
    else sents.push({ start: c.start, end: c.end, toks: [...c.toks], closed: c.ends, cl: [c] });
  }
  for (const s of sents) {
    const votes = {};
    for (const c of s.cl) votes[c.speaker] = (votes[c.speaker] ?? 0) + c.toks.filter((t) => !PUNCT.test(t.t)).length;
    s.speaker = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
  }
  // 常错词（节目档案里的）：按句替换，字的时间不变，句子编号也不变
  const show = loadShow(e);
  let fixed = 0;
  if (show?.fixes.length) for (const s of sents) { const r = applyFixes(s.toks, show.fixes); s.toks = r.toks; fixed += r.n; }
  const full = sents.map((s, i) => ({
    id: i + 1, start: +s.start.toFixed(2), end: +s.end.toFixed(2), speaker: s.speaker || '', name: names[s.speaker] || '',
    text: s.toks.map((t) => t.t).join(''), toks: s.toks.map((t) => ({ t: t.t, s: t.s })),
  }));
  writeJson(e.full, full, 0);

  // 3. 全文.txt：同一人连续说的合成一段，标时间、说话人、句子编号
  const who = (s) => (s.speaker ? `${s.speaker}${s.name ? `（${s.name}）` : ''}：` : '');
  const lines = [];
  let turn = null;
  for (const s of full) {
    if (turn && turn.speaker === s.speaker && s.start - turn.end < 3) { turn.parts.push(`〔${s.id}〕${s.text}`); turn.end = s.end; }
    else { if (turn) lines.push(turn); turn = { start: s.start, end: s.end, speaker: s.speaker, s, parts: [`〔${s.id}〕${s.text}`] }; }
  }
  if (turn) lines.push(turn);
  const head = `# 全文（机器识别，错字没校）\n# 〔数字〕是句子编号，编排方案用它定位。${diarRaw ? 'A、B、C… 是机器分的说话人，A 说得最多；括号里是 说话人.md 里填的称呼。' : '还没分说话人。'}\n\n`;
  fs.writeFileSync(e.fullTxt, head + lines.map((t) => `[${fmt(t.start)}] ${who(t.s)}${t.parts.join('')}`).join('\n\n') + '\n', 'utf8');
  return { sentences: full.length, turns: lines.length, speakers: Object.keys(label).length, named: Object.keys(names).length, fixed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('用法: node tools/podcast/fulltext.mjs <节目目录>'); process.exit(2); }
  try {
    const r = buildFull(dir);
    console.log(`全文：${r.sentences} 句，${r.turns} 个发言段${r.speakers ? `，${r.speakers} 个说话人，已填称呼 ${r.named} 个` : ''}${r.fixed ? `，按节目档案换了 ${r.fixed} 处常错词` : ''}。写到 全文.txt / 全文.json`);
  } catch (err) { console.error(err.message); process.exit(1); }
}
