#!/usr/bin/env node
// 分镜检查 + 锚点解析。零依赖，只需要 Node 18+。
//
//   node storyboard.mjs <口播稿.txt | storyboard.json> [--out timeline.json]
//        [--audio 配音.wav] [--timing 时间轴.json] [--gap 3|off] [--dump 分镜.json]
//
// 输入可以是带记号的口播稿（.txt，写法见 lib/script.mjs），也可以是 storyboard.json。
// 做三件事：
//   1. 把稿子顺序对到逐字时间上。对不上就报错，不猜、不按字数估时间。
//   2. 把"第几句""这句里的哪个字"换算成秒。
//   3. 按画面规则检查：字幕无标点、不超两行、关键词在句子里、每 3 秒内有画面变化。
// 通过则输出 timeline.json（带秒数，给 build.mjs 用）；有错误则退出码 1。

import fs from 'node:fs';
import path from 'node:path';
import { parseScript } from './lib/script.mjs';
import { mapChars } from './align.mjs';

const SCENE_TYPES = ['要点清单', '大字强调', '观点对比', '步骤说明'];
const DRAWABLE = new Set([undefined, '字', '大字', '对比', '步骤']); // 当前模板画得出来的画面节点
// 画面字的长度上限（黑金水墨模板，内容区宽 794 像素）：[一行放得下几个字, 最多几个字]
const SHOW_LIMIT = { 字: [9, 18], 大字: [6, 12], 步骤: [10, 10], 对比: [9, 9] };
const MAX_STEPS = 4; // 一组步骤最多几条，再多画面放不下
const len = (s) => [...String(s ?? '')].length;
const GAP_TOLERANCE = 0.05;

const strip = (s) => String(s).replace(/[\s\p{P}\p{S}]/gu, '');
const round = (n) => Math.round(n * 1000) / 1000;

function wavDuration(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let pos = 12, byteRate = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(pos + 16);
    if (id === 'data' && byteRate) return Math.min(size, buf.length - pos - 8) / byteRate;
    pos += 8 + size + (size % 2);
  }
  return null;
}

// 逐字时间有两种来源：[{start,end,text}]（一个字或词一条），或旧流程 timeline.json 的 {plain, times}
function loadTiming(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(data)) return data;
  if (typeof data.plain === 'string' && Array.isArray(data.times)) {
    const chars = [...data.plain];
    if (chars.length !== data.times.length) throw new Error(`${file}: plain 有 ${chars.length} 个字，times 有 ${data.times.length} 条，对不上`);
    return chars.map((text, i) => ({ start: data.times[i][0], end: data.times[i][1], text }));
  }
  throw new Error(`${file}: 不认识的时间轴格式`);
}

function main() {
  const args = process.argv.slice(2);
  const valued = ['--out', '--audio', '--timing', '--gap', '--dump'];
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const file = args.find((a, i) => !a.startsWith('--') && !valued.includes(args[i - 1]));
  const outFile = opt('--out');
  const gapOpt = opt('--gap');
  const maxGap0 = gapOpt === 'off' ? null : Number(gapOpt ?? 3);
  if (!file) {
    console.error('用法: node storyboard.mjs <口播稿.txt | storyboard.json> [--out timeline.json] [--audio 配音.wav] [--timing 时间轴.json] [--gap 3|off] [--dump 分镜.json]');
    process.exit(2);
  }

  const errors = [], warnings = [];
  const base = path.dirname(path.resolve(file));
  let sb;
  if (/\.json$/i.test(file)) sb = JSON.parse(fs.readFileSync(file, 'utf8'));
  else {
    const parsed = parseScript(fs.readFileSync(file, 'utf8'));
    sb = parsed.storyboard;
    errors.push(...parsed.errors); warnings.push(...parsed.warnings);
  }
  const audioFile = opt('--audio') ? path.resolve(opt('--audio')) : (sb.audio?.file ? path.resolve(base, sb.audio.file) : null);
  const timingFile = opt('--timing') ? path.resolve(opt('--timing')) : path.resolve(base, sb.audio.timing);
  if (opt('--dump')) fs.writeFileSync(opt('--dump'), JSON.stringify(sb, null, 2) + '\n', 'utf8');
  const perLine = sb.caption?.max_chars_per_line ?? 15;
  const maxLines = sb.caption?.max_lines ?? 2;
  const where = (x) => (x.line ? `第 ${x.line} 行` : x.id);
  // 黑金水墨模板的标题一行放 8 个字，再长会换行，容易在第二行只剩一个字
  if ([...(sb.title ?? '')].length > 8) warnings.push(`标题「${sb.title}」有 ${[...sb.title].length} 个字，超过 8 个字会换行，建议改短`);
  if (sb.accent && !/^#[0-9a-fA-F]{6}$/.test(sb.accent)) errors.push(`强调色「${sb.accent}」看不懂。写成 # 加 6 位十六进制，比如 #d9b566`);

  // ---- 逐字时间流 ----
  const tokens = loadTiming(timingFile);
  const streamChars = [], charTok = [];
  tokens.forEach((t, i) => { for (const ch of strip(t.text)) { streamChars.push(ch); charTok.push(i); } });

  // ---- 1. 稿子顺序对到时间上 ----
  const segById = new Map();
  let cursor = 0, aligned = true;
  for (const seg of sb.segments ?? []) {
    if (!seg.id || segById.has(seg.id)) errors.push(`句子 id 缺失或重复: ${seg.id}`);
    segById.set(seg.id, seg);
    // 时间轴里记的可能是读法（say），也可能是屏幕字（text），两种都试
    const candidates = [seg.say, seg.text].filter((s) => s != null).map((s) => [...strip(s)]);
    const hit = candidates.find((c) => c.length && streamChars.slice(cursor, cursor + c.length).join('') === c.join(''));
    if (!hit) {
      const want = candidates[0] ?? [];
      errors.push(`${where(seg)}: 稿子和音频对不上。稿子是「${want.join('')}」，音频这里是「${streamChars.slice(cursor, cursor + Math.max(want.length, 1)).join('')}」。` +
        '如果屏幕字和读法不同，把读法写进"读音"。');
      aligned = false;
      break; // 后面全会错位，不再继续
    }
    seg._from = cursor;
    seg._spoken = hit;
    seg.start = round(tokens[charTok[cursor]].start);
    seg.end = round(tokens[charTok[cursor + hit.length - 1]].end);
    cursor += hit.length;
  }
  if (aligned && cursor < streamChars.length) {
    errors.push(`音频里还有 ${streamChars.length - cursor} 个字没有对应的句子，从「${streamChars.slice(cursor, cursor + 12).join('')}」开始。`);
    aligned = false;
  }

  // ---- 3a. 字幕规则 ----
  for (const seg of sb.segments ?? []) {
    if (/[\p{P}]/u.test(seg.text)) errors.push(`${where(seg)}: 字幕带标点「${seg.text}」`);
    const len = [...seg.text].length;
    if (len > perLine * maxLines) errors.push(`${where(seg)}: 字幕「${seg.text}」有 ${len} 字，超过 ${maxLines} 行 × ${perLine} 字，请拆句或改稿`);
    // 关键词可以写成 "词"，或 {"word":"词","color":"#78cdb8"}（单独指定颜色）
    seg.keywords = (seg.keywords ?? []).map((kw) => (typeof kw === 'string' ? { word: kw } : kw));
    for (const kw of seg.keywords) {
      if (!kw.word || !seg.text.includes(kw.word)) errors.push(`${where(seg)}: 关键词「${kw.word}」不在这句字幕里`);
    }
  }

  // ---- 2. 锚点换算 ----
  const duration = audioFile && fs.existsSync(audioFile) ? wavDuration(audioFile) : null;
  if (duration == null) warnings.push('读不到音频时长（文件不在，或不是 wav），最后一幕的结束时间用最后一句的结束时间代替');
  const lastEnd = sb.segments?.at(-1)?.end ?? 0;
  const total = round(duration ?? lastEnd);
  if (aligned && duration != null && duration - lastEnd > 1.0) warnings.push(`最后一句说完后还有 ${round(duration - lastEnd)} 秒`);

  // 锚点三种写法："c003"（那句开口时）、{seg, at:"词"}（说到这个词时）、{seg, offset:n}（屏幕字的第 n 个字开口时）
  function resolve(on, label) {
    const ref = typeof on === 'string' ? { seg: on } : on;
    const seg = segById.get(ref?.seg);
    if (!seg || seg.start == null) { if (aligned) errors.push(`${label}: 锚点指向不存在的句子 ${JSON.stringify(on)}`); return null; }
    const hay = seg._spoken.join('');
    let offset = 0;
    if (ref.at != null) {
      const needle = strip(ref.at), first = hay.indexOf(needle);
      if (first < 0) { errors.push(`${label}: 「${ref.at}」不在 ${seg.id} 这句里`); return null; }
      if (hay.indexOf(needle, first + 1) >= 0) { errors.push(`${label}: 「${ref.at}」在 ${seg.id} 里出现不止一次，请写长一点`); return null; }
      offset = [...hay.slice(0, first)].length;
    } else if (ref.offset) {
      const shown = [...strip(seg.text)];
      const before = [...strip([...seg.text].slice(0, ref.offset).join(''))].length;
      if (shown.length === seg._spoken.length) offset = before;
      else {
        // 屏幕字和读法长度不同：记号后面那个字在读法里找得到原字，才定得准
        const at = mapChars(shown, seg._spoken)[before];
        if (at != null) offset = at;
        else { errors.push(`${label}: 这句的读法和屏幕字不同，记号正好落在改了读法的字上，定不准位置，请挪到句首或别的字前面`); return null; }
      }
    }
    return round(tokens[charTok[seg._from + offset]].start);
  }

  const scenes = [], skipped = [];
  (sb.scenes ?? []).forEach((sc, i) => {
    const label = `场景 ${sc.id ?? i + 1}`;
    if (!SCENE_TYPES.includes(sc.type)) errors.push(`${label}: 不认识的场景类型「${sc.type}」，可用：${SCENE_TYPES.join('、')}`);
    const start = i === 0 ? 0 : resolve(sc.from, label);
    const items = [];
    let stepRun = 0;
    (sc.beats ?? []).forEach((b, j) => {
      const bl = b.line ? `第 ${b.line} 行` : `${label} 第 ${j + 1} 个节点`;
      const at = resolve(b.on, bl);
      if (!DRAWABLE.has(b.kind)) { skipped.push({ at, kind: b.kind, args: b.args ?? '', line: b.line }); return; }
      const kind = b.kind ?? '字', [, max] = SHOW_LIMIT[kind];
      if (kind === '对比') {
        if (b.left == null || b.right == null) { errors.push(`${bl}: @对比 要写成"旧说法 | 新说法"`); return; }
        for (const side of [b.left, b.right]) if (len(side) > max) errors.push(`${bl}: 对比的一边「${side}」有 ${len(side)} 个字，最多 ${max} 个字，请改短`);
      } else if (len(b.show) > max) errors.push(`${bl}: 画面字「${b.show}」有 ${len(b.show)} 个字，@${kind} 最多 ${max} 个字，请改短`);
      stepRun = kind === '步骤' ? stepRun + 1 : 0;
      if (stepRun === MAX_STEPS + 1) errors.push(`${bl}: 连着写了超过 ${MAX_STEPS} 条 @步骤，画面放不下。拆成两组：中间加一个 # 小标题，或插一行别的画面`);
      items.push({ at, text: b.show, ...(b.kind ? { kind: b.kind } : {}), ...(b.tone ? { tone: b.tone } : {}), ...(kind === '对比' ? { left: b.left, right: b.right } : {}) });
    });
    scenes.push({ id: sc.id, type: sc.type, heading: sc.heading, start, end: null, items });
  });
  scenes.forEach((sc, i) => { sc.end = i + 1 < scenes.length ? scenes[i + 1].start : total; });
  if (skipped.length) {
    const count = {};
    for (const s of skipped) count['@' + s.kind] = (count['@' + s.kind] ?? 0) + 1;
    warnings.push(`当前模板画不了这些记号，已跳过：${Object.entries(count).map(([k, n]) => `${k}×${n}`).join('、')}`);
  }

  // ---- 3b. 时间顺序与画面变化间隔 ----
  let maxGap = 0;
  if (!errors.length) {
    const changes = [];
    for (const sc of scenes) {
      changes.push({ t: sc.start, what: `${sc.id} 开场` });
      for (const it of sc.items) {
        if (it.at < sc.start - 1e-6 || it.at >= sc.end) errors.push(`${sc.id}: 节点「${it.text}」(${it.at}s) 不在本场景 ${sc.start}–${sc.end}s 内`);
        changes.push({ t: it.at, what: it.text });
      }
    }
    for (let i = 1; i < changes.length; i++) {
      if (changes[i].t < changes[i - 1].t) errors.push(`节点顺序倒了：「${changes[i - 1].what}」在「${changes[i].what}」之后`);
    }
    changes.push({ t: total, what: '片尾' });
    const over = [];
    for (let i = 1; i < changes.length; i++) {
      const gap = round(changes[i].t - changes[i - 1].t);
      maxGap = Math.max(maxGap, gap);
      if (maxGap0 != null && gap > maxGap0 + GAP_TOLERANCE) over.push(`「${changes[i - 1].what}」(${changes[i - 1].t}s) 到「${changes[i].what}」(${changes[i].t}s) 隔了 ${gap} 秒`);
    }
    if (over.length) {
      errors.push(`有 ${over.length} 处超过 ${maxGap0} 秒没有画面变化：`);
      over.slice(0, 8).forEach((o) => errors.push('  ' + o));
      if (over.length > 8) errors.push(`  ……还有 ${over.length - 8} 处`);
    }
  }

  for (const w of warnings) console.log(`提示  ${w}`);
  for (const e of errors) console.log(`错误  ${e}`);
  if (errors.length) { console.log('\n未通过，没有输出时间线。'); process.exit(1); }

  const timeline = {
    version: 0,
    title: sb.title,
    brand: sb.brand ?? '',
    ...(sb.accent ? { accent: sb.accent } : {}),
    canvas: { ...sb.canvas, duration: total },
    // 音频路径相对于 timeline.json 所在目录
    audio: outFile && audioFile ? path.relative(path.dirname(path.resolve(outFile)), audioFile).replaceAll('\\', '/') : null,
    captions: sb.segments.map(({ id, start, end, text, keywords }) => ({ id, start, end, text, keywords })),
    scenes,
    ...(skipped.length ? { skipped } : {}),
    checks: { max_visual_gap: maxGap, rule_max_visual_gap: maxGap0 },
  };
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(timeline, null, 2) + '\n', 'utf8');
  console.log(`通过：${sb.segments.length} 条字幕，${scenes.length} 个场景，${scenes.reduce((n, s) => n + s.items.length, 0)} 个画面节点，` +
    `总长 ${total} 秒，画面变化最大间隔 ${maxGap} 秒。${outFile ? '时间线已写到 ' + outFile : ''}`);
}

main();
