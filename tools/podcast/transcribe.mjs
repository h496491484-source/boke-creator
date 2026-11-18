#!/usr/bin/env node
// 整期转写：拼接原始录音 → 人声检测切句 → SenseVoice 识别（带标点）→ 全文；顺便测每段响度（人声处理要用）。
// 全在本机 CPU 上跑，不联网。65 分钟的录音约 2 分钟（2026-11-17 实测 95 秒识别）。
//
//   node tools/podcast/transcribe.mjs <节目目录> [--force]
//
// 产物：制作文件/（原始_44k.wav、16k.wav、识别.json、段响度.json）、全文.txt、全文.json。
// 分说话人另跑 speakers.mjs（慢，可以放后台，先读全文）。

import fs from 'node:fs';
import path from 'node:path';
import { relaunchOnMac, loadSherpa, asrModel, needPodcastModels, pmPath, threads, episode, mustExist, recordings, recordingMode, fileMap, lookupFile, trackWav, duration, ff, writeJson, readJson, RATE, RATE16, fmt, mins } from '../lib/podcast.mjs';
import { buildFull } from './fulltext.mjs';

relaunchOnMac();
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) { console.error('用法: node tools/podcast/transcribe.mjs <节目目录> [--force]'); process.exit(2); }
mustExist(dir);
const e = episode(dir);
const force = args.includes('--force');

try {
  needPodcastModels(['vad']);
  const sherpa = loadSherpa(), model = asrModel();
  const recs = recordings(e);
  if (!recs.length) throw new Error('节目目录第一层没有录音文件。把原始录音放进来，或用 new.mjs 拷进来。');
  fs.mkdirSync(e.mid, { recursive: true });

  // 1. 合成一条完整录音：前后接着录的首尾拼接；多轨（每人一个文件、同时录）对齐后混音，并把每条轨留一份给认人用
  const mode = recs.length > 1 ? recordingMode(e) : 'single';
  if (!mode) {
    const lens = recs.map((f) => duration(f));
    const similar = Math.max(...lens) - Math.min(...lens) < Math.max(...lens) * 0.05;
    throw new Error(`有 ${recs.length} 个录音文件（${recs.map((f, i) => `${path.basename(f)} ${fmt(lens[i])}`).join('、')}），先在 节目信息.md 写"录音方式"：前后接着录的，还是多轨（每人一个文件、同时录）。${similar ? '这几个文件长度几乎一样，很可能是多轨。' : ''}`);
  }
  const offsets = fileMap(e, '音轨偏移');
  const stamp = `${mode}|` + recs.map((f) => `${path.basename(f)}:${fs.statSync(f).size}:${lookupFile(offsets, f) ?? ''}`).join('|');
  const meta = readJson(path.join(e.mid, '录音.json'), {});
  if (force || meta.stamp !== stamp || !fs.existsSync(e.wav44) || !fs.existsSync(e.wav16)) {
    const inputs = recs.flatMap((f) => ['-i', f]);
    const norm = (i) => `[${i}:a]aresample=${RATE},aformat=channel_layouts=stereo`;
    if (mode === 'multitrack') {
      console.log(`多轨混音 ${recs.length} 条音轨：${recs.map((f) => path.basename(f)).join('、')}`);
      const delay = (f) => { const s = Number(String(lookupFile(offsets, f) ?? '0').replace(/[^\d.+-]/g, '')) || 0; return s > 0 ? `,adelay=${Math.round(s * 1000)}:all=1` : s < 0 ? `,atrim=start=${-s},asetpts=PTS-STARTPTS` : ''; };
      // 各轨直接相加（不按轨数压低），最后限幅防止几个人同时大声时削顶
      const mix = `${recs.map((f, i) => `${norm(i)}${delay(f)}[a${i}]`).join(';')};${recs.map((_, i) => `[a${i}]`).join('')}amix=inputs=${recs.length}:normalize=0:duration=longest,alimiter=limit=0.95:level=false[o]`;
      ff(['-v', 'error', ...inputs, '-filter_complex', mix, '-map', '[o]', '-c:a', 'pcm_s16le', e.wav44], '多轨混音');
      recs.forEach((f, i) => ff(['-v', 'error', '-i', f, '-af', `aresample=${RATE16}${delay(f)}`, '-ac', 1, '-c:a', 'pcm_s16le', trackWav(e, i)], '转音轨'));
    } else {
      console.log(`${recs.length > 1 ? '拼接并' : ''}转换 ${recs.length} 个录音文件：${recs.map((f) => path.basename(f)).join(' + ')}`);
      const cat = `${recs.map((_, i) => `${norm(i)}[a${i}]`).join(';')};${recs.map((_, i) => `[a${i}]`).join('')}concat=n=${recs.length}:v=0:a=1[o]`;
      ff(['-v', 'error', ...inputs, '-filter_complex', cat, '-map', '[o]', '-c:a', 'pcm_s16le', e.wav44], '拼接录音');
    }
    ff(['-v', 'error', '-i', e.wav44, '-ar', RATE16, '-ac', 1, '-c:a', 'pcm_s16le', e.wav16], '转 16k');
    writeJson(path.join(e.mid, '录音.json'), { stamp, mode, files: recs.map((f) => path.basename(f)) });
    for (const f of [e.asr, e.diar, e.levels]) fs.rmSync(f, { force: true }); // 录音变了，后面的都作废
  }
  const samples = sherpa.readWave(e.wav16, false).samples;
  const total = samples.length / RATE16;

  // 2. 识别
  if (force || !fs.existsSync(e.asr)) {
    console.log(`识别 ${mins(total)} 的录音（本机 CPU，${threads()} 线程）……`);
    const vad = new sherpa.Vad({
      sileroVad: { model: pmPath('vad'), threshold: 0.5, minSilenceDuration: 0.4, minSpeechDuration: 0.25, windowSize: 512, maxSpeechDuration: 20 },
      sampleRate: RATE16, numThreads: 1, provider: 'cpu', debug: 0,
    }, 120);
    const rec = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: RATE16, featureDim: 80 },
      modelConfig: { senseVoice: { model: model.model, language: 'zh', useInverseTextNormalization: 1 }, tokens: model.tokens, numThreads: threads(), provider: 'cpu', debug: 0 },
    });
    const t0 = Date.now(), segs = [];
    let lastLog = 0;
    const drain = () => {
      while (!vad.isEmpty()) {
        const s = vad.front(false); vad.pop();
        const offset = s.start / RATE16;
        const st = rec.createStream();
        st.acceptWaveform({ sampleRate: RATE16, samples: s.samples });
        rec.decode(st);
        const r = rec.getResult(st);
        const toks = (r.tokens ?? []).map((t, i) => ({ t: String(t).replace(/▁/g, ''), s: +(offset + r.timestamps[i]).toFixed(2) })).filter((x) => x.t && !/^<\|.*\|>$/.test(x.t));
        if (toks.length) segs.push({ start: +offset.toFixed(2), end: +(offset + s.samples.length / RATE16).toFixed(2), text: toks.map((x) => x.t).join(''), toks });
        if (offset - lastLog > 600) { lastLog = offset; console.log(`  已识别到 ${fmt(offset)}`); }
      }
    };
    for (let i = 0; i < samples.length; i += 512) { vad.acceptWaveform(samples.subarray(i, Math.min(i + 512, samples.length))); drain(); }
    vad.flush(); drain();
    writeJson(e.asr, segs, 0);
    console.log(`识别完成：${segs.length} 段，用了 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
  }
  const asr = readJson(e.asr);

  // 3. 每段响度（一阶高通约 150Hz 粗略模拟人耳加权，50ms 一帧，只算比该段最响帧低 25dB 以内的帧）+ 底噪
  if (force || !fs.existsSync(e.levels)) {
    const a = Math.exp(-2 * Math.PI * 150 / RATE16), HOP = RATE16 * 0.05;
    const y = new Float32Array(samples.length);
    for (let i = 1; i < samples.length; i++) y[i] = a * (y[i - 1] + samples[i] - samples[i - 1]);
    const nF = Math.floor(y.length / HOP), fdb = new Float32Array(nF);
    for (let f = 0; f < nF; f++) { let s = 0; for (let k = f * HOP; k < (f + 1) * HOP; k++) s += y[k] * y[k]; fdb[f] = 10 * Math.log10(s / HOP + 1e-12); }
    const segs = asr.map((s) => {
      const fr = Array.from(fdb.subarray(Math.floor(s.start / 0.05), Math.min(nF, Math.ceil(s.end / 0.05))));
      if (!fr.length) return { start: s.start, end: s.end, db: -99 };
      const top = Math.max(...fr), v = fr.filter((x) => x > top - 25);
      return { start: s.start, end: s.end, db: +(10 * Math.log10(v.reduce((p, x) => p + 10 ** (x / 10), 0) / v.length)).toFixed(1) };
    });
    const gap = [];
    for (let i = 0; i + 1 < asr.length; i++) if (asr[i + 1].start - asr[i].end >= 0.5) for (let f = Math.ceil(asr[i].end / 0.05) + 2; f < Math.floor(asr[i + 1].start / 0.05) - 2; f++) gap.push(fdb[f]);
    gap.sort((p, q) => p - q);
    const dbs = segs.filter((s) => s.end - s.start > 1).map((s) => s.db).sort((p, q) => p - q);
    writeJson(e.levels, { noiseDb: gap.length ? +gap[Math.floor(gap.length * 0.2)].toFixed(1) : null, median: dbs[Math.floor(dbs.length / 2)], spread: [dbs[Math.floor(dbs.length * 0.1)], dbs[Math.floor(dbs.length * 0.9)]], segs }, 0);
  }

  const r = buildFull(dir);
  const lv = readJson(e.levels);
  console.log(`全文：${r.sentences} 句，写到 全文.txt。录音总长 ${fmt(total)}。${r.fixed ? `按节目档案换了 ${r.fixed} 处常错词。` : ''}`);
  console.log(`音量：句与句之间的底噪约 ${lv.noiseDb} dB；各段响度 10%–90% 在 ${lv.spread[0]} 到 ${lv.spread[1]} dB 之间（差得越多，越需要分人调平）。`);
  console.log(mode === 'multitrack'
    ? '下一步：运行 node tools/podcast/speakers.mjs <节目目录>，多轨按音轨认人，几秒钟就好。'
    : '下一步：多人节目在后台跑 node tools/podcast/speakers.mjs <节目目录> 分说话人（要几分钟到十几分钟），同时读 全文.txt；单人节目跳过认人。');
} catch (err) { console.error(err.message); process.exit(1); }
