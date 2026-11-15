#!/usr/bin/env node
// 自动补画面节点：找出"超过 3 秒画面没变化"的空档，在合适的地方往稿子里补 @字 行。
//
//   node tools/beats.mjs <作品目录> --plan    只出方案（写 补节点方案.json），不改稿子
//   node tools/beats.mjs <作品目录> --apply   照 补节点方案.json 改稿子（可以先改方案里的 show）
//   node tools/beats.mjs <作品目录>           出方案并直接改稿子，画面字用从原句截的词
//       [--gap 3]   多少秒没有画面变化算空档（默认 3）
//
// 分工：位置由程序定（它知道每个字的时间），画面上写什么字最好由人或 Agent 定——
// 方案里每一处都带着"这个节点管的那半句话"（covers）和一个截取出来的备选（show），
// Agent 把 show 改成提炼过的短语（不超过 8 个字），给本人看过，再 --apply。
// 手写的节点一个都不动；改稿前把原稿另存为 口播稿_补节点前.txt。
// 位置优先放在一句话的开头，其次顿号后面，再次词和词之间。空档里没人说话就补不了，会提示去清理录音。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseScript } from './lib/script.mjs';
import { mapChars } from './align.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const strip = (s) => String(s).replace(/[\s\p{P}\p{S}]/gu, '');
const r2 = (n) => Math.round(n * 100) / 100;
const MAX_SHOW = 8;       // 画面字最多几个字
const MARGIN = 0.2;       // 比规则多留一点余量，免得重录后差零点几秒又不过
const MIN_APART = 1.0;    // 两次画面变化至少隔这么久
const OPENERS = new Set([...'“‘（《「『【"\'(']);
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

function words(text) { // 词的起始位置；没有分词能力时退回到每 2 个字一处
  try {
    const out = []; let k = 0;
    for (const s of new Intl.Segmenter('zh', { granularity: 'word' }).segment(text)) { out.push(k); k += [...s.segment].length; }
    return out;
  } catch { return [...text].map((_, i) => i).filter((i) => i % 2 === 0); }
}

// 从一段话里截一个备选的画面字：先用这段里的关键词，没有就从头取几个完整的词
function excerpt(text, keywords) {
  const kw = (keywords ?? []).map((k) => (typeof k === 'string' ? k : k.word)).find((k) => k && text.includes(k) && [...k].length <= MAX_SHOW);
  if (kw && [...kw].length >= 2) return kw;
  const cs = [...text];
  if (cs.length <= MAX_SHOW) return text;
  const cuts = words(text).filter((k) => k > 0 && k <= MAX_SHOW);
  return cs.slice(0, cuts.length ? cuts.at(-1) : MAX_SHOW).join('');
}

function analyse(work, maxGap) {
  const scriptFile = path.join(work, '口播稿.txt');
  const src = fs.readFileSync(scriptFile, 'utf8');
  const parsed = parseScript(src);
  if (parsed.errors.length) throw new Error(`口播稿有问题：${parsed.errors[0]}`);
  const sb = parsed.storyboard;

  // 用 storyboard.mjs 算出现有的时间线（关掉 3 秒规则，别的错误照常报）
  const tmp = path.join(os.tmpdir(), `boke-beats-${process.pid}.json`);
  const r = spawnSync(process.execPath, [path.join(here, 'storyboard.mjs'), scriptFile, '--gap', 'off', '--out', tmp], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`稿子还有别的问题，先解决：\n${(r.stdout || r.stderr || '').trim()}`);
  const tl = JSON.parse(fs.readFileSync(tmp, 'utf8')); fs.rmSync(tmp, { force: true });
  const total = tl.canvas.duration;

  // 每个屏幕字的开口时间
  const timingFile = path.resolve(work, sb.audio.timing || 'timing.json');
  const tokens = JSON.parse(fs.readFileSync(timingFile, 'utf8'));
  const stream = [];
  if (Array.isArray(tokens)) for (const t of tokens) for (const _ of strip(t.text)) stream.push(t.start);
  let cursor = 0;
  const segs = sb.segments.map((seg, i) => {
    const spoken = [...strip(seg.say ?? seg.text)], shown = [...seg.text];
    const times = stream.slice(cursor, cursor + spoken.length); cursor += spoken.length;
    // 每个屏幕字的时间。读法和屏幕字不一样长时，只有在读法里找得到原字的位置才有时间（其余是 null）
    let charTimes = null;
    if (times.length === spoken.length && spoken.length) {
      charTimes = spoken.length === shown.length ? times : mapChars(shown.filter((c) => strip(c)), spoken).map((j) => (j == null ? null : times[j]));
      if (charTimes.length !== shown.length) charTimes = null; // 屏幕字里有空格之类，不冒险
    }
    return { ...seg, chars: shown, start: tl.captions[i].start, end: tl.captions[i].end, pos: parsed.positions[seg.id], times: charTimes };
  });
  const srcLines = src.replace(/^﻿/, '').split(/\r?\n/);

  // 现在的画面变化：每个场景开场 + 每个画得出来的节点
  const changes = [...new Set(tl.scenes.flatMap((s) => [s.start, ...s.items.map((it) => it.at)]))].sort((a, b) => a - b);

  // 候选位置。等级：1 一句话开头，2 顿号后面，3 词和词之间
  const cands = [];
  for (const seg of segs) {
    cands.push({ seg, k: 0, at: seg.start, rank: 1 });
    if (!seg.times) continue;
    for (const k of words(seg.text)) {
      if (k < 2 || seg.chars.length - k < 2 || seg.times[k] == null) continue;
      const [ln, col] = seg.pos[k];
      const before = [...srcLines[ln - 1].trim()].slice(0, col).join('').trimEnd();
      // 顿号后面，或者作者自己在这里换了行：都是他认为可以断开的地方
      cands.push({ seg, k, at: seg.times[k], rank: before.endsWith('、') || col === 0 ? 2 : 3 });
    }
  }
  cands.sort((a, b) => a.at - b.at);

  // 每个空档里整体挑一组位置：相邻两次变化不超过限度，并且尽量用句子开头。
  // 代价：句子开头 1，顿号后 3，句子中间 8；间隔离 2 秒越远再加一点，免得挤在一起或卡着上限。
  const COST = { 1: 1, 2: 3, 3: 8 };
  function choose(t0, t1, limit) {
    const inside = cands.filter((c) => c.at >= t0 + MIN_APART && c.at <= t1 - MIN_APART / 2);
    const node = [{ at: t0 }, ...inside, { at: t1 }], m = node.length;
    const best = new Array(m).fill(Infinity), from = new Array(m).fill(-1);
    best[0] = 0;
    for (let j = 1; j < m; j++) for (let i = 0; i < j; i++) {
      const dt = node[j].at - node[i].at;
      if (j < m - 1 && dt < MIN_APART) continue;
      // 间隔贴着上限（留的余量不到 MARGIN）加 2：宁可这样，也不为了余量去拆句子。
      // 超过上限加 1000：实在没有位置（长停顿）时允许超，别的地方照常挑，超的那段单独报出来。
      const c = best[i] + (j < m - 1 ? COST[node[j].rank] : 0) + 0.02 * (Math.min(dt, limit) - 2) ** 2 + (dt > maxGap - MARGIN ? 2 : 0) + (dt > limit ? 1000 * (1 + dt - limit) : 0);
      if (c < best[j]) { best[j] = c; from[j] = i; }
    }
    const picks = [], over = [];
    for (let j = m - 1; j > 0; j = from[j]) {
      if (j < m - 1) picks.push(node[j]);
      if (node[j].at - node[from[j]].at > limit) over.push({ from: r2(node[from[j]].at), to: r2(node[j].at) });
    }
    return { picks, over };
  }
  const planned = [], stuck = [];
  // 每个场景开场时只有小标题、下面是空的，不好看：场景第一句没有节点的，先给它补一个
  tl.scenes.forEach((sc, i) => {
    const first = segs.find((s) => s.id === sb.scenes[i]?.from);
    if (!first || sc.items.some((it) => it.at <= first.start + 0.3)) return;
    planned.push({ seg: first, k: 0, at: first.start, rank: 1 });
    if (!changes.includes(first.start)) { changes.push(first.start); changes.sort((a, b) => a - b); }
  });
  for (let i = 0; i < changes.length; i++) {
    const t0 = changes[i], t1 = i + 1 < changes.length ? changes[i + 1] : total;
    if (t1 - t0 <= maxGap + 0.05) continue;
    const { picks, over } = choose(t0, t1, maxGap + 0.05);
    planned.push(...picks); stuck.push(...over);
  }
  stuck.sort((a, b) => a.from - b.from);
  planned.sort((a, b) => a.at - b.at);

  // 每个新节点管到下一次画面变化为止，把这段话取出来
  const all = [...new Set([...changes, ...planned.map((p) => p.at), total])].sort((a, b) => a - b);
  const items = planned.map((p, n) => {
    const until = all.find((t) => t > p.at + 1e-6) ?? total;
    let covers = '';
    for (const seg of segs) {
      if (seg.end <= p.at || seg.start >= until) continue;
      if (seg.times) {
        let last = seg.start; // 没有时间的字（改了读法的）跟着前一个字走
        covers += seg.chars.filter((_, k) => { last = seg.times[k] ?? last; return last >= p.at - 1e-6 && last < until; }).join('');
      } else if (seg.start >= p.at - 1e-6) covers += seg.text;
    }
    const noNum = (s) => s.replace(/^[0-9０-９]+(?=\D)/, ''); // 句首的编号（"2追问让观点落地"）不上画面
    covers = noNum(covers);
    // 备选的画面字只从节点所在的这一句里截，不跨到下一句去
    let own = '';
    if (p.seg.times) { let last = p.seg.start; own = p.seg.chars.filter((_, k) => { last = p.seg.times[k] ?? last; return last >= p.at - 1e-6 && last < until; }).join(''); }
    else own = p.seg.text;
    own = noNum(own);
    const basis = [...own].length >= 2 ? own : covers || p.seg.text;
    return { n: n + 1, seg: p.seg.id, offset: p.k, at: r2(p.at), until: r2(until), where: p.rank === 1 ? '一句话开头' : p.rank === 2 ? '顿号后或换行处' : '句子中间', line: p.seg.pos[p.k][0],
      covers, show: excerpt(basis, p.seg.keywords) };
  });
  return { scriptFile, src, items, stuck, changes: changes.length, total, maxGap };
}

// 把一行 @字 插到稿子里第 seg 句的第 offset 个字前面；插完重新解析，句子有任何变化就放弃这一处
function insert(src, item) {
  const before = parseScript(src);
  const [ln, col0] = before.positions[item.seg][item.offset];
  const lines = src.split(/\r?\n/);
  const cs = [...lines[ln - 1].trim()];
  let col = col0;
  for (;;) { // 不要插在开引号、【、成对星号的开头和它后面的字之间
    const prev = cs[col - 1];
    if (prev && OPENERS.has(prev)) col--;
    else if (prev === '*' && cs.slice(0, col).filter((c) => c === '*').length % 2 === 1) col--;
    else break;
  }
  const head = cs.slice(0, col).join(''), tail = cs.slice(col).join('');
  lines.splice(ln - 1, 1, ...(head.trim() ? [head] : []), `@字 ${item.show}`, tail);
  const next = lines.join('\n'), after = parseScript(next);
  const same = (a, b) => JSON.stringify(a.storyboard.segments.map((s) => [s.text, s.say, s.keywords])) === JSON.stringify(b.storyboard.segments.map((s) => [s.text, s.say, s.keywords]));
  const count = (p) => p.storyboard.scenes.reduce((s, sc) => s + sc.beats.length, 0);
  if (after.errors.length || !same(before, after) || count(after) !== count(before) + 1) return null;
  return next;
}

function show(plan) {
  if (!plan.items.length && !plan.stuck.length) { console.log(`不用补：现在有 ${plan.changes} 次画面变化，没有超过 ${plan.maxGap} 秒的空档。`); return; }
  if (plan.items.length) console.log(`打算补 ${plan.items.length} 个画面节点（现有 ${plan.changes} 次画面变化，片长 ${plan.total} 秒）：`);
  for (const it of plan.items) console.log(`  ${String(it.n).padStart(2)}. ${it.at} 秒，第 ${it.line} 行，${it.where}：画面字「${it.show}」  ← 这一段说的是「${it.covers}」`);
  for (const s of plan.stuck) console.log(`  补不了：${s.from}–${s.to} 秒这 ${r2(s.to - s.from)} 秒里没有合适的位置（多半是长停顿）。先清理录音：node tools/clean.mjs <作品目录>`);
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--gap');
  if (!target) { console.error('用法: node tools/beats.mjs <作品目录> [--plan | --apply] [--gap 3]'); process.exit(2); }
  const work = path.resolve(target), planFile = path.join(work, '补节点方案.json');
  const maxGap = Number(opt('--gap', '3'));
  if (!fs.existsSync(path.join(work, 'timing.json')) && !args.includes('--apply')) {
    console.error('还没有逐字时间（timing.json）。先运行一次 make.mjs，它会识别录音并对到稿子上。'); process.exit(1);
  }

  let plan;
  try {
    if (args.includes('--apply')) {
      if (!fs.existsSync(planFile)) throw new Error('没有 补节点方案.json。先运行 --plan。');
      plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
      plan.scriptFile = path.join(work, '口播稿.txt'); plan.src = fs.readFileSync(plan.scriptFile, 'utf8');
      if (sha(plan.src) !== plan.script_sha) throw new Error('出方案之后稿子改过了，位置对不上。重新运行 --plan。');
    } else {
      plan = analyse(work, maxGap);
    }
  } catch (e) { console.error(e.message); process.exit(1); }

  show(plan);
  if (args.includes('--plan')) {
    fs.writeFileSync(planFile, JSON.stringify({ script_sha: sha(plan.src), maxGap: plan.maxGap, total: plan.total, changes: plan.changes,
      note: 'show 是画面上出现的字，可以改成更精炼的短语（不超过 8 个字，不带标点）；covers 是这个节点管的那段话，只供参考。删掉某一项就不补那一处。',
      items: plan.items, stuck: plan.stuck }, null, 2) + '\n', 'utf8');
    if (plan.items.length) console.log(`\n方案写到 ${planFile}，稿子没动。改好画面字、给本人看过之后：node tools/beats.mjs <作品目录> --apply`);
    process.exit(0);
  }
  if (!plan.items.length) process.exit(plan.stuck.length ? 1 : 0);

  // ---- 改稿子：从后往前插，前面的位置才不会变 ----
  let text = plan.src.replace(/^﻿/, '');
  const failed = [];
  for (const it of [...plan.items].sort((a, b) => b.at - a.at)) {
    const bad = !it.show || /[\p{P}\s]/u.test(it.show) || [...it.show].length > 12;
    const next = bad ? null : insert(text, it);
    if (next) text = next; else failed.push({ ...it, why: bad ? '画面字是空的、带标点或太长' : '这个位置插进去会把句子弄乱' });
  }
  fs.writeFileSync(path.join(work, '口播稿_补节点前.txt'), plan.src, 'utf8');
  fs.writeFileSync(plan.scriptFile, text, 'utf8');
  fs.rmSync(planFile, { force: true });
  console.log(`\n已往稿子里补了 ${plan.items.length - failed.length} 行 @字。原稿另存为 口播稿_补节点前.txt。`);
  for (const f of failed) console.log(`  没补上第 ${f.n} 处（${f.at} 秒）：${f.why}`);

  const chk = spawnSync(process.execPath, [path.join(here, 'storyboard.mjs'), plan.scriptFile, '--gap', String(plan.maxGap)], { encoding: 'utf8', windowsHide: true });
  console.log((chk.stdout || '').trim().split(/\r?\n/).map((l) => '  ' + l).join('\n'));
  process.exit(chk.status === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
