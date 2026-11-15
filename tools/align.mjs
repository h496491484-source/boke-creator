#!/usr/bin/env node
// 打轴：把已知的稿子对到"带时间的识别结果"上，得到稿子每个字的时间（timing.json）。零依赖，Node 18+。
//
//   node tools/align.mjs <作品目录> --asr <识别结果.json> [--force]
//
// 思路：稿子永远是已知的，识别结果只用来提供时间，不用来提供文字。
//   - 识别把字认成同音字（凉子→量子）：时间照用，字以稿子为准，不影响结果。
//   - 录音里多说了话（口误、重复）或少读了稿子：报告里列出时间和内容，超过限度就判未通过，
//     由本人决定重录那一句还是改稿。脚本不替人决定。
// 识别结果来自哪个工具都行，只要每个字或词带起止时间。认识这几种格式：
//   [{start,end,text}]、whisper / faster-whisper 的 segments[].words[]、
//   OpenEdit 的 chunks[].words[].timestamp、whisper.cpp 的 transcription[].tokens[].offsets。
// 产出：<作品目录>/timing.json（已有的改名为 timing_上一版.json）和 对齐报告.json。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScript } from './lib/script.mjs';

const strip = (s) => String(s).replace(/[\s\p{P}\p{S}]/gu, '');
const r3 = (n) => Math.round(n * 1000) / 1000;
// 比较时把这些当成同一个字：阿拉伯数字和汉字数字
const NUM = { 〇: '0', 零: '0', 一: '1', 二: '2', 两: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9' };
const key = (ch) => NUM[ch] ?? ch.toLowerCase();

// 判未通过的限度
const LIMIT = { missing: 4, extra: 4, minMatch: 0.8 };

export function loadAsr(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  const push = (text, start, end) => { if (text != null && Number.isFinite(start) && Number.isFinite(end)) out.push({ text: String(text), start, end }); };
  const word = (w) => push(w.text ?? w.word, w.start ?? w.timestamp?.[0], w.end ?? w.timestamp?.[1]);
  if (Array.isArray(data)) data.forEach(word);
  else if (Array.isArray(data.transcription)) { // whisper.cpp，时间单位是毫秒
    for (const seg of data.transcription) for (const t of seg.tokens ?? []) {
      if (/^\[_.*\]$/.test(t.text ?? '')) continue;
      push(t.text, t.offsets?.from / 1000, t.offsets?.to / 1000);
    }
  } else {
    const segs = data.asr_segments ?? data.segments ?? data.chunks;
    if (!Array.isArray(segs)) throw new Error(`${file}: 不认识的识别结果格式`);
    for (const seg of segs) (seg.words ?? []).forEach(word);
  }
  if (!out.length) throw new Error(`${file}: 里面没有带时间的字。识别时要打开"逐词时间"（word timestamps）。`);
  // 拆成一个字一条；一个词里的几个字平分这个词的时间
  const chars = [];
  for (const t of out) {
    const cs = [...strip(t.text)];
    cs.forEach((ch, k) => chars.push({ ch, start: t.start + (t.end - t.start) * k / cs.length, end: t.start + (t.end - t.start) * (k + 1) / cs.length }));
  }
  return chars;
}

// 全局对齐（编辑距离）。返回一串操作：m 相同、s 替换、d 稿子有而录音没有、i 录音多出来
export function alignOps(S, R) {
  const n = S.length, m = R.length, W = m + 1;
  const cost = new Uint32Array((n + 1) * W);
  for (let j = 0; j <= m; j++) cost[j] = j;
  for (let i = 1; i <= n; i++) {
    cost[i * W] = i;
    for (let j = 1; j <= m; j++) {
      const sub = cost[(i - 1) * W + j - 1] + (S[i - 1] === R[j - 1] ? 0 : 1);
      const del = cost[(i - 1) * W + j] + 1, ins = cost[i * W + j - 1] + 1;
      cost[i * W + j] = Math.min(sub, del, ins);
    }
  }
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const c = cost[i * W + j];
    if (i > 0 && j > 0 && c === cost[(i - 1) * W + j - 1] + (S[i - 1] === R[j - 1] ? 0 : 1)) { ops.push(S[i - 1] === R[j - 1] ? 'm' : 's'); i--; j--; }
    else if (i > 0 && c === cost[(i - 1) * W + j] + 1) { ops.push('d'); i--; }
    else { ops.push('i'); j--; }
  }
  return ops.reverse();
}

// 屏幕字和读法不一样长时（"1268段"读作"一千两百六十八段"），屏幕上第 k 个字对应读法里的第几个字。
// 返回数组，对不上的位置是 null。storyboard.mjs 和 beats.mjs 用它给句子中间的记号定时间。
export function mapChars(shown, spoken) {
  const map = new Array(shown.length).fill(null);
  let si = 0, ri = 0;
  for (const op of alignOps(shown, spoken)) {
    if (op === 'm') map[si] = ri;
    if (op !== 'i') si++;
    if (op !== 'd') ri++;
  }
  return map;
}

export function align(scriptChars, asrChars) {
  const ops = alignOps(scriptChars.map(key), asrChars.map((c) => key(c.ch)));
  const timing = new Array(scriptChars.length);
  const issues = [];
  let si = 0, ri = 0, matched = 0, k = 0;
  while (k < ops.length) {
    if (ops[k] === 'm') { timing[si] = { start: asrChars[ri].start, end: asrChars[ri].end }; si++; ri++; matched++; k++; continue; }
    // 一段连续的不一致：稿子里的 [s0, si) 对录音里的 [r0, ri)
    const s0 = si, r0 = ri;
    while (k < ops.length && ops[k] !== 'm') { if (ops[k] !== 'i') si++; if (ops[k] !== 'd') ri++; k++; }
    const sN = si - s0, rN = ri - r0;
    const prevEnd = r0 > 0 ? asrChars[r0 - 1].end : 0;
    const nextStart = ri < asrChars.length ? asrChars[ri].start : (asrChars.at(-1)?.end ?? 0);
    const from = rN ? asrChars[r0].start : prevEnd, to = rN ? asrChars[ri - 1].end : Math.max(prevEnd, nextStart);
    for (let x = 0; x < sN; x++) {
      timing[s0 + x] = sN === rN
        ? { start: asrChars[r0 + x].start, end: asrChars[r0 + x].end }                       // 等长：一个字对一个字
        : { start: from + (to - from) * x / sN, end: from + (to - from) * (x + 1) / sN, est: true }; // 不等长：在这段时间里平分
    }
    const script = scriptChars.slice(s0, si).join(''), heard = asrChars.slice(r0, ri).map((c) => c.ch).join('');
    const kind = !rN ? 'missing' : !sN ? 'extra' : 'differ';
    const serious = (kind === 'missing' && sN >= 2) || (kind === 'extra' && rN >= 2) || (kind === 'differ' && Math.abs(sN - rN) >= 2);
    issues.push({ kind, at: r3(from), to: r3(to), script, heard, serious, script_index: s0, asr_index: r0, asr_count: rN });
  }
  // 时间不许倒着走
  for (let x = 1; x < timing.length; x++) {
    if (timing[x].start < timing[x - 1].start) timing[x].start = timing[x - 1].start;
    if (timing[x].end < timing[x].start) timing[x].end = timing[x].start;
  }
  // 一段不一致里，录音比稿子多出几个字 / 少了几个字（"时"对上"实以打扫实验实"算多出 6 个）
  const worstMissing = Math.max(0, ...issues.map((i) => [...i.script].length - [...i.heard].length));
  const worstExtra = Math.max(0, ...issues.map((i) => [...i.heard].length - [...i.script].length));
  const rate = scriptChars.length ? matched / scriptChars.length : 0;
  const reasons = [];
  if (rate < LIMIT.minMatch) reasons.push(`稿子里只有 ${(rate * 100).toFixed(0)}% 的字在录音里找到，录音和稿子可能不是同一份`);
  if (worstMissing >= LIMIT.missing) reasons.push(`稿子里有连续 ${worstMissing} 个字录音里没读到`);
  if (worstExtra >= LIMIT.extra) reasons.push(`录音里有连续 ${worstExtra} 个字稿子里没有（口误或重复？）`);
  return { timing, issues, matched, rate, passed: !reasons.length, reasons };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--asr');
  const asrFile = opt('--asr');
  if (!target || !asrFile) { console.error('用法: node tools/align.mjs <作品目录> --asr <识别结果.json> [--force]'); process.exit(2); }
  const work = fs.statSync(target).isDirectory() ? path.resolve(target) : path.dirname(path.resolve(target));
  const scriptFile = fs.statSync(target).isDirectory() ? path.join(work, '口播稿.txt') : path.resolve(target);

  const { storyboard: sb, errors } = parseScript(fs.readFileSync(scriptFile, 'utf8'));
  if (errors.length) { errors.forEach((e) => console.log(`错误  ${e}`)); process.exit(1); }
  // 每个字属于哪一句，报告里好指给人看
  const chars = [], owner = [];
  for (const seg of sb.segments) for (const ch of strip(seg.say ?? seg.text)) { chars.push(ch); owner.push(seg); }

  const asr = loadAsr(asrFile);
  const res = align(chars, asr);
  const lineOf = (i) => owner[Math.min(i, owner.length - 1)]?.line;
  const label = { missing: '录音里没读到', extra: '录音里多出来', differ: '识别成了别的字' };
  const serious = res.issues.filter((i) => i.serious), minor = res.issues.filter((i) => !i.serious);

  console.log(`稿子 ${chars.length} 个字，录音里对上 ${res.matched} 个（${(res.rate * 100).toFixed(1)}%）。`);
  if (minor.length) console.log(`提示  有 ${minor.length} 处识别和稿子不一样、但长短相同或只差一个字（多半是同音字），时间不受影响：` +
    minor.slice(0, 12).map((i) => `${i.script || '∅'}→${i.heard || '∅'}`).join('、') + (minor.length > 12 ? ' ……' : ''));
  for (const i of serious) {
    console.log(`请回听  ${i.at}–${i.to} 秒，稿子第 ${lineOf(i.script_index)} 行附近，${label[i.kind]}：` +
      (i.kind === 'missing' ? `「${i.script}」` : i.kind === 'extra' ? `「${i.heard}」` : `稿子「${i.script}」，听到「${i.heard}」`));
  }

  const report = {
    script: path.basename(scriptFile), asr: path.resolve(asrFile), script_chars: chars.length, matched: res.matched,
    match_rate: r3(res.rate), estimated_chars: res.timing.filter((t) => t.est).length,
    passed: res.passed, reasons: res.reasons,
    issues: res.issues.map(({ script_index, asr_index, asr_count, ...i }) => ({ ...i, line: lineOf(script_index) })),
    human_listened: false,
  };
  fs.writeFileSync(path.join(work, '对齐报告.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

  if (!res.passed && !args.includes('--force')) {
    console.log(`\n未通过，没有写 timing.json：${res.reasons.join('；')}。\n重录有问题的那一句，或把稿子改成实际说的话，再运行一次。确认录音没问题、只是识别错了，可以加 --force。`);
    process.exit(1);
  }
  // 只写作品目录里的 timing.json，不跟着稿子头部的"时间轴："写到别处去
  const out = path.join(work, 'timing.json');
  if (path.resolve(work, sb.audio.timing || 'timing.json') !== out) console.log(`提示  稿子头部的"时间轴：${sb.audio.timing}"指向别的文件；要用这次的结果，请删掉那一行。`);
  if (fs.existsSync(out)) fs.renameSync(out, out.replace(/\.json$/i, '_上一版.json'));
  fs.writeFileSync(out, JSON.stringify(res.timing.map((t, i) => ({ start: r3(t.start), end: r3(t.end), text: chars[i], ...(t.est ? { est: true } : {}) }))) + '\n', 'utf8');
  console.log(`\n${res.passed ? '通过' : '已按 --force 写出'}：逐字时间写到 ${out}（${report.estimated_chars} 个字的时间是在前后字之间平分的）。` +
    (serious.length ? `有 ${serious.length} 处请回听。` : ''));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
