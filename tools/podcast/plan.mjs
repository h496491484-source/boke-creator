#!/usr/bin/env node
// 检查 编排方案.json，算时长，写 编排方案.md（给主理人看的：板块、保留什么、删减清单和原因）。
//
//   node tools/podcast/plan.mjs <节目目录>            检查并出报告
//   node tools/podcast/plan.mjs <节目目录> --refresh  重新识别过、确认编号已改对之后，更新每段记的原文
//   node tools/podcast/plan.mjs <节目目录> --accept-new  重新识别后新加的段（比如插进来的补录）没有记的原文：确认编号没错后只收下这些段，别的段照样核对
//
// 编排方案.json 由 Agent 读 全文提纲.md / 全文.txt 后写（可以从机器草稿 编排方案.草稿.json 改起），格式见 references/播客_编排原则.md。要点：
//   sections[].parts[] 用句子编号 from/to（含两头）定位，可选 startText/endText 把开头结尾修到半句；
//   kind:"hook" 的板块是片头钩子（可以和正文重复）；正文没选进去的句子才算删掉（cuts 只写原因，不会真删），每段删减在 cuts[] 里写原因。
// 有错一次列全，不是碰到第一个就停。通过时打印一段念给主理人听的摘要（也写进 编排方案.md 开头）；还有"待改"、删减没写原因时先说"先别给主理人看"。
// 每段开头结尾的原文和检查时的指纹记在 <节目>/方案原文.json（不再写回 编排方案.json：检查不改方案文件）。
// 全文重新识别过（编号指纹变了）时，拿记的原文和现在的编号核对（同一板块里先按原文找、再按小标题、最后按"第几段"），编号改错了也拦得下来。
// build、status 按这里记的指纹判断"方案检查过没有"，不看文件修改时间。旧方案里留着的 check 字段照样认。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, episode, mustExist, loadFull, readJson, writeJson, writeText, readInfo, infoBlank, findInSentence, fmt, mins, planOrExit, cmd, fullSha, loadAnchors, fileSha, planSha, planTodos, TODO_WHERE, recordingsChanged, recChangedMsg, recParts, inFile, partAt, duration, makeClipper, HOOK_GAP, introBedSeconds, introOf } from '../lib/podcast.mjs';
import { PARTS, resolveMusic, musicName, trackGood, trackReady } from '../lib/library.mjs';
import { getMusic } from '../get-model.mjs';
import { loadShow, showAsset, effectiveVoice, showVoice, showRef, targetLufs, showClipBad } from '../lib/show.mjs';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) { console.error(`用法: ${cmd('plan.mjs')} <节目目录> [--refresh | --accept-new]`); process.exit(2); }
mustExist(dir);
const e = episode(dir);
const refresh = args.includes('--refresh');
const acceptNew = args.includes('--accept-new');
const RULES = path.join(ROOT, 'references', '播客_编排原则.md');
const PKG = { ...HOOK_GAP, section: 3.0, tail: 10 }; // 和 build.mjs 一致（片头几段空当共用 lib/podcast.mjs 的 HOOK_GAP）
const LONG_PAUSE = 0.9, KEEP_PAUSE = 0.6;

// 录音在转写之后变了（加了补录、改了顺序，还没重新转写）：全文是旧录音的，按它检查没有意义
{ const ch = recordingsChanged(e); if (ch && !ch.mtimeOnly) { console.error(`${recChangedMsg(e, ch)}。这次没检查。`); process.exit(1); } }
let full;
try { full = loadFull(e); } catch (err) { console.error(err.message); process.exit(1); } // 转写半路断了会没有全文：说清楚，不打英文堆栈
const plan = planOrExit(e);
if (!plan) {
  console.error(fs.existsSync(e.draft)
    ? `还没有 编排方案.json。先读 全文提纲.md，再按需读 全文.txt 对应段落；可以在机器草稿 编排方案.草稿.json 上改（合并板块、起名字、加钩子、写删减），另存为 编排方案.json。格式见 ${RULES}。`
    : `还没有 编排方案.json。读 全文.txt 后按 ${RULES} 写。`);
  process.exit(1);
}
const byId = new Map(full.map((s) => [s.id, s]));
const bare = (t) => t.replace(/[，。！？、；：,.!?;:\s]/g, '');
const anchor = (p) => `${bare(byId.get(p.from).text).slice(0, 6)}…${bare(byId.get(p.to).text).slice(-6)}`;
const errors = [], warns = [];
const ed = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
const isId = (x) => Number.isInteger(x);
const dur = (s) => (s < 90 ? `${Math.round(s)} 秒` : mins(s));

// ---- 0. 整体写法：先把结构上的错都找出来 ----
const sections = Array.isArray(plan.sections) ? plan.sections : [];
if (!sections.length) errors.push('没有 sections（板块列表），或者它不是 [ ] 数组');
const planCuts = Array.isArray(plan.cuts) ? plan.cuts : [];
if (plan.cuts != null && !Array.isArray(plan.cuts)) errors.push('cuts 要写成 [ ] 数组，每段 { "from": 句子编号, "to": 句子编号, "why": "为什么删" }');
planCuts.forEach((c, i) => {
  if (!isId(c?.from) || !isId(c?.to) || c.from < 1 || c.from > c.to || c.to > full.length) errors.push(`cuts 第 ${i + 1} 条：句子编号 ${JSON.stringify(c?.from)}–${JSON.stringify(c?.to)} 不对（全文共 ${full.length} 句）`);
  else if (typeof c.why !== 'string' || !c.why.trim()) warns.push(`cuts 第 ${i + 1} 条（${c.from}–${c.to}）没写 why（为什么删）`);
});
if (plan.voice != null && !['processed', 'raw'].includes(plan.voice)) errors.push(`voice 只能写 "processed"（处理）或 "raw"（不处理），现在是 ${JSON.stringify(plan.voice)}`);
// 写成一个字符串也照用（空行分段），和 notes、finish 同一个判断（lib/podcast.mjs 的 introOf）
if (introOf(plan).bad) errors.push(introOf(plan).bad);
if (plan.titleOptions != null && !Array.isArray(plan.titleOptions)) errors.push('titleOptions（标题备选）要写成数组：["标题一", "标题二"]');

// ---- 1. 逐段检查，算真实起止 ----
// 记的原文（方案原文.json，lib/podcast.mjs 的 loadAnchors）：
//   全文的编号指纹和上次检查时一样：改 from/to 是正常改方案，不用核；
//   不一样（重新识别过）：每段找上次记的原文（不按编号——编号正是要核的东西），和现在这几句比，差得多就报错。
//     找法：同一板块里先按原文找（记的哪一段和现在这几句对得上就算对）；找不到再按小标题（同一板块里只有一段叫这个）；
//     最后才按"第几段"，而且跳过已经被别的段按原文认走的那条——板块里插进一段（补录）后，后面的段不会拿到错的那一条（2026-11-22 审查）；
//     上次没有这一段（新加的）：认方案里旧的 check，或者和上次记的随便哪段对得上；都不行就报错，确认没错加 --accept-new（只收下新段，别的照样核）
//   旧版（只按"起-止"编号记）：按编号找，找不到再看 check
//   什么都没记（方案原文.json 被删了、方案里也没有 check）而以前检查过：拿剪辑表核一下编号，核不了就停下说清楚
// --refresh：不核，照现在的编号重新记
const fp = fullSha(full);
const stored = refresh ? null : loadAnchors(e);
const reTx = !!stored && !stored.legacy && !!stored.full && stored.full !== fp;
if (!refresh && !stored && !sections.some((s) => Array.isArray(s?.parts) && s.parts.some((p) => p?.check))) {
  const edl = readJson(path.join(e.out, '剪辑表.json'), null);
  const clips = (edl?.items ?? []).filter((x) => x.kind === 'clip' && Array.isArray(x.ids));
  const off = clips.filter((c) => { const s = byId.get(c.ids[0]); return !s || c.src[0] < s.start - 1.5 || c.src[0] > s.end + 0.5; }).length;
  const lost = clips.length ? (off ? `精编版剪完之后全文重新识别过（${off} 段的句子编号对不上了），而上次检查时每段记的原文（方案原文.json）不见了，没法逐段核对编号` : null)
    : fs.existsSync(e.planMd) || readJson(e.state, null)?.confirmed?.['编排'] ? '这期以前检查过编排方案，但每段记的原文（方案原文.json）不见了，没法核对句子编号有没有错位（重新识别过的话会错位）' : null;
  if (lost) errors.push(`${lost}。对照 全文.txt 核对每段的句子编号，改好（或确认没错）后运行 ${cmd('plan.mjs', e.work, '--refresh')}`);
}
const anchorsNow = [];
const parts = [];
const seenNames = new Set();
const secName = (sec) => (typeof sec?.name === 'string' && sec.name.trim() ? sec.name : null);
const validPart = (p) => isId(p?.from) && isId(p?.to) && byId.has(p.from) && byId.has(p.to) && p.from <= p.to;
// 重新识别过：每段配上次记的哪一条，分三轮配，配走的那条不再分给别的段——
//   先按原文（同一板块里对得上就算对，别的板块里对得上也算：整段挪了板块），再按小标题（同一板块里剩下的只有一条叫这个），最后才按"第几段"
const match = new Map(), taken = new Set();
if (reTx) {
  const all = sections.flatMap((sec, si) => (Array.isArray(sec?.parts) ? sec.parts : []).map((p, pi) => ({ p, si, pi, name: secName(sec) }))).filter((x) => validPart(x.p));
  const give = (x, ent) => { if (ent) { match.set(`${x.si}-${x.pi}`, ent); taken.add(ent); } };
  const open = () => all.filter((x) => !match.has(`${x.si}-${x.pi}`));
  for (const x of all) { const now = anchor(x.p); give(x, stored.parts.find((y) => !taken.has(y) && y.sec === x.name && typeof y.text === 'string' && ed(y.text, now) <= 3)); }
  for (const x of open()) { const now = anchor(x.p); const y = stored.parts.find((z) => typeof z.text === 'string' && ed(z.text, now) <= 3); if (y) match.set(`${x.si}-${x.pi}`, y); }
  for (const x of open()) { if (!x.p.label) continue; const ys = stored.parts.filter((y) => !taken.has(y) && y.sec === x.name && y.label === x.p.label); if (ys.length === 1) give(x, ys[0]); }
  for (const x of open()) give(x, stored.parts.find((y) => !taken.has(y) && y.sec === x.name && y.i === x.si && y.j === x.pi));
}
sections.forEach((sec, si) => {
  const name = typeof sec?.name === 'string' && sec.name.trim() ? sec.name : null;
  const secWhere = name ? `板块「${name}」` : `第 ${si + 1} 个板块`;
  if (!name) errors.push(`${secWhere}没有名字（name）`);
  else if (seenNames.has(name)) warns.push(`有两个板块都叫「${name}」：简介时间轴会对不上，最好起不一样的名字`);
  seenNames.add(name);
  if (sec?.kind != null && sec.kind !== 'hook') warns.push(`${secWhere}的 kind 写的是 ${JSON.stringify(sec.kind)}：只有 "hook"（片头钩子）有用，别的都当正文`);
  if (!Array.isArray(sec?.parts) || !sec.parts.length) { errors.push(`${secWhere}没有内容（parts）`); return; }
  sec.parts.forEach((p, pi) => {
    const where = `「${name ?? `第 ${si + 1} 个板块`}」第 ${pi + 1} 段（${p?.label ?? ''}）`;
    if (!isId(p?.from) || !isId(p?.to)) { errors.push(`${where}：from / to 要写句子编号（整数），现在是 ${JSON.stringify(p?.from)}–${JSON.stringify(p?.to)}`); return; }
    const a = byId.get(p.from), b = byId.get(p.to);
    if (!a || !b || p.from > p.to) { errors.push(`${where}：句子编号 ${p.from}–${p.to} 不对（全文共 ${full.length} 句）`); return; }
    const now = anchor(p);
    let was = null, unrecorded = false;
    if (!refresh) {
      if (stored?.legacy) was = stored.parts[`${p.from}-${p.to}`] ?? p.check ?? null;
      else if (reTx) {
        was = match.get(`${si}-${pi}`)?.text ?? p.check ?? null;
        if (!was && !stored.parts.some((x) => typeof x.text === 'string' && ed(x.text, now) <= 3)) unrecorded = true;
      } else if (!stored) was = p.check ?? null;
    }
    let bad = false, shifted = false;
    // 差两三个字算同一处（同一段录音重新识别，同音字可能认得不一样）；差得多才是编号错位
    if (was && ed(was, now) > 3) {
      // 开头、结尾分开猜：开头已经对了的，说清楚是结尾不对、像第几句，给出建议的范围（2026-11-22 审查）
      const [head, tail = ''] = was.split('…');
      const hs = head ? full.filter((s) => bare(s.text).startsWith(head)).map((s) => s.id) : [];
      const ts = tail ? full.filter((s) => bare(s.text).endsWith(tail)).map((s) => s.id) : [];
      const headOk = hs.includes(p.from), tailOk = ts.includes(p.to);
      let hint = '';
      if (headOk && !tailOk && ts.length) { const y = ts.find((id) => id >= p.from) ?? ts[0]; hint = `开头第 ${p.from} 句对得上，是结尾不对：上次结尾是「…${tail}」，现在像第 ${ts.join('、')} 句${y >= p.from ? `（改成 ${p.from}–${y}？）` : ''}。`; }
      else if (!headOk && tailOk && hs.length) { const x = [...hs].reverse().find((id) => id <= p.to) ?? hs[0]; hint = `结尾第 ${p.to} 句对得上，是开头不对：上次开头是「${head}…」，现在像第 ${hs.join('、')} 句${x <= p.to ? `（改成 ${x}–${p.to}？）` : ''}。`; }
      else if (hs.length || ts.length) {
        const x = hs.length ? hs.reduce((a, b) => (Math.abs(b - p.from) < Math.abs(a - p.from) ? b : a)) : null;
        const y = x != null ? ts.find((id) => id >= x) : null;
        hint = `${hs.length ? `开头像第 ${hs.join('、')} 句` : ''}${hs.length && ts.length ? '，' : ''}${ts.length ? `结尾像第 ${ts.join('、')} 句` : ''}${x != null && y != null ? `（改成 ${x}–${y}？）` : ''}。`;
      }
      errors.push(`${where}：上次检查时这一段是「${was}」，现在 ${p.from}–${p.to} 句是「${now}」，对不上（全文重新识别过，句子编号变了？）。${hint}按 全文.txt 改好编号再运行；开头结尾都确认没错（只是重新识别后有几个字不一样）才加 --refresh：${cmd('plan.mjs', e.work, '--refresh')}`);
      bad = shifted = true;
    } else if (unrecorded && !acceptNew) {
      errors.push(`${where}：全文重新识别过，这一段（${p.from}–${p.to} 句「${now}」）上次检查时还没有（新加的段，比如插进来的补录），没有记的原文可以核对。对照 全文.txt 确认编号没错，再加 --accept-new（只收下新加的段，别的段照样核对）：${cmd('plan.mjs', e.work, '--accept-new')}`);
      bad = true;
    }
    anchorsNow.push({ i: si, j: pi, sec: name, label: p.label ?? null, from: p.from, to: p.to, text: now });
    let start = a.start, end = b.end;
    // 编号错位时 startText / endText 多半也找不到，根子是同一个，不重复报
    if (p.startText != null && !shifted) {
      const m = typeof p.startText === 'string' && p.startText ? findInSentence(a, p.startText) : null;
      if (!m) { errors.push(`${where}：第 ${p.from} 句里找不到 startText「${p.startText}」`); bad = true; } else start = a.toks[m.first].s;
    }
    if (p.endText != null && !shifted) {
      const m = typeof p.endText === 'string' && p.endText ? findInSentence(b, p.endText) : null;
      if (!m) { errors.push(`${where}：第 ${p.to} 句里找不到 endText「${p.endText}」`); bad = true; } else {
        const next = b.toks.slice(m.last + 1).find((t) => !/^[，。！？、；：,.!?;:]$/.test(t.t));
        end = next ? Math.min(next.s, b.toks[m.last].s + 0.55) : b.end;
      }
    }
    if (!bad && end <= start) { errors.push(`${where}：startText 在 endText 后面，这一段是空的`); bad = true; }
    if (bad) return;
    let saved = 0;
    for (let id = p.from; id < p.to; id++) { const g = byId.get(id + 1).start - byId.get(id).end; if (g > LONG_PAUSE) saved += g - KEEP_PAUSE; }
    parts.push({ sec, si, p, where, start, end, dur: end - start - saved, hook: sec.kind === 'hook' });
  });
});

// ---- 2. 正文：重叠、顺序（只看写对了的段，别的错照样一起报）----
const body = parts.filter((x) => !x.hook);
const sorted = [...body].sort((x, y) => x.p.from - y.p.from);
for (let i = 1; i < sorted.length; i++) if (sorted[i].p.from <= sorted[i - 1].p.to) errors.push(`${sorted[i].where} 和 ${sorted[i - 1].where} 用了同一句话（第 ${sorted[i].p.from} 句），正文里一句只能出现一次`);
// 顺序：按原来先后排着的、加起来最长的那一串不算挪动，其余的才是挪了位置的段——报挪走的那一段，不报被它挤到后面的正片（2026-11-22 审查）。
// 几个录音前后接着拼的：每个录音文件各自看先后。从别的录音文件拿来插在中间的段（补录放开头、放到某段后面补充）是事先计划好的，
// 不算"调了顺序"；同一个文件里的段前后颠倒了才算（2026-11-23 复核：只看前后挨着的段是哪个文件，会漏掉挪到补录后面的正片）
const recP = recParts(e);
const fileOf = (x) => partAt(recP, x.start)?.k ?? 0;
let moved = 0;
{
  const groups = new Map();
  body.forEach((x, i) => { const k = recP ? fileOf(x) : 0; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
  const out = [];
  for (const idx of groups.values()) {
    const best = idx.map((i) => body[i].dur), prev = idx.map(() => -1);
    for (let a = 0; a < idx.length; a++) for (let b = 0; b < a; b++) if (body[idx[b]].p.from < body[idx[a]].p.from && best[b] + body[idx[a]].dur > best[a]) { best[a] = best[b] + body[idx[a]].dur; prev[a] = b; }
    const inOrder = new Set();
    for (let k = idx.length ? best.indexOf(Math.max(...best)) : -1; k >= 0; k = prev[k]) inOrder.add(idx[k]);
    out.push(...idx.filter((i) => !inOrder.has(i)));
  }
  for (const i of out.sort((a, b) => a - b)) {
    moved++;
    warns.push(`${body[i].where} 挪了位置（不在原来的先后顺序上），改变了原来的顺序：要确认没有改变"谁在回应谁"，并请主理人特别留意`);
  }
}
// 片头钩子不管写在 sections 的哪儿，剪的时候都放在最前面：写在钩子前面的正文板块会排到钩子后面（2026-11-22 审查）
{
  const lastHook = sections.findLastIndex((s) => s?.kind === 'hook');
  const before = sections.slice(0, Math.max(0, lastHook)).filter((s) => s?.kind !== 'hook' && secName(s)).map((s) => `「${s.name}」`);
  if (before.length) warns.push(`片头钩子总放在成品最前面：写在它前面的${before.join('')}会排到钩子后面（正文的最前面）。想让它真的在整期最前面：去掉钩子，或者把它也放进 kind:"hook" 的板块；不然把 sections 的顺序改成和成品一样，免得给主理人看的和剪出来的不一样`);
}
for (const h of parts.filter((x) => x.hook)) if (h.end - h.start > 25) warns.push(`${h.where} 有 ${Math.round(h.end - h.start)} 秒，片头钩子每句最好不超过 20 秒`);
// cuts 只是写原因：真正删掉靠 sections 不选那几句。cuts 写的范围整个都还在正文里：删减根本没生效——报错；
// 一部分还在正文里（范围写宽了，或者段没拆干净）：提醒。段两头用 startText / endText 只留了半句的那一句不算（另外半句确实删了）
const half = new Set();
for (const x of body) { if (x.p.startText != null) half.add(x.p.from); if (x.p.endText != null) half.add(x.p.to); }
const inBody = new Set();
for (const x of body) for (let id = x.p.from; id <= x.p.to; id++) if (!half.has(id)) inBody.add(id);
const rng = (a, b) => (a === b ? `第 ${a} 句` : `第 ${a}–${b} 句`);
planCuts.forEach((c, i) => {
  if (!isId(c?.from) || !isId(c?.to) || c.from > c.to || c.to > full.length) return;
  const hits = body.map((x) => {
    let a = Math.max(c.from, x.p.from), b = Math.min(c.to, x.p.to);
    while (a <= b && half.has(a)) a++;
    while (b >= a && half.has(b)) b--;
    return a <= b ? `${rng(a, b)}还在${x.where}（${x.p.from}–${x.p.to}）里` : null;
  }).filter(Boolean);
  if (!hits.length) return;
  let left = 0; for (let id = c.from; id <= c.to; id++) if (!inBody.has(id) && !half.has(id)) left++;
  const how = '要删就改 sections，把这几句从段里拿掉（把段拆开、跳过这几句）';
  if (!left) errors.push(`cuts 第 ${i + 1} 条（${c.from}–${c.to}）写的是删掉，可是${hits.join('，')}，一句都没删掉：cuts 只写原因，不会真删。${how}；本来就要留的话，把这条 cuts 去掉或改成真删掉的范围`);
  else warns.push(`cuts 第 ${i + 1} 条（${c.from}–${c.to}）里${hits.join('，')}，剪的时候这几句照样在：${how}；只是范围写宽了，就把 cuts 改准`);
});
// 片头钩子用的句子在 cuts 里写着删掉、正文里也没有：成品片头照样会放这几句（cuts 只写原因，不会真删）。
// 说出来让主理人确认；删的原因是隐私、不同意这类的，直接拦下（v0.7 审查 23）
const hookCut = new Set();
for (const h of parts.filter((x) => x.hook)) {
  const ids = [];
  for (let id = h.p.from; id <= h.p.to; id++) if (!inBody.has(id)) ids.push(id);
  const cs = planCuts.map((c, i) => ({ c, i })).filter(({ c }) => isId(c?.from) && isId(c?.to) && ids.some((id) => id >= c.from && id <= c.to));
  if (!cs.length) continue;
  hookCut.add(h);
  const why = cs.map(({ c }) => c.why).filter((w) => typeof w === 'string' && w.trim());
  const serious = why.some((w) => /隐私|不同意|不让|不想公开|不公开|不能发|别发|不要发|敏感|保密|风险/.test(w));
  // 原因写的就是"只当片头用"（照旧规则"每段删减都写原因"写的，补录只当片头很常见）：是有意的，不提醒（2026-11-24 复核）
  // 只认明说"只放片头"的写法（只当片头、片头用、片头已经有了……）；"不适合放片头""钩子不好，删"这种意思正相反的照样提醒
  // （2026-11-24 第 3 轮 16：以前带"片头""钩子"两个字就不提醒）
  // "不当片头用""钩子用不上，删""片头用不着"也是"别放片头"：肯定的写法里含"当片头""片头用"，否定要单独认（2026-11-24 第 3 轮复核 16）
  // 一条条补否定词收不住（"放片头不合适""当钩子太弱""用作片头会剧透"……，第 4 轮复核）：改成只认明说"只放片头 / 片头已经有了"的，
  // 光写"当片头""片头用"的不算；"片头"后面同一小句里又有不、别、没的（"只放片头不合适"）照样提醒。拿不准就提醒（提醒只是建议，不挡）
  const hookOnlyWhy = (w) => /只(当|在|用作?|放|留)(在|作|成|给)?(片头|钩子)|(片头|钩子)里?已经(有了|用了|放了|用过)|(片头|钩子)里?用(过|了)/.test(w)
    && !/(片头|钩子)[^，,。；;]*?(不|别|没|太|会)|不(适合|合适|宜)|换掉|换一句/.test(w);
  if (!serious && why.length && why.every(hookOnlyWhy)) continue;
  // 只在片头用、正文没有的句子不算删掉，不用写进 cuts：这条 cuts 整条都是片头用的句子，去掉就行；范围更宽的，把这几句从范围里拿掉
  const inHook = (c) => { for (let id = c.from; id <= c.to; id++) if (inBody.has(id) || !(id >= h.p.from && id <= h.p.to)) return false; return true; };
  const fix = cs.every(({ c }) => inHook(c)) ? `cuts 里这条去掉就行` : `把这几句从 cuts 的范围里拿掉`;
  (serious ? errors : warns).push(`片头钩子${h.where}用的${rng(h.p.from, h.p.to)}在 cuts 第 ${cs.map(({ i }) => i + 1).join('、')} 条里写着删掉${why.length ? `（原因：${why.join('；')}）` : ''}，正文里也没有这几句，可是片头照样会放：${serious ? '照这个原因不能放在片头，换一句' : `是有意只放在片头的话（念摘要时说清楚这句正文里没有），${fix}：只在片头用、正文里没有的句子不算删掉，不用写原因；不是的话换一句`}`);
}
// 机器草稿里的占位、草稿的"说明"
const todo = planTodos(plan);
if (todo) warns.push(`还有 ${todo} 处写着"待改"（${TODO_WHERE}）：这是机器草稿里的占位，给主理人看之前改掉`);
if (typeof plan['说明'] === 'string' && /机器草稿|不要直接改这个文件/.test(plan['说明'])) warns.push('编排方案.json 里还留着草稿的"说明"一栏：那段话说的是草稿，不是这个文件（这个文件就是要改的），删掉这一栏');

// ---- 配乐：和 build.mjs 用同一个解析（lib/library.mjs 的 resolveMusic），这里就把写错的拦下来 ----
// 节目档案的问题（片头片尾找不到、太长或读不出来，响度写错）单独列，说清楚要改的是档案，不是编排方案（2026-11-22 审查 #57、#59）
let musicLine = '', mus = null, hasOutro = false, hasIntro = false, show = null;
const showErrors = [];
try { show = loadShow(e); } catch (err) { showErrors.push(err.message); }
{ const note = showRef(e).note; if (note) warns.push(note); }
for (const k of ['片头', '片尾']) {
  try { const p = showAsset(show, k); if (p) { if (k === '片头') hasIntro = true; else hasOutro = true; const bad = showClipBad(k, p, duration(p)); if (bad) showErrors.push(bad); } } catch (err) { showErrors.push(err.message); }
}
try { targetLufs(show); } catch (err) { showErrors.push(err.message); }
try {
  mus = resolveMusic(plan, { work: e.work, assets: show?.assets, showMusic: () => showAsset(show, '配乐') });
  // 只写真会放进去的：有节目片头或没有钩子时不铺片头音乐，有节目片尾时不铺片尾音乐，只有一个板块时没有过渡
  const nBodies = sections.filter((s) => s?.kind !== 'hook').length, nHooks = sections.length - nBodies;
  const why = { 片头: hasIntro ? '用节目片头，不铺音乐' : !nHooks ? '没有片头钩子，不铺音乐' : null, 过渡: nBodies < 2 ? '只有一个板块，没有过渡' : null, 片尾: hasOutro ? '用节目片尾，不铺音乐' : null };
  const src = { 方案: '这期选的', 档案: '照节目档案', 默认: '默认' };
  musicLine = `配乐：${PARTS.map((k) => `${k} ${why[k] ? `（${why[k]}）` : `${musicName(mus[k])}${mus[k] ? `，${src[mus[k].from]}` : ''}`}`).join('；')}${plan.musicWhy ? `。为什么：${plan.musicWhy}` : ''}`;
  if (plan.music != null && plan.music !== false && !plan.musicWhy) warns.push('选了配乐但没写为什么（musicWhy）：一句话说清这期为什么配这首，给主理人看');
  // 曲子比要铺的短：build 不循环，放完就淡出。先说出来，主理人确认前就知道（v0.7 审查 65）
  const hk = parts.filter((x) => x.hook);
  // 片头要铺多长：和 build 一样按实际剪下来的片段算（makeClipper），说的秒数和 build、finish 一致；算不出来的段退回句子时间估
  const clipper = makeClipper(full);
  const need = { 片头: introBedSeconds(hk.map((x) => { try { return clipper.partSeconds(x.p); } catch { return x.dur; } })), 过渡: PKG.section + 0.9, 片尾: 13 };
  for (const k of PARTS) {
    const x = mus[k];
    if (!x || why[k] || (k === '过渡' && x.track?.kind === '过渡音')) continue;
    const L = x.track?.seconds ?? (fs.existsSync(x.file) ? duration(x.file) : 0);
    if (L > 0 && L < need[k] - 0.5) warns.push(`${k}的配乐 ${musicName(x)} 只有 ${Math.round(L)} 秒，${k}要铺约 ${Math.round(need[k])} 秒：剪的时候放完就淡出、不重复。${k === '片头' ? '想铺满就换一首长一点的' : '换一首长一点的，或者就这样'}`);
  }
} catch (err) { (/^节目档案里"配乐"/.test(err.message) ? showErrors : errors).push(/^节目档案/.test(err.message) ? err.message : `配乐：${err.message}`); }
// 选了不处理（raw）只调整体音量，不分段调平：用到的补录（别的录音文件）比正片轻或响很多，成品里照样差这么多（2026-11-22 审查：raw 时补录轻 5.6 dB）
if (recP && effectiveVoice(plan, show) === 'raw') {
  const lv = readJson(e.levels, null)?.segs ?? [];
  const loud = recP.map((rp) => {
    let w = 0, sum = 0;
    for (const s of lv) { const a = Math.max(s.start, rp.start), b = Math.min(s.end, rp.start + (rp.dur ?? Infinity)); if (b > a && Number.isFinite(s.db)) { w += b - a; sum += (b - a) * s.db; } }
    return w >= 3 ? sum / w : null;
  });
  const usedK = new Set(parts.map(fileOf));
  const main = recP.reduce((m, rp, k) => (loud[k] != null && (m < 0 || rp.dur > recP[m].dur) ? k : m), -1);
  if (main >= 0) for (const k of usedK) {
    if (k === main || loud[k] == null) continue;
    const d = loud[k] - loud[main];
    if (Math.abs(d) >= 3) warns.push(`「${recP[k].name}」比「${recP[main].name}」${d < 0 ? '轻' : '响'}约 ${Math.abs(d).toFixed(0)} dB，人声处理选的是不处理（raw）：只调整体音量、不分段拉齐，成品里它照样${d < 0 ? '轻' : '响'}这么多。要拉齐就把 voice 改成 "processed"；还是不处理的话，先告诉主理人`);
  }
}

if (errors.length || showErrors.length) {
  if (errors.length) console.error(`编排方案有 ${errors.length} 处要改（全列在这里了，一起改完再跑）：\n${errors.map((x) => '  · ' + x).join('\n')}`);
  if (showErrors.length) console.error(`节目档案有 ${showErrors.length} 处要改（改的是 ${show?.file ?? '节目档案/档案.md'}，编排方案不用动）：\n${showErrors.map((x) => '  · ' + x).join('\n')}`);
  if (warns.length) console.error(`另外要留意：\n${warns.map((w) => '  · ' + w).join('\n')}`);
  process.exit(1);
}
// 选中的曲库曲子现在就下好：网络有问题，在主理人确认之前就知道，不会等到 build 才悄悄换成默认曲
if (mus) {
  const ids = [], bad = [];
  for (const t of new Set(PARTS.map((k) => mus[k]?.track).filter((t) => t?.url))) if (!(await trackGood(t))) { ids.push(t.id); if (trackReady(t)) bad.push(t.id); } // 文件坏了也算没有（v0.7 审查 69）
  if (ids.length) {
    console.log(`下载这期选的配乐（${ids.join('、')}）${bad.length ? `；本地的 ${bad.join('、')} 文件大小对、内容坏了，删掉重下` : ''}……`);
    const r = await getMusic({ ids, log: () => {} });
    const miss = ids.filter((id) => !r.got.includes(id));
    // 说出真正的原因（校验不对、404、连不上……），不一律说成网络问题（v0.7 审查 66）
    if (miss.length) warns.push(`配乐 ${miss.map((id) => `${id}（${r.why?.[id] ?? '原因不明'}）`).join('、')} 没下载下来。现在不处理的话，build 时会再试一次，还不行就换成默认的 Aurora（会提醒）；也可以先运行 ${cmd('music.mjs', '--download')}`);
  }
}
// ---- 3. 删减清单：正文没选进去的连续句子 ----
const kept = new Set();
for (const x of body) for (let id = x.p.from; id <= x.p.to; id++) kept.add(id);
// 只在片头钩子里用的句子（比如补录只当片头）：不算删掉，不要求写删减原因，删减清单里单独写一行（2026-11-22 审查）
const hookOnly = new Set();
for (const x of parts) if (x.hook) for (let id = x.p.from; id <= x.p.to; id++) if (!kept.has(id)) hookOnly.add(id);
const used = (id) => kept.has(id) || hookOnly.has(id);
const cuts = [];
for (let id = 1; id <= full.length; id++) {
  if (used(id)) continue;
  let to = id; while (to + 1 <= full.length && !used(to + 1)) to++;
  const why = planCuts.filter((c) => isId(c?.from) && isId(c?.to) && c.to >= id && c.from <= to && typeof c.why === 'string' && c.why.trim()).map((c) => c.why);
  cuts.push({ from: id, to, start: byId.get(id).start, end: byId.get(to).end, why });
  id = to;
}
const noWhy = cuts.filter((c) => !c.why.length && c.end - c.start >= 8);
if (noWhy.length) warns.push(`${noWhy.length} 段删减没写原因（${noWhy.slice(0, 5).map((c) => `${c.from}–${c.to}`).join('、')}${noWhy.length > 5 ? '……' : ''}），在 cuts 里补上`);
// 删掉的句子挨着一条 cuts、却不在它写的范围里（比如 cuts 写 12–26，实际删了 11–26）：多半是相邻段的编号写错（--refresh 收下了截短的段），
// 不提醒的话第 11 句就悄悄借用了那条的原因
// 编号压成区间（331–390），区间太多只写头尾和句数；这类一多（旧方案 cuts 按单句写、板块整段删掉）合成一条，
// 不再一条条列几百个编号（2026-11-24 第 3 轮 9）
const spans = (ids) => { const r = []; for (const id of ids) { const l = r.at(-1); if (l && id === l[1] + 1) l[1] = id; else r.push([id, id]); } return r; };
const spanText = (r) => r.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join('、');
const loose = [];
for (const c of cuts) {
  if (!c.why.length) continue;
  const out = [];
  for (let id = c.from; id <= c.to; id++) if (!planCuts.some((x) => isId(x?.from) && isId(x?.to) && id >= x.from && id <= x.to)) out.push(id);
  const len = out.reduce((s, id) => s + byId.get(id).end - byId.get(id).start, 0);
  if (!out.length || len < 3) continue;
  const r = spans(out);
  loose.push({ c, n: out.length, text: r.length <= 3 ? spanText(r) : `${out[0]}–${out.at(-1)} 里的 ${out.length}` });
}
const LOOSE_FIX = '确认是要删就把 cuts 的范围写准；不是要删，多半是相邻那段的句子编号写错了';
if (loose.length > 3) warns.push(`有 ${loose.length} 段删减（共 ${loose.reduce((s, x) => s + x.n, 0)} 句）不在 cuts 写的范围里，和旁边写了原因的删减连成了一段：${loose.slice(0, 5).map((x) => `第 ${x.text} 句（连进 ${x.c.from}–${x.c.to}）`).join('、')}${loose.length > 5 ? ' 等' : ''}。多半是 cuts 按单句写、板块却整段删掉了：${LOOSE_FIX}`);
else for (const x of loose) warns.push(`删掉的第 ${x.text} 句不在 cuts 写的范围里，和旁边写了原因的删减连成了一段（${x.c.from}–${x.c.to}）：${LOOSE_FIX}`);
const cutTotal = cuts.reduce((s, c) => s + c.end - c.start, 0);

// ---- 4. 时长 ----
const nBody = new Set(body.map((x) => x.si)).size;
const hooks = parts.filter((x) => x.hook);
const nHook = hooks.length;
const speech = parts.reduce((s, x) => s + x.dur, 0);
const pack = (nHook ? PKG.hookLead + PKG.afterHook + PKG.betweenQuotes * (nHook - 1) : 0) + PKG.section * Math.max(0, nBody - 1) + (hasOutro || mus?.['片尾'] ? PKG.tail : 2); // 片尾没音乐也没节目片尾：只留 2 秒，和 build 一致
const totalLen = full.at(-1).end;
const est = speech + pack;
// 目标时长：节目信息里还是模板的提示（"（……比如 35–40）"）就是没填，不能当成主理人定的目标
const targetRaw = readInfo(e)['目标时长'];
const target = infoBlank(targetRaw) ? undefined : targetRaw.match(/\d+(\.\d+)?/g)?.map(Number);
const [lo, hi] = target?.length ? [Math.min(...target), Math.max(...target)] : [];
if (target?.length && (est / 60 < lo * 0.95 || est / 60 > hi * 1.05)) warns.push(`预计成品 ${mins(est)}，目标是 ${lo === hi ? lo : `${lo}–${hi}`} 分钟`);

// ---- 4.5 像不像一份编排（只提醒，不挡）：没有钩子、板块太多、一句没删 / 还是草稿那几块 ----
const prefs = show?.get?.('剪辑偏好') ?? '';
if (!nHook && !/(不要|不放|不加|不用|别放|别加|去掉|取消)[^，。；\n]{0,6}钩子|钩子[^，。；\n]{0,4}(不要|不用|去掉)/.test(prefs)) warns.push('没有片头钩子（kind: "hook" 的板块）：编排原则要挑 3–4 句原话放在开头；主理人或节目档案的剪辑偏好说了不要钩子的话不用管');
if (nBody > 9) warns.push(`片头以外有 ${nBody} 个板块，编排原则是正文 4–7 个、再加开场和结尾：看看能不能按话题合并`);
const draft = readJson(e.draft, null);
const ranges = (secs) => JSON.stringify((Array.isArray(secs) ? secs : []).filter((s) => s?.kind !== 'hook').map((s) => (Array.isArray(s?.parts) ? s.parts : []).map((p) => [p?.from, p?.to])));
if (Array.isArray(draft?.sections) && ranges(draft.sections) === ranges(sections)) warns.push('板块和句子范围跟机器草稿一模一样（草稿是按停顿机械切的，2–4 分钟一块）：要按话题合并板块、加片头钩子、挑出要删的；主理人说过就这样不动的话可以不管');
else if (!cuts.length) warns.push('一句都没删（全文都留着）：确认这是主理人要的，不然按编排原则"删什么"挑出要删的');
// 谁在说：有称呼用称呼，没有用机器分的编号（A、B……）；还没分说话人就不说
const who = (from, to) => {
  const share = {}; let n = 0;
  for (const s of full.slice(from - 1, to)) { if (!s.speaker) continue; const k = s.name || s.speaker; share[k] = (share[k] ?? 0) + s.text.length; n += s.text.length; }
  const ks = Object.entries(share).sort((a, b) => b[1] - a[1]);
  if (!n) return '';
  return ks[0][1] / n >= 0.9 ? ks[0][0] : ks.filter(([, v]) => v / n >= 0.2).map(([k]) => k).join('、') || ks[0][0];
};
// 删光了某个人：说话超过 1 分钟的人，正文里一句都没留
{
  const talk = {}, keptBy = new Set();
  for (const s of full) if (s.speaker) { const k = s.name || s.speaker; talk[k] = (talk[k] ?? 0) + s.end - s.start; if (kept.has(s.id)) keptBy.add(k); }
  const gone = Object.keys(talk).length > 1 ? Object.entries(talk).filter(([k, t]) => t >= 60 && !keptBy.has(k)) : [];
  for (const [k, t] of gone) warns.push(`${k} 说的话正文里一句都没留（原来约 ${dur(t)}）：要删光一个人的发言，先问主理人`);
}

// ---- 5. 念给主理人听的摘要：几行大白话，聊天里直接说 ----
// 还有"待改"、删减没写原因时不是给主理人听的：先说"先别给主理人看"，摘要只给 AI 自己看
const notReady = [todo && `还有 ${todo} 处"待改"`, noWhy.length && `${noWhy.length} 段删减没写原因`].filter(Boolean);
const bodyNames = sections.filter((s) => s.kind !== 'hook').map((s) => s.name);
const big = [...cuts].sort((x, y) => (y.end - y.start) - (x.end - x.start)).filter((c) => c.end - c.start >= 20).slice(0, 4);
const snip = (t, n = 14) => (t.length > n ? `${t.slice(0, n)}……` : t);
const hookText = (x) => {
  let t = bare(full.slice(x.p.from - 1, x.p.to).map((s) => s.text).join(''));
  if (typeof x.p.startText === 'string') { const k = t.indexOf(bare(x.p.startText)); if (k > 0) t = t.slice(k); }
  return snip(t);
};
const say = [
  `原来录了 ${fmt(totalLen)}，剪完约 ${mins(est)}${target?.length ? `（你定的目标是 ${lo === hi ? lo : `${lo}–${hi}`} 分钟）` : ''}。`,
  `${nHook ? `开头先放 ${nHook} 段原话当片头：${hooks.map((x) => `${who(x.p.from, x.p.to)}「${hookText(x)}」${hookCut.has(x) ? '（这句正文里删了，只在片头放）' : ''}`).join('、')}；然后` : ''}正文分 ${bodyNames.length} 个板块：${bodyNames.map((n) => `「${n}」`).join('')}。`,
  cuts.length ? `整段删掉的一共 ${cuts.length} 处、约 ${dur(cutTotal)}${big.length ? `，最大的${big.length > 1 ? ` ${big.length} ` : '一'}处是：` : '。'}` : '一句都没删（全文都留着），只缩短了长停顿、去掉了段首的"呃""嗯"。',
  ...big.map((c) => { const w = who(c.from, c.to); return `· 第 ${c.from}–${c.to} 句（原来 ${fmt(c.start)} 起，${dur(c.end - c.start)}${w ? `，${w} 说的` : ''}，"${snip(bare(full.slice(c.from - 1, c.to).map((s) => s.text).join('')))}"）：${c.why.length ? c.why.join('；') : '还没写原因'}`; }),
  ...(moved ? [`有 ${moved} 处调了原来的顺序，请特别听一下前后接得上不上。`] : []),
];

// ---- 6. 写报告 ----
const md = [`# 编排方案：${plan.title ?? '（还没定标题）'}`, ''];
if (plan.titleOptions?.length) md.push('**标题备选**', '', ...plan.titleOptions.map((t, i) => `${i + 1}. ${t}`), '');
if (plan.theme) md.push(`**一句话主题**：${plan.theme}`, '');
md.push(notReady.length ? `**先说结论**（还没改完：${notReady.join('，')}，先别给主理人看）` : '**先说结论**', '');
for (const l of say) { if (l.startsWith('· ')) md.push(`- ${l.slice(2)}`); else { if (md.at(-1).startsWith('- ')) md.push(''); md.push(l, ''); } }
if (md.at(-1) !== '') md.push('');
md.push(`原始录音 ${fmt(totalLen)}，保留的人声约 ${mins(speech)}（已扣掉缩短的长停顿），加上片头片尾和过渡音乐约 ${mins(pack)}，**成品约 ${mins(est)}**。人声处理：${effectiveVoice(plan, show) === 'raw' ? '不处理' : '分人调平 + 低切降噪 + 轻度压缩'}${!plan.voice && showVoice(show) ? '（按节目档案）' : ''}。`, '', `${musicLine}。`, '');
// 几个录音前后接着拼起来的：原位置是拼起来以后的时间，后面括号里写是哪个文件第几秒
if (recP) md.push(`这期是 ${recP.length} 个录音前后接着拼起来的（${recP.map((p) => `${p.name} 从 ${fmt(p.start)} 起`).join('、')}）。下面的原位置是拼起来以后的时间，括号里是哪个文件第几秒。`, '');
md.push('## 编排', '', '| 板块 | 内容 | 句子 | 原位置 | 时长 |', '|---|---|---|---|---|');
for (const sec of sections) {
  const xs = parts.filter((x) => x.sec === sec);
  xs.forEach((x, i) => md.push(`| ${i ? '' : `**${sec.name}**`} | ${x.p.label ?? ''} | ${x.p.from}–${x.p.to} | ${fmt(x.start)}–${fmt(x.end)}${inFile(recP, x.start)} | ${Math.round(x.dur)} 秒 |`));
  md.push(`| | *小计* | | | *${mins(xs.reduce((s, x) => s + x.dur, 0))}* |`);
}
const hasWho = full.some((s) => s.speaker);
md.push('', '## 删减清单', '', `正文没用到的整段，共 ${mins(cutTotal)}。句中的"呃""嗯"和长停顿另外自动处理，不在表里。`, '',
  `| 句子 | 原位置 | 时长 |${hasWho ? ' 谁在说 |' : ''} 开头 | 为什么删 |`, `|---|---|---|${hasWho ? '---|' : ''}---|---|`);
for (const c of cuts) md.push(`| ${c.from}–${c.to} | ${fmt(c.start)}–${fmt(c.end)}${inFile(recP, c.start)} | ${Math.round(c.end - c.start)} 秒 |${hasWho ? ` ${who(c.from, c.to)} |` : ''} ${bare(full.slice(c.from - 1, c.to).map((s) => s.text).join('')).slice(0, 24)}…… | ${c.why.join('；') || '（没写原因）'} |`);
if (hookOnly.size) { const ids = [...hookOnly].sort((a, b) => a - b); md.push('', `只在片头钩子里用、正文里没有的（不算删掉）：第 ${ids.join('、')} 句，共 ${Math.round(ids.reduce((s, id) => s + byId.get(id).end - byId.get(id).start, 0))} 秒。`); }
if (warns.length) md.push('', '## 要留意', '', ...warns.map((w) => `- ${w}`));
try { writeText(e.planMd, md.join('\n') + '\n'); } catch (err) { console.error(err.message); process.exit(1); } // 只读、被占着的说清楚（审查 80）
// 记下每段的原文和这次检查的指纹（全文的编号、方案文件、决定声音的部分）：build、status 靠它判断"检查过没有"。编排方案.json 一个字节都不动
writeJson(e.anchors, {
  note: 'plan.mjs 检查通过时记的：每段开头结尾的原文（重新识别后核对时，同一板块里先按原文找、再按小标题、最后按第几段）、全文句子编号的指纹、方案的指纹。重新识别后编号错位、方案改了没检查，都靠它拦下来。别删',
  full: fp, file: fileSha(e.plan), audio: planSha(plan, 'audio'), parts: anchorsNow,
});
if (fs.existsSync(e.anchorsOld)) fs.rmSync(e.anchorsOld, { force: true }); // 旧位置（制作文件/）的挪过来了

const sayText = say.map((l) => (l.startsWith('· ') ? `    ${l}` : `  ${l}`)).join('\n');
console.log(`编排方案检查通过：${sections.length} 个板块，成品约 ${mins(est)}，删掉 ${cuts.length} 段共 ${mins(cutTotal)}。报告写到 编排方案.md`);
if (notReady.length) console.log(`\n先别给主理人看：${notReady.join('，')}（见下面"要留意"）。改完重跑 ${cmd('plan.mjs', e.work)}，出现"可以直接念给主理人听"再念。\n\n草稿摘要（给你自己看，先别念）：\n${sayText}`);
else console.log(`\n可以直接念给主理人听：\n${sayText}`);
if (warns.length) console.log(`\n要留意：\n${warns.map((w) => '  · ' + w).join('\n')}`);
// 以前确认过编排、这次又改了：说清楚要重新确认才能剪（locate、status 也这么说，v0.7 审查 26）
if (!notReady.length) {
  const cp = readJson(e.state, null)?.confirmed?.['编排'];
  if (cp && !cp.skipped && cp.sha !== planSha(plan, 'edit') && cp.sha !== fileSha(e.plan)) console.log(`\n下一步：这期的编排确认过，之后方案改了。把上面的摘要念给主理人（或者给他看 编排方案.md），他同意后运行 ${cmd('status.mjs', e.work, '--confirm', '编排')}，再运行 ${cmd('finish.mjs', e.work)}（不重新确认，finish 不剪）`);
}
