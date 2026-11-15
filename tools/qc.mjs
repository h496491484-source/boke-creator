#!/usr/bin/env node
// 成片机器检查。零依赖，需要 Node 18+ 和 ffmpeg / ffprobe。
//
//   node qc.mjs <成片.mp4> [--json 报告.json] [--size 1080x1920] [--fps 30]
//
// ffmpeg 位置：环境变量 FFMPEG_DIR（放 ffmpeg 和 ffprobe 的文件夹），没设就从 PATH 找。
// 这是机器检查，不等于有人从头到尾看过、听过。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const flagsWithValue = new Set(['--json', '--size', '--fps']);
const video = args.find((a, i) => !a.startsWith('--') && !flagsWithValue.has(args[i - 1]));
if (!video || !fs.existsSync(video)) {
  console.error('用法: node qc.mjs <成片.mp4> [--json 报告.json] [--size 1080x1920] [--fps 30]');
  process.exit(2);
}
const [wantW, wantH] = opt('--size', '1080x1920').split('x').map(Number);
const wantFps = Number(opt('--fps', '30'));

// 阈值。暗色底（#14130f）下 pix_th=0.10 会把背景算作"黑"，所以这项抓的是"只有背景、没有内容"。
// pic_th 必须很高：黑金版式里文字只占画面 1–2%，用常见的 0.98 会把正常画面误判成空画面。
// 0.995 是 2026-11-14 用样片校准的：能抓到 02 版开头约 0.13 秒的纯背景，03 版（已修）不报。
const T = {
  blank: { d: 0.06, pix_th: 0.10, pic_th: 0.995 },
  freeze: { noise: '-60dB', d: 3 },          // 对应"每 3 秒内有画面变化"
  silence: { noise: '-40dB', d: 1.0 },       // 正文里超过 1 秒的静音
  tailSilence: 0.5,
  avDrift: 0.1,
  loudness: { min: -16, max: -12, peak: -1.0 },
};

const bin = (name) => {
  const dir = process.env.FFMPEG_DIR;
  if (!dir) return name;
  const p = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
  // 是符号链接就解析到真实文件。注意：winget 的 Links 目录里可能是 0 字节的坏文件，
  // 那种情况要把 FFMPEG_DIR 指到 Packages\...\bin 里的真实 ffmpeg。
  try { return fs.realpathSync(p); } catch { return p; }
};
function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) { console.error(`找不到或跑不起来 ${cmd}：${r.error.message}\n请安装 ffmpeg，或设置 FFMPEG_DIR。`); process.exit(2); }
  return r;
}

const results = [];
const add = (name, status, detail) => results.push({ name, status, detail });

// ---- 1. 规格 ----
const probe = JSON.parse(run(bin('ffprobe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video]).stdout || '{}');
const v = (probe.streams ?? []).find((s) => s.codec_type === 'video');
const a = (probe.streams ?? []).find((s) => s.codec_type === 'audio');
if (!v) { add('规格', '未通过', '没有视频轨'); }
else {
  const [n, d] = v.r_frame_rate.split('/').map(Number);
  const fps = n / d;
  const bad = [];
  if (v.width !== wantW || v.height !== wantH) bad.push(`分辨率 ${v.width}×${v.height}，应为 ${wantW}×${wantH}`);
  if (Math.abs(fps - wantFps) > 0.01) bad.push(`帧率 ${fps.toFixed(2)}，应为 ${wantFps}`);
  if (v.codec_name !== 'h264') bad.push(`视频编码 ${v.codec_name}，应为 h264`);
  if (!a) bad.push('没有音轨');
  add('规格', bad.length ? '未通过' : '通过',
    bad.length ? bad.join('；') : `${v.width}×${v.height}，${fps.toFixed(0)} fps，${v.codec_name}${a ? ' + ' + a.codec_name + ' ' + a.sample_rate + ' Hz' : ''}`);
}
const vDur = Number(v?.duration ?? probe.format?.duration ?? 0);
const aDur = Number(a?.duration ?? 0);
if (v && a) {
  const drift = Math.abs(vDur - aDur);
  add('音画时长', drift > T.avDrift ? '未通过' : '通过', `画面 ${vDur.toFixed(2)} 秒，声音 ${aDur.toFixed(2)} 秒，相差 ${drift.toFixed(2)} 秒`);
}

// ---- 2. 一次解码跑完画面和声音的检测 ----
const ff = ['-hide_banner', '-nostats', '-i', video,
  '-vf', `blackdetect=d=${T.blank.d}:pix_th=${T.blank.pix_th}:pic_th=${T.blank.pic_th},freezedetect=n=${T.freeze.noise}:d=${T.freeze.d}`];
if (a) ff.push('-af', `silencedetect=noise=${T.silence.noise}:d=${T.silence.d},ebur128=peak=true`);
ff.push('-f', 'null', '-');
const log = run(bin('ffmpeg'), ff).stderr ?? '';

const span = (s, e) => `${Number(s).toFixed(2)}–${Number(e).toFixed(2)} 秒`;

const blanks = [...log.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => span(m[1], m[2]));
add('空画面', blanks.length ? '未通过' : '通过', blanks.length ? `只有背景、没有内容的时段：${blanks.join('，')}` : '没有只剩背景的时段');

const fStarts = [...log.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => Number(m[1]));
const fEnds = [...log.matchAll(/freeze_end: ([\d.]+)/g)].map((m) => Number(m[1]));
const freezes = fStarts.map((s, i) => span(s, fEnds[i] ?? vDur));
add('画面静止', freezes.length ? '未通过' : '通过', freezes.length ? `连续 ${T.freeze.d} 秒以上完全不动：${freezes.join('，')}` : `没有连续 ${T.freeze.d} 秒以上完全不动的画面`);

if (a) {
  const sStarts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const sEnds = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const inner = [], notes = [];
  sStarts.forEach((s, i) => {
    const e = sEnds[i] ?? aDur;
    if (e >= aDur - 0.05) { if (e - s > T.tailSilence) notes.push(`片尾静音 ${(e - s).toFixed(2)} 秒`); }
    else if (s <= 0.05) notes.push(`片头静音 ${(e - s).toFixed(2)} 秒`);
    else inner.push(span(s, e));
  });
  add('静音', inner.length ? '未通过' : (notes.length ? '提示' : '通过'),
    inner.length ? `正文里超过 ${T.silence.d} 秒的静音：${inner.join('，')}` : (notes.join('；') || `正文里没有超过 ${T.silence.d} 秒的静音`));

  const summary = log.slice(log.lastIndexOf('Summary:'));
  const I = Number(summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1]);
  const peak = Number(summary.match(/Peak:\s+(-?[\d.]+) dBFS/)?.[1]);
  if (Number.isFinite(I)) {
    const off = I < T.loudness.min || I > T.loudness.max || peak > T.loudness.peak;
    // 峰值超过 0 就是爆音，不只是提示
    add('响度', peak > 0 ? '未通过' : off ? '提示' : '通过', `整体 ${I} LUFS，真峰值 ${peak} dBFS（参考范围 ${T.loudness.min}～${T.loudness.max} LUFS，峰值不高于 ${T.loudness.peak}）`);
  } else add('响度', '提示', '没量到响度');
}

// ---- 输出 ----
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].length * 2));
for (const r of results) console.log(`${pad(r.status, 8)}${pad(r.name, 10)}${r.detail}`);
const failed = results.filter((r) => r.status === '未通过').length;
console.log(failed ? `\n机器检查未通过：${failed} 项。` : '\n机器检查通过。这不等于有人从头到尾看过、听过。');
const jsonOut = opt('--json');
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ video: path.resolve(video), thresholds: T, results, human_watched: false, human_listened: false }, null, 2) + '\n', 'utf8');
process.exit(failed ? 1 : 0);
