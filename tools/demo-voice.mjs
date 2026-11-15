#!/usr/bin/env node
// 给示例生成一条"电脑自带朗读"的音轨和逐字时间，让新人不用任何账号、不用录音就能先跑通流程。
//
//   node tools/demo-voice.mjs <作品目录>
//
// 读 <作品目录>/口播稿.txt，写出 voice.wav 和 timing.json。
// 只给示例用：声音是系统朗读，不代表成片音质；每条字幕的起止时间是量出来的，
// 但一条字幕内部每个字的时间是平均分的，所以示例稿子里的记号都放在句首。
// 做自己的片子请用本人录音或配音服务，不要用这个脚本。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseScript } from './lib/script.mjs';

const GAP = { lead: 0.15, caption: 0.10, para: 0.40, tail: 0.30 }; // 秒
const SILENT = 300; // 16 位采样里，绝对值低于它算静音

function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${file} 不是 wav`);
  let pos = 12, fmt = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4), size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(pos + 8), channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    if (id === 'data') return { fmt, data: buf.subarray(pos + 8, pos + 8 + Math.min(size, buf.length - pos - 8)) };
    pos += 8 + size + (size % 2);
  }
  throw new Error(`${file} 里没有声音数据`);
}

function trimSilence(data, frame, rate) {
  const loud = (i) => Math.abs(data.readInt16LE(i)) >= SILENT;
  let a = 0, b = data.length - frame;
  while (a < b && !loud(a)) a += frame;
  while (b > a && !loud(b)) b -= frame;
  const pad = Math.round(rate * 0.02) * frame;
  return data.subarray(Math.max(0, a - pad), Math.min(data.length, b + frame + pad));
}

function speakWindows(items, listFile) {
  fs.writeFileSync(listFile, JSON.stringify({ items }), 'utf8');
  const ps = [
    'Add-Type -AssemblyName System.Speech',
    '$j = Get-Content -Raw -Encoding UTF8 $env:BOKE_TTS_LIST | ConvertFrom-Json',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "$v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1",
    'if (-not $v) { exit 3 }',
    '$s.SelectVoice($v.VoiceInfo.Name)',
    '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    'foreach ($it in $j.items) { $s.SetOutputToWaveFile($it.out, $fmt); $s.Speak($it.text) }',
    '$s.SetOutputToNull(); $s.Dispose()',
    '[Console]::Out.Write($v.VoiceInfo.Name)',
  ].join('; ');
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', env: { ...process.env, BOKE_TTS_LIST: listFile }, windowsHide: true });
  if (r.status === 3) throw new Error('这台电脑没有中文朗读声音。设置 → 时间和语言 → 语音 → 添加中文语音。');
  if (r.status !== 0) throw new Error(`系统朗读失败：${(r.stderr || r.error?.message || '').trim().split(/\r?\n/)[0]}`);
  return r.stdout.trim();
}

function speakMac(items) {
  const list = spawnSync('say', ['-v', '?'], { encoding: 'utf8' }).stdout ?? '';
  const line = list.split('\n').find((l) => /zh_CN/.test(l));
  if (!line) throw new Error('这台 Mac 没有中文朗读声音。系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音，下载"婷婷"。');
  const voice = line.split(/\s{2,}/)[0].trim();
  for (const it of items) {
    const r = spawnSync('say', ['-v', voice, '-o', it.out, '--data-format=LEI16@22050', it.text], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`系统朗读失败：${(r.stderr || '').trim()}`);
  }
  return voice;
}

export function makeDemoVoice(workDir) {
  const scriptFile = path.join(workDir, '口播稿.txt');
  const { storyboard: sb, errors } = parseScript(fs.readFileSync(scriptFile, 'utf8'));
  if (errors.length) throw new Error(`口播稿有问题：${errors[0]}`);
  const tmp = path.join(workDir, '制作文件', '示例朗读');
  fs.mkdirSync(tmp, { recursive: true });
  const items = sb.segments.map((s, i) => ({ text: s.say ?? s.text, out: path.join(tmp, `${String(i + 1).padStart(3, '0')}.wav`) }));

  let voice;
  if (process.platform === 'win32') voice = speakWindows(items, path.join(tmp, 'list.json'));
  else if (process.platform === 'darwin') voice = speakMac(items);
  else throw new Error('示例朗读只支持 Windows 和 Mac。');

  const first = readWav(items[0].out).fmt;
  if (first.format !== 1 || first.bits !== 16) throw new Error(`系统朗读输出的格式不认识（format=${first.format}, bits=${first.bits}）`);
  const frame = first.channels * 2, rate = first.rate;
  const silence = (sec) => Buffer.alloc(Math.round(sec * rate) * frame);
  const strip = (s) => String(s).replace(/[\s\p{P}\p{S}]/gu, '');

  const chunks = [silence(GAP.lead)], timing = [];
  let t = GAP.lead;
  sb.segments.forEach((seg, i) => {
    if (i > 0) { const g = seg.para !== sb.segments[i - 1].para ? GAP.para : GAP.caption; chunks.push(silence(g)); t += g; }
    const pcm = trimSilence(readWav(items[i].out).data, frame, rate);
    const dur = pcm.length / frame / rate;
    const chars = [...strip(items[i].text)];
    chars.forEach((ch, k) => timing.push({ start: +(t + dur * k / chars.length).toFixed(3), end: +(t + dur * (k + 1) / chars.length).toFixed(3), text: ch }));
    chunks.push(pcm); t += dur;
  });
  chunks.push(silence(GAP.tail));

  const data = Buffer.concat(chunks);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(first.channels, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * frame, 28); head.writeUInt16LE(frame, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path.join(workDir, 'voice.wav'), Buffer.concat([head, data]));
  fs.writeFileSync(path.join(workDir, 'timing.json'), JSON.stringify(timing) + '\n', 'utf8');
  fs.rmSync(tmp, { recursive: true, force: true });
  return { voice, seconds: +(data.length / frame / rate).toFixed(2), captions: sb.segments.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('用法: node tools/demo-voice.mjs <作品目录>'); process.exit(2); }
  try {
    const r = makeDemoVoice(path.resolve(dir));
    console.log(`示例音轨已生成：${r.captions} 条字幕，${r.seconds} 秒，朗读声音「${r.voice}」。这是系统朗读，只用来跑通流程。`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
