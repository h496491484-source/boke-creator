#!/usr/bin/env node
// 识别结果（+ 分说话人结果 + 说话人.md 里填的名字）→ 全文.json / 全文.txt，顺带出 全文提纲.md 和 编排方案.草稿.json。
// transcribe.mjs 和 speakers.mjs 会自动调用；主理人在 说话人.md 里填好名字后，单独跑一次把名字换进全文：
//
//   node tools/podcast/fulltext.mjs <节目目录>
//
// 全文.json 每句：{ id, start, end, speaker(编号 A/B…，没分说话人时为空), name(填过的称呼), text, toks:[{t 字, s 起始秒}] }
// 句子编号是 编排方案.json 定位用的。重新识别后编号会变，编排方案里每段记着原文，plan.mjs 会发现对不上。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { episode, readJson, writeJson, fmt, PUNCT, writeOutline, cmd, mustExist, sha, recParts, partAt, fullBusy, roFix } from '../lib/podcast.mjs';
import { loadShow, applyFixes } from '../lib/show.mjs';

const END = /^[。！？.!?]$/;
export const MIN_SPEAKER_SECONDS = 40; // 总共说不到这么多秒的"说话人"多半是插话、附和、串音的碎片，并到相邻的人

// 说话人.md 里填的称呼：表格每行 | 点名音频里 | 编号 | 说了多久 | 这段原声在原录音 | 开头的话 | 是谁 |。
// 主理人手填，常见填错：竖线多了少了、编号改了或写成小写、同一个编号写了两行、一行填两个人、填了"可能是老王"这类说明。
// 以前这些行悄悄跳过（称呼就是没换进全文，谁也不知道为什么）；现在每处记下第几行、什么问题（issues），fulltext 和 status 都打出来。
// valid：这期实际有的编号（不给就不查"编号不存在"）。返回 { names: { A: '老王' }, issues: [{ line, text, why, used }] }
const UNSURE = /可能|好像|应该是|大概|也许|不确定|不知道|不清楚|认不出|听不出|待定|待确认|猜|像是|还是|或者|[?？]/;
export function parseNames(e, valid = null) {
  const names = {}, issues = [], seen = {};
  if (!fs.existsSync(e.names)) return { names, issues };
  fs.readFileSync(e.names, 'utf8').replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    // 表格行很长，要紧的"是谁"在最后：太长时留结尾
    const note = (why, used = false) => issues.push({ line: i + 1, text: line.length > 50 ? `……${line.slice(-40)}` : line, why, used });
    if (!line.startsWith('|')) {
      if (/^[-*]?\s*[A-Z]\s*[=＝:：]\s*\S/.test(line)) note('称呼要填进上面表格对应那一行的"是谁"一栏，写在表格外面不认');
      return;
    }
    if (/^\|[\s|:：\-—]*$/.test(line) || (line.includes('编号') && line.includes('是谁'))) return; // 表头、分隔行
    const c = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((x) => x.trim());
    if (c.length !== 6) { note(`表格这一行应该是 6 栏，现在是 ${c.length} 栏：竖线 | 多了或少了（称呼里别用 |，也别删栏、别加栏）`); return; }
    const id = c[1];
    let who = c[5];
    if (!/^[A-Z]$/.test(id)) { note(/^[a-z]$/.test(id) ? `编号「${id}」要用大写字母 ${id.toUpperCase()}` : `编号一栏写成了「${id || '空的'}」，应该是一个大写字母（A、B、C……），这一栏别改`); return; }
    if (valid?.size && !valid.has(id)) { note(`这期没有编号 ${id}（现有 ${[...valid].sort().join('、')}），这一行不认`); return; }
    if (seen[id]) { note(`编号 ${id} 写了两行（第 ${seen[id]} 行也是 ${id}），只认第一行`); return; }
    seen[id] = i + 1;
    if (!who || /^[-—]+$/.test(who)) return; // 空着 = 认不出来，正常
    if (/[、,，;；/／&＆+＋]/.test(who)) { note(`一行只能填一个称呼，这里写了「${who}」：这个编号里真混着两个人的话，填说得多的那个，或者空着；这一行先不用`); return; }
    if (UNSURE.test(who)) { note(`「${who}」像是说明或猜测，不是称呼：拿不准就空着，确定了再填；这一行先不用`); return; }
    const bare = who.replace(/[（(][^）)]*[）)]/g, '').trim();
    if (bare !== who) {
      if (!bare) { note(`「${who}」整个在括号里，像是说明：称呼栏只写称呼；这一行先不用`); return; }
      note(`称呼栏里括号的部分（「${who}」）没进全文，已经按「${bare}」用上了（只是提醒，不用改）`, true);
      who = bare;
    }
    // 太长的多半是写了说明。英文名（字母、空格、点、连字符）可以写全名，放宽到 30 个字母
    const latin = /^[A-Za-z][A-Za-z .'’·-]*$/.test(who);
    if (who.length > (latin ? 30 : 12)) { note(`「${who}」太长了，像是写了说明：称呼栏只写怎么称呼这个人（比如"老王""主持人小李"；中文 12 个字以内，英文名 30 个字母以内）；这一行先不用`); return; }
    names[id] = who;
  });
  return { names, issues };
}
export const readNames = (e) => parseNames(e).names;
// 说话人.md 里主理人手填的原样内容：编号是大写字母、"是谁"不空也不是一串横线的行，不管填得合不合规矩（"可能是小李""老王、老张"也算）。
// speakers.mjs 重新生成 说话人.md 时用它：要不要先备份（说话人_上一版.md）、没重新分说话人时原样填回去，不能因为填得不合规矩就丢掉（2026-11-20 审查 F3）
export function rawNames(e) {
  const out = {};
  if (!fs.existsSync(e.names)) return out;
  for (const raw of fs.readFileSync(e.names, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const c = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((x) => x.trim());
    const id = c[1], who = c.at(-1);
    if (c.length < 6 || !/^[A-Z]$/.test(id ?? '') || !who || /^[-—]+$/.test(who) || id in out) continue;
    out[id] = who;
  }
  return out;
}
// 说话人.md 里给 AI 照抄的命令（"填完运行 `…fulltext.mjs …`"、"运行 `…show.mjs --learn …`"）：写的是生成时的技能和节目路径，
// 节目目录复制、挪过就指错地方；更早的版本还是 "node tools/podcast/fulltext.mjs <节目目录>" 这种半截命令。
// status 和 fulltext 每次运行时换成现在的完整命令，表格一个字不动。"认人"确认记的是整个文件的指纹：确认过、文件没被别的改过的，跟着换成新指纹
export function refreshNamesCmds(e) {
  try {
    if (!fs.existsSync(e.names)) return false;
    const old = fs.readFileSync(e.names, 'utf8');
    const now = old
      .replace(/(填完运行 )`[^`\n]*fulltext\.mjs[^`\n]*`/g, (_, a) => `${a}\`${cmd('fulltext.mjs', e.work)}\``)
      .replace(/(运行 )`[^`\n]*show\.mjs[^`\n]*--learn[^`\n]*`/g, (_, a) => `${a}\`${cmd('show.mjs', '--learn', e.work)}\``);
    if (now === old) return false;
    const before = sha(old);
    const tmp = e.names + '.part';
    fs.writeFileSync(tmp, now, 'utf8');
    fs.renameSync(tmp, e.names);
    const st = readJson(e.state, null);
    const c = st?.confirmed?.['认人'];
    if (c?.sha && c.sha === before) { c.sha = sha(now); writeJson(e.state, st, 2); }
    return true;
  } catch { try { fs.rmSync(e.names + '.part', { force: true }); } catch {} return false; } // 说话人.md 是只读的时候改名失败：别留下 .part（审查 80）
}
// 打给 AI 看的一段：哪几行、什么问题、改好以后跑什么。
// 真填错、这一行没认的（used: false）要请主理人改；已经照用了的（括号里的说明去掉了，used: true）只是提醒，不用改、不用重跑
export function namesIssueText(issues, rerun) {
  const bad = issues.filter((x) => !x.used), used = issues.filter((x) => x.used);
  const out = [];
  if (bad.length) out.push(`说话人.md 有 ${bad.length} 处填得不对（没认的行，那个编号的称呼不会换进全文），请主理人改好后运行 ${rerun}：\n`
    + bad.map((x) => `  第 ${x.line} 行：${x.why}。这一行是：${x.text}`).join('\n'));
  if (used.length) out.push(`说话人.md 提醒（称呼已经用上了，不用改）：${used.map((x) => `第 ${x.line} 行：${x.why.replace(/（只是提醒，不用改）$/, '')}`).join('；')}`);
  return out.join('\n');
}

// 说话人分段的来源：'model'（声纹模型分的，要并掉碎片）或 'tracks'（多轨按音轨认的，每条轨就是一个人）
export const diarSource = (e) => readJson(path.join(e.mid, '说话人来源.json'), { source: 'model' });

// parts：前后接着拼起来的几个录音（recParts）。短补录（几十秒的开场、过渡）里只有一个人说话，总共不到 minSeconds，
// 以前被当成插话碎片并掉：第一句算到相邻的人头上，后面几句没有说话人（2026-11-24 第 3 轮终检）。
// 现在某个编号在哪个录音里占了这个录音一半以上的说话时间（至少 3 秒），就算一个说话人，不当碎片
export function speakerLabels(diar, minSeconds = MIN_SPEAKER_SECONDS, parts = null) {
  const all = {};
  for (const d of diar) all[d.speaker] = (all[d.speaker] ?? 0) + d.end - d.start;
  // 录音很短、谁都没说够 minSeconds：不能一个编号都不留（声音点名会出错、说话人.md 永远出不来），
  // 留下说得最多的那个，和说得不比他少太多（三成以上）的
  const longest = Math.max(0, ...Object.values(all));
  if (longest > 0 && longest < minSeconds) minSeconds = longest * 0.3;
  const keep = new Set();
  if (parts?.length > 1) {
    const by = parts.map(() => ({})), sum = parts.map(() => 0);
    for (const d of diar) parts.forEach((p, k) => {
      const ov = Math.min(d.end, p.start + p.dur) - Math.max(d.start, p.start);
      if (ov > 0) { by[k][d.speaker] = (by[k][d.speaker] ?? 0) + ov; sum[k] += ov; }
    });
    by.forEach((m, k) => { for (const [s, t] of Object.entries(m)) if (t >= 3 && t >= sum[k] * 0.5) keep.add(s); });
  }
  const isMajor = (k) => all[k] >= minSeconds || keep.has(String(k));
  const major = Object.keys(all).filter(isMajor).sort((a, b) => all[b] - all[a]);
  return { segs: diar.filter((d) => isMajor(d.speaker)), label: Object.fromEntries(major.map((k, i) => [k, String.fromCharCode(65 + i)])), total: Object.fromEntries(major.map((k) => [k, all[k]])), fragments: Object.keys(all).length - major.length };
}

// 全文.txt、全文提纲.md 被别的程序占着、只读：写不进去。以前 speakers、fulltext 只打一句英文 EPERM（transcribe 开工前就查，#79），
// 现在 buildFull 一开始就查，说清楚是哪个文件、怎么办；err.busy 是写不进的文件名，调用的地方接"再运行哪条命令"（2026-11-24 第 3 轮 17）
const BUSY_CODES = /^(EBUSY|EPERM|EACCES)$/;
const busyErr = (e, names) => Object.assign(new Error(`${names.join('、')} 被别的程序占着（编辑器、预览窗口开着它），或者是只读的：全文要重写${names.length > 1 ? '这几个文件' : '它'}，写不进去。${roFix(e.work)}`), { busy: names });
export function buildFull(dir) {
  const e = episode(dir);
  const asr = readJson(e.asr, null);
  if (!asr) throw new Error(`还没有识别结果。先运行 ${cmd('transcribe.mjs', e.work)}`);
  const busyNow = fullBusy(e);
  if (busyNow.length) throw busyErr(e, busyNow);
  const diarRaw = readJson(e.diar, null);
  const tracksSrc = diarSource(e).source === 'tracks';
  const { segs: dia, label } = diarRaw ? speakerLabels(diarRaw, tracksSrc ? 3 : MIN_SPEAKER_SECONDS, tracksSrc ? null : recParts(e)) : { segs: [], label: {} };
  const { names, issues: nameIssues } = parseNames(e, new Set(Object.values(label)));

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
      // 只有标点的一小段（比如两个录音接缝处几十毫秒的空白被识别成一个"。"）：接到上一句后面；上一句已经以标点结尾的就不接，免得出现"对。。"
      if (!words.length) { const prev = clauses.at(-1); if (prev && !PUNCT.test(prev.toks.at(-1)?.t ?? '')) prev.toks.push(...cur); cur = []; return; }
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
  // 全文.json 放到最后写（status 拿它当"全文好了"）：全文.txt、提纲、草稿哪个写不进去（被占用、只读），全文.json 就还是旧的、比 识别.json 早，
  // status 认得出"全文没写完"；不会出现 全文.json 是新的、全文.txt 和提纲还是旧的
  // 3. 全文.txt：同一人连续说的合成一段，标时间、说话人、句子编号。
  //    没分说话人（单人、跳过认人）或者只分出一个人时，"同一人连续说"就是整期一大行（几万字，AI 和人都没法读）：
  //    改成按停顿分段，停顿超过 1.5 秒、或这段攒够约 200 字就另起一段。句子编号照旧，只是换行的地方不同
  const who = (s) => (s.speaker ? `${s.speaker}${s.name ? `（${s.name}）` : ''}：` : '');
  const oneVoice = new Set(full.map((s) => s.speaker)).size <= 1;
  const PARA = { pause: 1.5, chars: 200 };
  const lines = [];
  let turn = null;
  // 前后接着拼起来的几个录音：换文件的地方另起一段，前面标一行是哪个文件（AI 认得出哪几句是补录、另一期）
  const rp = recParts(e);
  const fileOf = (s) => partAt(rp, s.start)?.k ?? 0;
  for (const s of full) {
    const join = turn && fileOf(s) === turn.k && (oneVoice ? s.start - turn.end <= PARA.pause && turn.chars < PARA.chars : turn.speaker === s.speaker && s.start - turn.end < 3);
    if (join) { turn.parts.push(`〔${s.id}〕${s.text}`); turn.end = s.end; turn.chars += s.text.length; }
    else { if (turn) lines.push(turn); turn = { start: s.start, end: s.end, speaker: s.speaker, s, k: fileOf(s), parts: [`〔${s.id}〕${s.text}`], chars: s.text.length }; }
  }
  if (turn) lines.push(turn);
  const head = `# 全文（机器识别，错字没校）\n# 〔数字〕是句子编号，编排方案用它定位。${diarRaw ? 'A、B、C… 是机器分的说话人，A 说得最多；括号里是 说话人.md 里填的称呼。' : '还没分说话人。'}${oneVoice ? '按停顿分段（停顿超过 1.5 秒或攒够约 200 字换一段）。' : ''}`
    + `${rp ? `\n# 这期是 ${rp.length} 个录音前后接着拼起来的（${rp.map((p) => p.name).join(' + ')}）：换录音的地方有一行"—— 第 N 个录音……——"，时间是拼起来以后的时间。` : ''}\n\n`;
  const fileMark = (t, i) => (rp && (i === 0 || t.k !== lines[i - 1].k) ? `—— 第 ${t.k + 1} 个录音「${rp[t.k].name}」（拼起来以后从 ${fmt(rp[t.k].start)} 开始）——\n\n` : '');
  const txtTmp = `${e.fullTxt}.part`;
  fs.writeFileSync(txtTmp, head + lines.map((t, i) => `${fileMark(t, i)}[${fmt(t.start)}] ${who(t.s)}${t.parts.join('')}`).join('\n\n') + '\n', 'utf8');
  try { fs.renameSync(txtTmp, e.fullTxt); } catch (err) { fs.rmSync(txtTmp, { force: true }); if (BUSY_CODES.test(err.code ?? '')) throw busyErr(e, [path.basename(e.fullTxt)]); throw err; }
  // 4. 全文提纲.md + 编排方案.草稿.json（lib/podcast.mjs 的 writeOutline）
  const ol = writeOutline(e, full);
  writeJson(e.full, full, 0);
  return { sentences: full.length, turns: lines.length, paragraphs: oneVoice, speakers: Object.keys(label).length, named: Object.keys(names).length, fixed, outline: ol, nameIssues };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error(`用法: ${cmd('fulltext.mjs')} <节目目录>`); process.exit(2); }
  mustExist(dir); // 路径写错、节目目录挪走了：说"没有这个目录"，不要说"还没有识别结果、先转写"
  try {
    refreshNamesCmds(episode(dir));
    const r = buildFull(dir);
    console.log(`全文：${r.sentences} 句，${r.turns} ${r.paragraphs ? '段' : '个发言段'}${r.speakers ? `，${r.speakers} 个说话人，已填称呼 ${r.named} 个` : ''}${r.fixed ? `，按节目档案换了 ${r.fixed} 处常错词` : ''}。写到 全文.txt / 全文.json`);
    if (r.outline) console.log(`提纲：${r.outline.blocks} 块，写到 全文提纲.md；${{ written: '编排方案.草稿.json 也更新了', kept: '编排方案.草稿.json 被改过，没动它', replaced: '编排方案.草稿.json 被改过，但句子编号变了（重新识别过）：改过的那份挪成 编排方案.草稿.旧.json（编号是旧的，别直接用），重新写了草稿' }[r.outline.draft]}`);
    if (r.nameIssues.length) console.log(namesIssueText(r.nameIssues, cmd('fulltext.mjs', episode(dir).work)));
  } catch (err) { console.error(err.busy ? `${err.message}，再运行 ${cmd('fulltext.mjs', episode(dir).work)}（全文.json 还是上次的，没动）` : err.message); process.exit(1); }
}
