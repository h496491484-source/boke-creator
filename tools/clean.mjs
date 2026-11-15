#!/usr/bin/env node
// 清理录音：把稿子里没有的口头语、重复的话和过长的停顿剪掉。片子没有真人画面，剪声音不会穿帮。
//
//   node tools/clean.mjs <作品目录> --dry      只列出打算剪哪里，不动文件
//   node tools/clean.mjs <作品目录>            照清单剪，原录音留作 voice_原始.wav
//       [--pause 0.8]   超过多少秒的停顿算"过长"（默认 0.8）
//
// 只剪两类：
//   1. 录音里有、稿子里没有的话——口头语（啊、呃、嗯……）或连续两个字以上的多余内容；
//   2. 过长的停顿，缩到 0.3 秒左右。
// 不剪：读错的字、单个认不准的字、稿子里有而录音里没读到的（那要重录）。
// 每次都从原录音重新算，所以改了稿子可以再跑一遍。剪完必须本人听一遍：机器不知道剪得顺不顺。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findFfmpeg, ffBin } from './lib/env.mjs';
import { parseScript } from './lib/script.mjs';
import { recognize } from './asr.mjs';
import { align } from './align.mjs';

const RATE = 48000, HOP = 0.01;
const FILLER = /^[啊呃嗯额哦噢唉诶哎呀吧嘛呢哈嗨喔唔]+$/;
const KEEP = { after: 0.15, before: 0.12, lead: 0.2, tail: 0.3, tight: 0.03 }; // 剪口两边各留多少（秒）
const FADE = 0.012;
const strip = (s) => String(s).replace(/[\s\p{P}\p{S}]/gu, '');
const r2 = (n) => Math.round(n * 100) / 100;

function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--pause');
  const dry = args.includes('--dry'), maxPause = Number(opt('--pause', '0.8'));
  if (!target) { console.error('用法: node tools/clean.mjs <作品目录> [--dry] [--pause 0.8]'); process.exit(2); }
  const work = path.resolve(target);
  const voice = path.join(work, 'voice.wav'), backup = path.join(work, 'voice_原始.wav');
  const orig = fs.existsSync(backup) ? backup : voice;
  if (!fs.existsSync(orig)) { console.error(`找不到 ${voice}。先运行一次 make.mjs，它会把手机录音转成 voice.wav。`); process.exit(1); }
  const ffmpeg = findFfmpeg();
  if (!ffmpeg.ok) { console.error('没找到 ffmpeg。先运行 node tools/setup.mjs。'); process.exit(1); }

  // ---- 稿子、识别、对齐 ----
  const { storyboard: sb, errors } = parseScript(fs.readFileSync(path.join(work, '口播稿.txt'), 'utf8'));
  if (errors.length) { errors.forEach((e) => console.log(`错误  ${e}`)); process.exit(1); }
  const chars = sb.segments.flatMap((s) => [...strip(s.say ?? s.text)]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-clean-'));
  const asr = recognize(orig, { tmpDir: tmp });
  const A = asr.words.flatMap((w) => [...strip(w.text)].map((ch) => ({ ch, start: w.start })));
  const res = align(chars, A);

  // ---- 声音的音量曲线 ----
  const raw = path.join(tmp, 'a.raw');
  const d = spawnSync(ffBin(ffmpeg, 'ffmpeg'), ['-y', '-v', 'error', '-i', orig, '-ar', String(RATE), '-ac', '1', '-f', 's16le', raw], { encoding: 'utf8', windowsHide: true });
  if (d.status !== 0) { console.error(`读不了录音：${(d.stderr || '').trim()}`); process.exit(1); }
  const pcm = fs.readFileSync(raw);
  const total = pcm.length / 2 / RATE, hop = RATE * HOP, n = Math.floor(pcm.length / 2 / hop);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < hop; k++) { const v = pcm.readInt16LE((i * hop + k) * 2) / 32768; s += v * v; } rms[i] = Math.sqrt(s / hop); }
  const sorted = Float32Array.from(rms).sort();
  const th = Math.max(sorted[Math.floor(n * 0.9)] * 0.06, sorted[Math.floor(n * 0.1)] * 3, 1e-4);
  const quiet = (from, to) => { for (let i = Math.max(0, Math.floor(from / HOP)); i < Math.min(n, Math.ceil(to / HOP)); i++) if (rms[i] >= th) return false; return true; };
  // 从 from 往后，在 limit 之前，这个字的声音在哪里停（连续 0.1 秒安静）
  const speechEnd = (from, limit) => { for (let t = from + 0.05; t + 0.1 <= limit; t += HOP) if (quiet(t, t + 0.1)) return { at: t, silent: true }; return { at: limit, silent: false }; };

  // ---- 哪些识别出来的字要剪 ----
  const drop = new Array(A.length).fill(null), leftAlone = [];
  for (const is of res.issues) {
    if (is.kind === 'extra' && (FILLER.test(is.heard) || is.asr_count >= 2)) {
      for (let k = 0; k < is.asr_count; k++) drop[is.asr_index + k] = is;
    } else if (is.kind !== 'differ' || [...is.script].length !== [...is.heard].length) leftAlone.push(is);
  }
  const kept = A.map((c, i) => ({ ...c, i })).filter((c) => !drop[c.i]);
  if (!kept.length) { console.error('稿子和录音完全对不上，没法清理。'); process.exit(1); }

  // ---- 算剪口：相邻两个保留的字之间，有多余的话或停顿过长，就剪掉中间 ----
  const cuts = [];
  const between = (aIdx, bIdx) => { const seen = new Set(); for (let i = aIdx + 1; i < bIdx; i++) if (drop[i]) seen.add(drop[i]); return [...seen]; };
  const add = (from, to, extras, pause) => {
    if (to - from < 0.12) return;
    const words = extras.map((e) => `「${e.heard}」`).join('');
    const reason = extras.length ? (extras.every((e) => FILLER.test(e.heard)) ? `口头语${words}` : `稿子里没有的话${words}`) + (pause > maxPause ? `和 ${r2(pause)} 秒停顿` : '') : `停顿 ${r2(pause)} 秒，缩短`;
    cuts.push({ from: r2(from), to: r2(to), reason });
  };
  // 开头
  {
    const b = kept[0], ex = between(-1, b.i), lead = b.start - KEEP.before;
    const firstSound = ex.length ? A[ex[0].asr_index].start : b.start;
    const keepLead = Math.min(KEEP.lead, Math.max(0, firstSound - 0.05));
    if (ex.length || lead - keepLead > 0.3) add(keepLead, quiet(b.start - KEEP.before, b.start - 0.02) ? lead : b.start - KEEP.tight, ex, firstSound);
  }
  for (let k = 0; k + 1 < kept.length; k++) {
    const a = kept[k], b = kept[k + 1], ex = between(a.i, b.i);
    const limit = ex.length ? A[ex[0].asr_index].start : b.start;
    const end = speechEnd(a.start, limit);
    const pause = b.start - end.at - ex.reduce((s, e) => s + 0.2 * e.asr_count, 0);
    if (!ex.length && (!end.silent || b.start - end.at <= maxPause)) continue;
    const from = end.at + (end.silent ? KEEP.after : 0);
    const to = b.start - (quiet(b.start - KEEP.before, b.start - 0.02) ? KEEP.before : KEEP.tight);
    add(from, to, ex, Math.max(0, pause));
  }
  // 结尾
  {
    const a = kept.at(-1), ex = between(a.i, A.length);
    const limit = ex.length ? A[ex[0].asr_index].start : total;
    const end = speechEnd(a.start, Math.min(limit, a.start + 1.5));
    const from = Math.min(total, end.at + KEEP.tail);
    if (ex.length || total - from > 0.3) add(from, total, ex, total - end.at);
  }

  // ---- 清单 ----
  const removed = cuts.reduce((s, c) => s + c.to - c.from, 0);
  console.log(`原录音 ${r2(total)} 秒，认出 ${A.length} 个字。打算剪 ${cuts.length} 处，共 ${r2(removed)} 秒，剪完约 ${r2(total - removed)} 秒：`);
  cuts.forEach((c, i) => console.log(`  ${String(i + 1).padStart(2)}. ${c.from}–${c.to} 秒  ${c.reason}`));
  if (leftAlone.length) {
    console.log('这些没有剪，需要你决定（重录那一句，或把稿子改成实际说的）：');
    for (const is of leftAlone) console.log(`  ${is.at} 秒  ` + (is.kind === 'missing' ? `稿子里的「${is.script}」录音里没读到` : is.kind === 'extra' ? `多了一个「${is.heard}」（单个字，可能是识别多认的，没敢剪）` : `稿子「${is.script}」，听到「${is.heard}」`));
  }
  if (dry || !cuts.length) { console.log(dry ? '\n这是预览，没有动任何文件。去掉 --dry 才会剪。' : '\n没有要剪的地方。'); fs.rmSync(tmp, { recursive: true, force: true }); return; }

  // ---- 剪：保留的片段首尾各做 12 毫秒淡入淡出再接起来 ----
  const keeps = []; let pos = 0;
  for (const c of cuts) { if (c.from > pos) keeps.push([pos, c.from]); pos = c.to; }
  if (pos < total) keeps.push([pos, total]);
  const fade = Math.round(FADE * RATE);
  const parts = keeps.map(([f, t], idx) => {
    const seg = Buffer.from(pcm.subarray(Math.round(f * RATE) * 2, Math.round(t * RATE) * 2));
    const len = seg.length / 2, m = Math.min(fade, Math.floor(len / 2));
    for (let i = 0; i < m; i++) {
      if (idx > 0) seg.writeInt16LE(Math.round(seg.readInt16LE(i * 2) * i / m), i * 2);
      if (idx < keeps.length - 1) { const j = len - 1 - i; seg.writeInt16LE(Math.round(seg.readInt16LE(j * 2) * i / m), j * 2); }
    }
    return seg;
  });
  const data = Buffer.concat(parts), head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24); head.writeUInt32LE(RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  if (!fs.existsSync(backup)) fs.renameSync(voice, backup);
  fs.writeFileSync(voice, Buffer.concat([head, data]));
  fs.writeFileSync(path.join(work, '清理记录.json'), JSON.stringify({ source: path.basename(backup), seconds_before: r2(total), seconds_after: r2(data.length / 2 / RATE), max_pause: maxPause, cuts, left_alone: leftAlone.map(({ script_index, asr_index, asr_count, ...i }) => i), human_listened: false }, null, 2) + '\n', 'utf8');
  // 时间全变了：旧的识别结果和时间轴作废，下次出片时重新识别、重新对
  for (const f of ['识别结果.json', 'timing.json', 'timing_上一版.json']) fs.rmSync(path.join(work, f), { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n已剪好：${voice}（${r2(data.length / 2 / RATE)} 秒）。原录音留在 ${backup}。\n请先听一遍 voice.wav，剪口顺不顺只有耳朵知道。没问题再运行 make.mjs 出片。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
