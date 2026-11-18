#!/usr/bin/env node
// 精编版机器检查：成品逐段重新识别、对照应有的原话（查接缝吞字），以及响度、峰值、时长、配乐。写 精编版/检查报告.json。
//
//   node tools/podcast/check.mjs <节目目录>
//
// 通过 ≠ 好听。最后一定要本人从头听一遍。

import fs from 'node:fs';
import path from 'node:path';
import { relaunchOnMac, loadSherpa, asrModel, threads, episode, mustExist, loadFull, readJson, writeJson, ff, measure, duration, fileSha, fmt, RATE16 } from '../lib/podcast.mjs';

relaunchOnMac();
const dir = process.argv[2];
if (!dir) { console.error('用法: node tools/podcast/check.mjs <节目目录>'); process.exit(2); }
mustExist(dir);
const e = episode(dir);
const mp3 = path.join(e.out, '精编版.mp3');
const edlFile = path.join(e.out, '剪辑表.json');
if (!fs.existsSync(mp3) || !fs.existsSync(edlFile)) { console.error('还没有精编版。先运行 node tools/podcast/build.mjs <节目目录>'); process.exit(1); }

const results = [];
const add = (name, status, detail) => results.push({ name, status, detail });
try {
  const edl = readJson(edlFile);
  const full = loadFull(e);
  if (edl.plan !== fileSha(e.plan)) add('方案', '未通过', '编排方案.json 在剪完之后改过，精编版不是最新的，重新运行 build.mjs');

  // 1. 规格：响度、峰值、时长
  const m = measure(mp3);
  add('响度', Math.abs(m.lufs + 16) <= 1 ? '通过' : '未通过', `${m.lufs} LUFS（目标 -16，±1）`);
  add('峰值', m.peak <= -1 ? '通过' : '未通过', `${m.peak} dBFS（不超过 -1）`);
  add('音量起伏', m.lra <= 10 ? '通过' : '提示', `${m.lra} LU${m.lra > 10 ? '，偏大，听感忽大忽小' : ''}`);
  const wantLen = edl.voiceEnd + 11, got = duration(mp3);
  add('时长', Math.abs(got - wantLen) < 1.5 ? '通过' : '未通过', `${fmt(got)}（剪辑表算出来 ${fmt(wantLen)}）`);
  if (edl.music?.length) {
    const tail = measure(mp3, { ss: edl.voiceEnd + 1.5, t: 3 });
    add('片尾音乐', tail.lufs > -40 ? '通过' : '未通过', `人声结束后 ${tail.lufs} LUFS`);
  }

  // 2. 接缝：每段单独重新识别，比对段首段尾 6 个字
  const sherpa = loadSherpa(), model = asrModel();
  const w16 = path.join(e.mid, 'check16k.wav');
  ff(['-v', 'error', '-i', mp3, '-ar', RATE16, '-ac', 1, '-c:a', 'pcm_s16le', w16], '转 16k');
  const samples = sherpa.readWave(w16, false).samples;
  fs.rmSync(w16, { force: true });
  const rec = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: RATE16, featureDim: 80 }, modelConfig: { senseVoice: { model: model.model, language: 'zh', useInverseTextNormalization: 1 }, tokens: model.tokens, numThreads: threads(), provider: 'cpu', debug: 0 } });
  const BARE = /[，。！？、；：,.!?;:\s]/g;
  const ed = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
  const toks = full.flatMap((s) => s.toks);
  // 每段只认开头和结尾各 8 秒（一段内部是原录音连续的一截，只有两头是剪口；整段一两分钟一次认，模型自己会漏字，造成误报）
  const W = 8;
  const decode = (a, b) => { const st = rec.createStream(); st.acceptWaveform({ sampleRate: RATE16, samples: samples.subarray(Math.round(a * RATE16), Math.round(b * RATE16)) }); rec.decode(st); return rec.getResult(st).text.replace(/<\|[^|]*\|>/g, '').replace(BARE, ''); };
  const want = (a, b) => toks.filter((t) => t.s >= a - 0.02 && t.s < b).map((t) => t.t).join('').replace(BARE, '');
  const seams = [];
  let chars = 0, dist = 0;
  const clips = edl.items.filter((x) => x.kind === 'clip');
  for (const c of clips) {
    const len = Math.min(W, c.out[1] - c.out[0]);
    const hw = want(c.src[0], c.src[0] + len - 0.3), hg = decode(c.out[0], c.out[0] + len);
    const tw = want(c.src[1] - len + 0.3, c.src[1]), tg = decode(c.out[1] - len, c.out[1]);
    chars += hw.length + tw.length; dist += ed(hw, hg) + ed(tw, tg);
    // 两头对不上、而且成品明显少了字才像吞字；字数差不多只是认成了别的字（两次识别的正常出入），多认出半个字（垫音里的现场声）也不算
    const headBad = ed(hw.slice(0, 5), hg.slice(0, 5)) >= 3 && !hg.includes(hw.slice(1, 4)) && hw.length - hg.length >= 3;
    const tailBad = ed(tw.slice(-5), tg.slice(-5)) >= 3 && !tg.includes(tw.slice(-4, -1)) && tw.length - tg.length >= 3;
    if (headBad || tailBad) seams.push({ at: fmt(headBad ? c.out[0] : c.out[1]), where: headBad ? '段首' : '段尾', section: c.section, want: headBad ? hw.slice(0, 12) : tw.slice(-12), got: headBad ? hg.slice(0, 12) : tg.slice(-12) });
  }
  add('接缝', seams.length ? '提示' : '通过', `${clips.length} 段的段首段尾重新识别，和原话差 ${(dist / Math.max(1, chars) * 100).toFixed(1)}%（同一模型两次识别本身也有几个百分点的出入）${seams.length ? `；${seams.length} 处可能吞了字，去听一下：${seams.map((s) => `${s.at}${s.where}`).join('、')}` : ''}`);
  writeJson(path.join(e.out, '检查报告.json'), { at: new Date().toISOString(), mp3: fileSha(mp3), results, seams });
} catch (err) { console.error(err.message); process.exit(1); }

const w = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((k, ch) => k + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));
for (const r of results) console.log(`${w(r.status, 8)}${w(r.name, 10)}${r.detail}`);
const failed = results.filter((r) => r.status === '未通过');
console.log(failed.length ? `\n${failed.length} 项没过。` : '\n机器检查通过。通过不等于好听：请本人从头到尾听一遍。');
process.exit(failed.length ? 1 : 0);
