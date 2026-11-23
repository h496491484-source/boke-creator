#!/usr/bin/env node
// 整期转写：拼接原始录音 → 人声检测切句 → SenseVoice 识别（带标点）→ 全文；顺便测每段响度（人声处理要用）。
// 全在本机 CPU 上跑，不联网。1 小时的录音新电脑约 2 分钟（2026-11-17 实测 65 分钟 95 秒识别），7 代 CPU 的老电脑约 4 分钟（70 分钟 3.9 分钟）。
//
//   node tools/podcast/transcribe.mjs <节目目录> [--force] [--mono | --stereo] [--no-speakers]
//
// --mono：立体声录音两边都有人声、但一边小得多（机器检查"左右声道"提示时）：左右合成一路、按单声道重新转换，识别结果留着。
//         记在 制作文件/录音.json，以后自动补转也照样合成；--stereo 换回立体声。
//
// 产物：制作文件/（原始_44k.wav、16k.wav、识别.json、段响度.json）、全文.txt、全文.json。
// 多人节目转写完会自动开 speakers.mjs 分说话人，等它跑完才退出（先打印"全文已经好了"，这时就能读全文）；
// 单人、已经分过、正在分的不开；加 --no-speakers 也不开，要分时再自己运行 speakers.mjs。

import fs from 'node:fs';
import path from 'node:path';
import { relaunchOnMac, loadSherpa, asrModel, needPodcastModels, pmPath, threads, episode, mustExist, recordingsInfo, sourceMissing, sourceMissingMsg, recordingMode, fileMap, fileMapIssue, lookupFile, trackWav, duration, ff, writeJson, readJson, readJsonLoose, readJsonResult, fileSha, channelInfo, needSpace, pcmBytes, GB, RATE, RATE16, fmt, mins, probe, decodedDuration, wavInfo, infoBlank, recStamp, sameRecStamp, modeIssue, MT_NO_SPLICE, badRecordings, badRecMsg, transcribeErrFile, fullBusy, fullBusyMsg, streamPick } from '../lib/podcast.mjs';
import { buildFull } from './fulltext.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readInfo, isSolo, logStep, lockInfo, lockFile, takeLock, cmd, missingMsg, recName, NO_VOICE, longPathMsg, unknownMedia, unknownMediaMsg } from '../lib/podcast.mjs';
const T0 = Date.now();

relaunchOnMac();
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) { console.error(`用法: ${cmd('transcribe.mjs')} <节目目录> [--force] [--mono | --stereo] [--no-speakers]`); process.exit(2); }
mustExist(dir);
const e = episode(dir);
const force = args.includes('--force');
const monoArg = args.includes('--mono'), stereoArg = args.includes('--stereo');
if (monoArg && stereoArg) { console.error('--mono 和 --stereo 只能给一个。'); process.exit(2); }

try {
  const other = lockInfo(e, '转写');
  if (other?.alive && other.pid !== process.pid) throw new Error(`这期已经在转写了（后台进程 ${other.pid}，已 ${other.minutes} 分钟）。不要重复启动，等它跑完；status.mjs 会显示。确定没在跑的话，删掉 ${other.file} 再来。`);
  const REWAV = !!process.env.BOKE_REWAV; // 剪辑、对比之前自动补转（lib/podcast.mjs 的 ensureWavs）：只许恢复 wav
  takeLock(e, '转写', REWAV ? { rewav: true } : {}); // 自动补转也拿这把锁（clean 认它），但 status 不能说成"第 1 步：转写正在跑"
  needPodcastModels(['vad']);
  const sherpa = loadSherpa(), model = asrModel();
  const recInfo = recordingsInfo(e);
  const { files: recs, orderIssue } = recInfo;
  if (REWAV) {
    const lost = sourceMissing(e);
    if (lost.length) throw new Error(`${sourceMissingMsg(e, lost)}。转好的录音被清理过，要靠原始录音重新转换；找回来之前剪不了。`);
  }
  if (!recs.length && unknownMedia(e).length) throw new Error(unknownMediaMsg(e, unknownMedia(e)));
  if (!recs.length) throw new Error(`节目目录第一层没有录音文件。用 ${cmd('new.mjs', e.work, '<录音文件>')} 放进来（"<录音文件>"换成录音的完整路径；同一个盘用硬链接、别的盘只记位置，不复制、也不挪原文件），不要自己复制或挪动录音。录音已经在节目目录的子文件夹里的，挪到第一层就行。`);
  const miss = recs.filter((f) => !fs.existsSync(f));
  if (miss.length) throw new Error(missingMsg(e, miss));
  // 录音文件坏了、不完整（录音软件崩溃留下的半截 m4a 缺 moov 之类）：说清楚是哪个文件，不转述 ffmpeg 的英文报错；
  // 记下来，status 不再一遍遍叫人重跑 transcribe（2026-11-22 审查）
  fs.rmSync(transcribeErrFile(e), { force: true });
  const bad = badRecordings(recs);
  if (bad.length) { const msg = badRecMsg(e, bad); fs.mkdirSync(e.mid, { recursive: true }); writeJson(transcribeErrFile(e), { at: new Date().toISOString(), files: bad.map((x) => recName(e, x.f)), msg }); throw new Error(msg); }
  // 录音顺序写了却对不上实际文件：停下，不按名字乱拼。只有一种情况放过：多轨（同时录的，顺序不影响声音）
  // 例外：自动补转（剪辑前恢复转好的录音）碰上旧版转写的"前后接着、录音顺序空着"：当初就是按名字排的，照旧恢复，不挡剪辑
  // 全文.txt、全文提纲.md 被占着、只读：最后写全文时一定失败。先停下，什么都不动（不转换、不删旧的识别结果；2026-11-24 复核 #79）。
  // 自动补转不写全文，不管
  const busyNow = REWAV ? [] : fullBusy(e);
  if (busyNow.length) throw new Error(`${fullBusyMsg(e, busyNow)}，再运行一次 ${cmd('transcribe.mjs', e.work)}。这次什么都没动`);
  if (orderIssue && recordingMode(e) !== 'multitrack' && !(REWAV && recInfo.blankOrder)) throw new Error(orderIssue);
  fs.mkdirSync(e.mid, { recursive: true });
  // 录音的名字：节目目录里的是文件名；别的盘上登记的（录音位置.json）用登记的名字，和节目信息里写的对得上
  const nm = (f) => recName(e, f);

  // 1. 合成一条完整录音：前后接着录的首尾拼接；多轨（每人一个文件、同时录）对齐后混音，并把每条轨留一份给认人用
  const mode = recs.length > 1 ? recordingMode(e) : 'single';
  if (!mode) {
    const lens = recs.map((f) => duration(f));
    const similar = Math.max(...lens) - Math.min(...lens) < Math.max(...lens) * 0.05;
    throw new Error(`有 ${recs.length} 个录音文件（${recs.map((f, i) => `${nm(f)} ${fmt(lens[i])}`).join('、')}），先在 节目信息.md 写"录音方式"：前后接着录的，还是多轨（每人一个文件、同时录）。${similar ? '这几个文件长度几乎一样，很可能是多轨。' : ''}`);
  }
  const lp = longPathMsg(e, mode === 'multitrack' ? recs.length : 0); // 节目目录太深：识别程序读不了，先说清楚，不白转一遍
  if (lp) throw new Error(lp);
  // 录音方式和"音轨对应""录音顺序"对不上（多轨节目加了补录、多轨改成了前后接着）：停下，不悄悄叠着混、首尾拼（2026-11-22 审查）
  const mIssue = modeIssue(e, recInfo, mode);
  if (mIssue) throw new Error(mIssue);
  // 多轨："音轨偏移"有名字对不上就停下（偏移不生效，音轨对不齐）；"音轨对应"对不上只影响称呼预填，提醒一下接着转
  if (mode === 'multitrack') {
    const names = recs.map((f) => nm(f));
    const offIssue = fileMapIssue(e, '音轨偏移', names);
    if (offIssue) throw new Error(`${offIssue}再转写：对不上的偏移不会生效，音轨会对不齐。`);
    const whoIssue = fileMapIssue(e, '音轨对应', names);
    if (whoIssue) console.log(`注意：${whoIssue}，再运行 ${cmd('speakers.mjs', e.work, '--force')}（几秒钟）：不改的话说话人.md 的称呼空着，要手填。转写照常做。`);
  }
  const picks = fileMap(e, '音轨选择');
  const pickOf = (f) => lookupFile(picks, nm(f));
  // 录音变没变：文件名、大小、偏移、修改时间（选了音轨的还有选的哪条）。只换了内容、大小一样（比如重新导出一遍）也认得出来（lib/podcast.mjs 的 recStamp，status、build 用同一个）
  const rs = recStamp(e, recs);
  const offsets = rs.offsets, stamp = rs.stamp;
  const meta = readJsonLoose(path.join(e.mid, '录音.json'), {}); // 坏了就当没转过，重新转
  const sameRecs = sameRecStamp(meta, rs);
  // 多轨每条轨的 16k 也要在（clean.mjs 会删掉它们；重新分说话人要用）
  const tracksMissing = mode === 'multitrack' && recs.some((_, i) => !fs.existsSync(trackWav(e, i)));
  // 自动补转只恢复 wav：识别结果都没了的话，那就不是"补转"，是整期重新识别，交给本人单独运行 transcribe
  const REDO = `确实要按现在的录音重做：单独运行 ${cmd('transcribe.mjs', e.work)}（会整期重新识别，句子编号会变），再运行 ${cmd('plan.mjs', e.work)} 按新全文检查编排方案，然后再剪`;
  if (REWAV && (!fs.existsSync(e.asr) || readJsonResult(e.asr).damaged)) throw new Error(`识别结果（制作文件/识别.json）不在了或坏了，自动补转只恢复转好的录音、不重新识别，所以先停下。${REDO}。`);
  let redid = false; // 这次真的转换或识别过：没有的话不记"转写"用时（记一条 0 秒会把真实用时盖掉）
  // --mono 记在 录音.json：录音没换的话，以后重新转换（自动补转、--force）照样合成单声道，直到给 --stereo
  const forceMono = monoArg || (!stereoArg && sameRecs && meta.forceMono === true);
  const chSwitch = (monoArg && meta.channels !== 1) || (stereoArg && meta.forceMono === true);
  if (force || !sameRecs || !fs.existsSync(e.wav44) || !fs.existsSync(e.wav16) || tracksMissing || chSwitch) {
    // 后台分说话人手里拿着旧录音，这时换录音，它跑完会把旧录音的结果写回来
    const sj = lockInfo(e, '分说话人');
    if (sj?.alive) throw new Error(`分说话人还在后台跑（进程 ${sj.pid}，已 ${sj.minutes} 分钟），它用的是旧录音。等它跑完再重新转写（status.mjs 会显示）；确定没在跑的话，删掉 ${sj.file} 再来。`);
    fs.rmSync(e.wav44dn, { force: true }); // 旧版留下的整条降噪副本（约 700 MB），现在用不着，先删掉再算空间
    // 每个文件用哪几条音频流（从 0 数）。只有一条的就用它；有几条、又没写"音轨选择"的先停下问（以前悄悄只用第一条，别的丢了）。
    // 自动补转不问：当初就是按第一条转的，照旧
    const multiStream = [];
    const sel = recs.map((f) => {
      const n = probe(f, { needDuration: false }).streams?.length || 1, v = pickOf(f);
      if (v == null || infoBlank(v)) { if (n > 1 && !REWAV) multiStream.push(f); return [0]; }
      const r = streamPick(nm(f), v, n);
      if (r.bad) throw new Error(r.bad);
      return r.sel;
    });
    if (multiStream.length) {
      const vol = (f, k) => { const o = ff(['-nostats', '-t', 300, '-i', f, '-map', `0:a:${k}`, '-af', 'volumedetect', '-f', 'null', '-'], '看音轨'); return Number((o.match(/mean_volume:\s*(-?[\d.]+)/) ?? [])[1]); };
      const desc = (f) => probe(f, { needDuration: false }).streams.map((s, k) => { const v = vol(f, k); return `第 ${k + 1} 条：${s.channels === 1 ? '单声道' : s.channels === 2 ? '立体声' : `${s.channels} 声道`}，前 5 分钟平均音量 ${Number.isFinite(v) ? `${v} dB${v < -60 ? '（几乎没声音）' : ''}` : '没有声音'}`; }).join('；');
      throw new Error(`${multiStream.map((f) => `${nm(f)} 里有 ${probe(f, { needDuration: false }).streams.length} 条音轨（${desc(f)}）`).join('。')}。`
        + `不知道该用哪条，先停下（以前只悄悄用第一条，别的丢了）。问主理人用哪条，在 节目信息.md 加一行"- 音轨选择：${nm(multiStream[0])}=2"（写第几条，从 1 数；几条是不同的人、要一起用，写"全部"），再运行 ${cmd('transcribe.mjs', e.work)}`);
    }
    // 滤镜里取第 i 个输入文件选中的音频流；选了几条的先混成一条。
    // 选了几条一起用时，每条先单独看声道：只有一边有声音的那条（OBS 里单边接线的话筒轨）先取有声音的那边、铺满两路，
    // 单声道的那条也铺满两路，再和别的轨混。不这样，和一条真立体声混在一起时那个人只在一只耳朵里；几条都像单声道时，
    // 那条会和没声音的那边平均、小 6 dB 还混进底噪（2026-11-24 第 3 轮 3）。layout 在下面定（调用时已经有了）
    const srcOf = (i, input = i) => {
      if (sel[i].length === 1) return `[${input}:a:${sel[i][0]}]`;
      const fix = (j) => {
        const c = streamChs[i][j];
        if (c.only != null) return layout === 'mono' ? `pan=mono|c0=c${c.only},` : `pan=stereo|c0=c${c.only}|c1=c${c.only},`;
        return c.channels === 1 && layout === 'stereo' ? 'pan=stereo|c0=c0|c1=c0,' : '';
      };
      return `${sel[i].map((k, j) => `[${input}:a:${k}]${fix(j)}aformat=channel_layouts=${layout}[t${i}_${j}]`).join(';')};${sel[i].map((_, j) => `[t${i}_${j}]`).join('')}amix=inputs=${sel[i].length}:normalize=0:duration=longest,`;
    };
    const lens = recs.map((f) => duration(f));
    const offs = recs.map((f) => Number(String(lookupFile(offsets, nm(f)) ?? '0').replace(/[^\d.+-]/g, '')) || 0);
    const total = mode === 'multitrack' ? Math.max(...lens.map((l, i) => l + Math.max(0, offs[i]))) : lens.reduce((a, b) => a + b, 0);
    // 只提醒、不挡：多轨里有一条比最长的短一半以上（像补录的旁白，会叠在开头混音）；前后接着的几个文件长度几乎一样（像多轨，拼起来长度翻倍）
    const longest = Math.max(...lens);
    if (!REWAV && mode === 'multitrack') { const short = recs.filter((_, i) => lens[i] < longest * 0.5); if (short.length) console.log(`注意：多轨里${short.map((f) => `「${nm(f)}」（${fmt(lens[recs.indexOf(f)])}）`).join('、')}比最长的一条（${fmt(longest)}）短一半以上，会当成同时录的一条音轨、从开头叠着混音。它是补录的旁白或另一期的话，先停下这次转写：${MT_NO_SPLICE}`); }
    if (!REWAV && mode === 'sequential' && recs.length > 1 && longest - Math.min(...lens) < longest * 0.05) console.log(`注意：这 ${recs.length} 个文件长度几乎一样（${recs.map((f, i) => `${nm(f)} ${fmt(lens[i])}`).join('、')}），问一下主理人是不是多轨（每人一个话筒、同时录）。是前后接着录的（上下半场、两期拼接长度本来就差不多），不用管，转写照常；真是多轨的话，"前后接着"会把每个人的音轨首尾相接、长度翻倍：停下这次转写，把录音方式改成多轨、写好"音轨对应"再转写`);
    // 每个录音（选中的那条音轨）的声道：只有一边有声音的只取那一边。选了几条一起用（先混成一条）的：每条单独看（srcOf 里逐条处理），
    // 整个文件不再单取一边；只有一边有声音的那条取出来以后是单声道
    const streamChs = recs.map((f, i) => (sel[i].length === 1 ? null : sel[i].map((k) => ({ ...channelInfo(f, k), channels: probe(f, { needDuration: false }).streams?.[k]?.channels ?? 2 }))));
    const chs = recs.map((f, i) => (sel[i].length === 1 ? channelInfo(f, sel[i][0]) : { mono: streamChs[i].every((c) => c.mono), only: null }));
    const mono = forceMono || chs.every((c) => c.mono);
    const CH = mono ? 1 : 2;
    // 只有一边声道有声音的录音：只取那一边（下面 norm、转音轨时先 pan 出来）
    const pick = (i) => (chs[i].only == null ? '' : `pan=mono|c0=c${chs[i].only},`);
    // 先算空间：转好的录音 + 16k + （多轨）每条轨，要覆盖的旧文件算回来；剪辑另要的空间先说一声，build 开工前会再查
    const nTracks = mode === 'multitrack' ? recs.length : 0;
    const sz = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
    const reuse = sz(e.wav44) + sz(e.wav16) + recs.reduce((s, _, i) => s + (nTracks ? sz(trackWav(e, i)) : 0), 0);
    const need = pcmBytes(total, RATE, CH) + pcmBytes(total, RATE16, 1) * (nTracks + 1);
    const later = pcmBytes(total * 0.7, RATE, CH) + 2 * pcmBytes(total * 0.7, RATE, 2);
    needSpace(e.work, Math.max(0, need - reuse), `这期（${fmt(total)}）转写`);
    console.log(`录音 ${fmt(total)}，${forceMono && !chs.every((c) => c.mono) ? '按 --mono 把左右两边合成一路，按单声道处理' : mono ? '单声道（或左右声道一样），按单声道处理' : '立体声'}；转好的录音约 ${GB(need)}，剪辑时还要临时占约 ${GB(later)}。`);
    const oneSide = recs.flatMap((f, i) => (chs[i].only != null ? [`${nm(f)} 只有${chs[i].only ? '右' : '左'}声道有声音`]
      : (streamChs[i] ?? []).map((c, j) => (c.only == null ? null : `${nm(f)} 的第 ${sel[i][j] + 1} 条音轨只有${c.only ? '右' : '左'}声道有声音`)).filter(Boolean)));
    if (oneSide.length) console.log(`${oneSide.join('、')}（另一边几乎没声音，多半是话筒只插了声卡的一个输入）：只用有声音的那边${mono ? '，按单声道处理' : '、铺满左右两边'}，成品两只耳朵都听得到。`);
    const inputs = recs.flatMap((f) => ['-i', f]);
    const layout = mono ? 'mono' : 'stereo';
    const norm = (i) => `${srcOf(i)}${pick(i)}aresample=${RATE},aformat=channel_layouts=${layout}`;
    // 先写成 .part.wav，成功了再改名：中途断掉不会留下半截文件，下次也不会被当成好的
    const part = (p) => p.replace(/\.wav$/, '.part.wav');
    const done = (p) => fs.renameSync(part(p), p);
    for (const p of [e.wav44, e.wav16, ...recs.map((_, i) => trackWav(e, i))]) fs.rmSync(part(p), { force: true });
    // 一次解码同时出 44.1k（剪辑用）和 16k 单声道（识别、分说话人用），不再把刚写好的大文件读一遍
    const outs = (graph) => ['-filter_complex', `${graph};[o]asplit=2[o44][o16x];[o16x]aresample=${RATE16},aformat=channel_layouts=mono[o16]`, '-map', '[o44]', '-c:a', 'pcm_s16le', part(e.wav44), '-map', '[o16]', '-c:a', 'pcm_s16le', part(e.wav16)];
    if (mode === 'multitrack') {
      console.log(`多轨混音 ${recs.length} 条音轨：${recs.map((f) => nm(f)).join('、')}`);
      const delay = (f) => { const s = Number(String(lookupFile(offsets, nm(f)) ?? '0').replace(/[^\d.+-]/g, '')) || 0; return s > 0 ? `,adelay=${Math.round(s * 1000)}:all=1` : s < 0 ? `,atrim=start=${-s},asetpts=PTS-STARTPTS` : ''; };
      // 各轨直接相加（不按轨数压低），最后限幅防止几个人同时大声时削顶
      const mix = `${recs.map((f, i) => `${norm(i)}${delay(f)}[a${i}]`).join(';')};${recs.map((_, i) => `[a${i}]`).join('')}amix=inputs=${recs.length}:normalize=0:duration=longest,alimiter=limit=0.95:level=false[o]`;
      ff(['-v', 'error', ...inputs, ...outs(mix)], '多轨混音');
      // 每条轨用和混音同一条音频流（不让 ffmpeg 自己挑：没有 default 标记时它可能挑另一条）
      recs.forEach((f, i) => ff(['-v', 'error', '-i', f, '-filter_complex', `${srcOf(i, 0)}${pick(i)}aresample=${RATE16}${delay(f)}[o]`, '-map', '[o]', '-ac', 1, '-c:a', 'pcm_s16le', part(trackWav(e, i))], '转音轨'));
    } else {
      console.log(`${recs.length > 1 ? '拼接并' : ''}转换 ${recs.length} 个录音文件：${recs.map((f) => nm(f)).join(' + ')}`);
      const cat = `${recs.map((_, i) => `${norm(i)}[a${i}]`).join(';')};${recs.map((_, i) => `[a${i}]`).join('')}concat=n=${recs.length}:v=0:a=1[o]`;
      ff(['-v', 'error', ...inputs, ...outs(cat)], recs.length > 1 ? '拼接录音' : '转换录音');
    }
    // 前后接着拼的：记下每个文件在拼起来以后从哪儿开始（按实际解码出来的长度，mp3 文件头里的时长可能差几秒）。
    // 识别时在换文件的地方断开，全文、提纲标出来，locate 换回"哪个文件第几秒"
    let start = 0;
    const parts = mode === 'sequential' ? recs.map((f, i) => { const d = decodedDuration(f, sel[i][0]) || duration(f); const p = { name: nm(f), start: +start.toFixed(3), dur: +d.toFixed(3) }; start += d; return p; }) : null;
    const newWavs = [e.wav44, e.wav16, ...(mode === 'multitrack' ? recs.map((_, i) => trackWav(e, i)) : [])];
    const wav16sha = fileSha(part(e.wav16));
    // 自动补转碰上"录音和上次不一样"（名字、大小、修改时间、偏移有一样变了）：转出来的 16k 和上次一模一样，说明内容其实没变
    // （比如只是修改时间变了），照常换上；不一样就把这次转的删掉、什么都不动，停下说清楚。不悄悄重新识别
    if (REWAV && !sameRecs && (!meta.wav16sha || wav16sha !== meta.wav16sha)) {
      for (const p of newWavs) fs.rmSync(part(p), { force: true });
      // 记下"按这个指纹核对过、内容不一样"：名字大小都没变、只是修改时间变了的，status、clean、确认门以后按"录音改过"算，
      // 不再说"剪之前会先核对"（2026-11-24 复核：以前核对没过也不记，status 照样叫人剪、clean 照样清）。录音.json 别的不动
      if (meta.stamp) writeJson(path.join(e.mid, '录音.json'), { ...meta, contentChanged: { stamp, at: new Date().toISOString() } });
      throw new Error(`录音和当初转写时不一样了（换过文件、重新导出过、改了音轨偏移，或者原文件在原位置被改过），转出来的内容也对不上。`
        + `自动补转只恢复转好的录音，不会悄悄重新识别（那样句子编号会对不上已经定好的编排方案），所以先停下：识别、分说话人、全文都没动，这次也没剪。`
        + `录音其实没换的话：把原来那份放回来，再运行一次同一条命令。${REDO}。`);
    }
    // 录音文件不完整（截掉了后半截、没下载完、没拷完）：文件头写的时长比实际能解出来的长。以前不比，少了的那段悄悄没了（转好的 16k 还没换上，看 .part）
    const got = wavInfo(part(e.wav16)).frames / RATE16;
    const short = (head, real) => head - real > Math.max(5, head * 0.02);
    let lengthWarn = null;
    const expect = mode === 'multitrack' ? Math.max(...lens.map((l, i) => l + offs[i])) : total; // 多轨：偏移是负的那条轨开头被剪掉了
    if (short(expect, got) || recs.some((f) => probe(f).declared)) {
      const bad = recs.map((f, i) => { const p = probe(f); const head = p.declared ?? lens[i], real = p.declared ? p.duration : decodedDuration(f, sel[i][0]); return short(head, real) ? `${nm(f)}（文件头写的 ${fmt(head)}，实际只解得出 ${fmt(real)}）` : null; }).filter(Boolean);
      if (!bad.length && short(expect, got)) bad.push(`转出来只有 ${fmt(got)}，比文件头写的 ${fmt(expect)} 短`);
      if (bad.length) {
        lengthWarn = `录音可能不完整：${bad.join('、')}。少的那段转不出来，全文和精编版里都不会有${mode === 'sequential' ? '（前后接着录的，后面的录音会提前接上）' : ''}。`
          + `问主理人录音本来有多长：本来就这么长（有的 mp3 文件头写的时长不准）就不用管，告诉过他以后确认素材，status 就不再提醒；不是的话，多半是文件没传完、没下载完或者坏了：换成完整的文件，再运行 ${cmd('transcribe.mjs', e.work)}（换了录音会整期重新识别）`;
        console.error(`注意：${lengthWarn}`);
      }
    }
    // 16k 跟上次一模一样（比如只是 --force 重新转一遍），分说话人结果留着（它最慢）；识别在 --force 时照样重做。
    // 录音本身没变、只是转好的文件被删了（clean.mjs 清理过）：识别、分说话人、段响度一律留着，
    // 哪怕换了 ffmpeg 版本、转出来的 16k 差了几个字节也不重做（那些结果是按原录音的时间记的）
    const onlyMissing = sameRecs && !force;
    const redo = wav16sha !== meta.wav16sha && !onlyMissing;
    // 要整期重新识别：先删掉旧的识别结果和旧全文，再换上新录音。中途被打断（关了终端、宿主杀了进程）时留下的是"没有全文"，
    // status 会说重新转写，不会出现"新录音 + 旧全文"、finish 照旧句子的时间去剪新录音（2026-11-22 审查）
    // 最容易被别的程序开着的 全文.txt、全文提纲.md 先删：删不掉（开工后才被打开）就停下，识别结果、全文.json 一个不动，新录音也不换上
    if (redo) for (const f of [e.fullTxt, e.outline, e.full, e.asr, e.diar, e.levels]) {
      try { fs.rmSync(f, { force: true }); } catch (err) {
        if (!/EBUSY|EPERM|EACCES/.test(err.code ?? '')) throw err;
        for (const p of newWavs) fs.rmSync(part(p), { force: true });
        throw new Error(`${fullBusyMsg(e, [path.basename(f)])}，再运行一次 ${cmd('transcribe.mjs', e.work)}。${f === e.fullTxt || f === e.outline ? '这次什么都没动' : '新录音还没换上，再运行时会重新识别'}`);
      }
    }
    for (const p of newWavs) done(p);
    if (redo) {
      if (meta.stamp && !force) console.log('录音和上次转写时不一样了：整期重新识别，句子编号可能变；已经写好的编排方案要重新运行 plan.mjs 检查（build 会拦下没检查的）。');
    } else console.log(onlyMissing ? `录音没变，只是重新转换了格式${chSwitch ? `（换成${mono ? '单声道' : '立体声'}）` : ''}：识别和分说话人结果都留着${wav16sha === meta.wav16sha || chSwitch ? '' : '（转出来和上次差了一点，多半是换了 ffmpeg 版本，不影响）'}。${chSwitch ? `已经剪过的话，重新运行 ${cmd('finish.mjs', e.work)} 再剪一遍（重剪、重新检查、重出简介；单独跑 build 会删掉检查报告和节目简介）。` : ''}`
      : force ? '录音内容没变，分说话人结果留着。' : '录音文件的名字、大小或修改时间变了，但内容和上次一样：识别和分说话人结果都留着。');
    // only：每个录音只取了哪边（check 用它判断"重新转换能不能改好左右声道"）
    writeJson(path.join(e.mid, '录音.json'), { stamp, mode, files: recs.map((f) => nm(f)), ...(parts ? { parts } : {}), channels: CH, only: chs.map((c) => c.only), ...(streamChs.some(Boolean) ? { streamOnly: streamChs.map((x) => x?.map((c) => c.only) ?? null) } : {}), sel, ...(forceMono ? { forceMono: true } : {}), wav16sha, ...(lengthWarn ? { lengthWarn, lengthWarnAt: lengthWarn === meta.lengthWarn && meta.lengthWarnAt ? meta.lengthWarnAt : new Date().toISOString() } : {}) });
    redid = true;
  }
  let samples = sherpa.readWave(e.wav16, false).samples; // 用完（识别、段响度）就放掉：下面要等分说话人跑完，2 小时的录音光这个就占 0.5 GB
  const total = samples.length / RATE16;

  // 2. 识别。识别.json 写到一半被打断（坏了）也重新识别：以前当成"有"，跳过识别后又说"还没有识别结果"，怎么重跑都一样（2026-11-22 审查 77）
  const asrBad = readJsonResult(e.asr).damaged;
  if (asrBad) console.log('制作文件/识别.json 坏了（多半是上次写到一半被打断）：重新识别。');
  if (force || !fs.existsSync(e.asr) || asrBad) {
    console.log(`识别 ${mins(total)} 的录音（本机 CPU，${threads()} 线程）……`);
    const vad = new sherpa.Vad({
      sileroVad: { model: pmPath('vad'), threshold: 0.5, minSilenceDuration: 0.4, minSpeechDuration: 0.25, windowSize: 512, maxSpeechDuration: 20 },
      sampleRate: RATE16, numThreads: 1, provider: 'cpu', debug: 0,
    }, 120);
    // 先用 VAD 切好所有句段（很快），再开几路同时识别：一段一段排队时 CPU 有一半在等
    const T = threads(), lanes = Math.min(4, T), per = Math.max(1, Math.floor(T / lanes));
    const rec = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: RATE16, featureDim: 80 },
      modelConfig: { senseVoice: { model: model.model, language: 'zh', useInverseTextNormalization: 1 }, tokens: model.tokens, numThreads: per, provider: 'cpu', debug: 0 },
    });
    const t0 = Date.now(), cuts = [];
    const drain = () => { while (!vad.isEmpty()) { const s = vad.front(false); vad.pop(); cuts.push({ a: s.start, n: s.samples.length }); } };
    for (let i = 0; i < samples.length; i += 512) { vad.acceptWaveform(samples.subarray(i, Math.min(i + 512, samples.length))); drain(); }
    vad.flush(); drain();
    // 前后接着拼的录音：一段跨了两个文件（剪得很紧的接缝）就在换文件的地方切开，一句话不会一半是正片、一半是补录
    const bounds = ((readJson(path.join(e.mid, '录音.json'), {}).parts ?? []).slice(1)).map((p) => Math.round(p.start * RATE16));
    for (const b of bounds) { const k = cuts.findIndex((c) => c.a < b && b < c.a + c.n); if (k >= 0) { const c = cuts[k]; cuts.splice(k, 1, { a: c.a, n: b - c.a }, { a: b, n: c.a + c.n - b }); } }
    const res = new Array(cuts.length);
    let next = 0, done = 0, lastLog = Date.now();
    const lane = async () => {
      while (next < cuts.length) {
        const k = next++, c = cuts[k];
        const st = rec.createStream();
        st.acceptWaveform({ sampleRate: RATE16, samples: samples.subarray(c.a, c.a + c.n) });
        res[k] = await rec.decodeAsync(st);
        done++;
        if (Date.now() - lastLog > 15000) { lastLog = Date.now(); console.log(`  已识别 ${Math.round(done / cuts.length * 100)}%`); }
      }
    };
    await Promise.all(Array.from({ length: lanes }, lane));
    const segs = [];
    cuts.forEach((c, k) => {
      const r = res[k], offset = c.a / RATE16;
      const toks = (r.tokens ?? []).map((t, i) => ({ t: String(t).replace(/▁/g, ''), s: +(offset + r.timestamps[i]).toFixed(2) })).filter((x) => x.t && !/^<\|.*\|>$/.test(x.t));
      if (toks.length) segs.push({ start: +offset.toFixed(2), end: +(offset + c.n / RATE16).toFixed(2), text: toks.map((x) => x.t).join(''), toks });
    });
    writeJson(e.asr, segs, 0);
    console.log(`识别完成：${segs.length} 段，用了 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
    redid = true;
  }
  const asr = readJson(e.asr);
  // 一句都没识别出来（整段静音、只有底噪、放错了文件或音轨）：说清楚、停下，不出空全文、不开分说话人（它必定失败）。
  // 空的识别结果留着，status 据此给同样的提示；换了录音会整期重新识别
  if (!asr?.length) throw new Error(NO_VOICE(e));

  // 3. 每段响度（一阶高通约 150Hz 粗略模拟人耳加权，50ms 一帧，只算比该段最响帧低 25dB 以内的帧）+ 底噪
  if (force || !fs.existsSync(e.levels) || asrBad || readJsonResult(e.levels).damaged) {
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
  samples = null; // 识别时的闭包还引用着这个变量：不置空的话，等分说话人的这十几分钟里整段采样一直占着内存

  // 剪辑前自动补转录音（lib/podcast.mjs 的 ensureWavs，clean.mjs 清理过之后）：转好就回去接着剪。
  // 全文不重建：重建会套上后来加的常错词、新的称呼规则，plan 检查过的 startText/endText 就可能对不上（2026-11-20 审查 F3）
  if (REWAV) { console.log(`录音重新转换好了（${Math.round((Date.now() - T0) / 1000)} 秒），全文没动，接着做。`); logStep(e, '重新转换录音', T0); process.exit(0); }
  // 分说话人正在后台跑（多半是上一次 transcribe 开的，它还在等）：这次录音没变、识别也没重做，什么都不用做。
  // 不重写全文：分说话人跑完也会重写，两边同时写会写花
  const sjNow = lockInfo(e, '分说话人');
  if (sjNow?.alive) { console.log(`分说话人正在后台跑（进程 ${sjNow.pid}，已 ${sjNow.minutes} 分钟），${redid ? '识别结果更新了，它跑完会按新的重写全文' : '全文已经好了，这次什么都没重做'}。不用再运行 transcribe，等它跑完 status.mjs 会显示。`); process.exit(0); }
  let r;
  try { r = buildFull(dir); } catch (err) {
    // 全文.json 最后写（fulltext.mjs）：写到一半出错时它还是旧的、比 识别.json 早，status 会说"全文没写完"
    if (err.busy) throw new Error(`全文没写完：${err.message}，再运行一次 ${cmd('transcribe.mjs', e.work)}（识别结果已经存好，不会重新识别）。`);
    const busy = /EBUSY|EPERM|EACCES/.test(`${err.code} ${err.message}`);
    throw new Error(`全文没写完：${err.message}\n${busy ?'全文.txt（或 全文提纲.md、编排方案.草稿.json）被别的程序占着，或者是只读的：关掉占用它的程序（编辑器、预览窗口）、去掉只读，' : ''}再运行一次 ${cmd('transcribe.mjs', e.work)}（识别结果已经存好，不会重新识别）。`);
  }
  const lv = readJson(e.levels);
  console.log(`全文：${r.sentences} 句，写到 全文.txt（提纲 ${r.outline?.blocks ?? 0} 块，在 全文提纲.md）。录音总长 ${fmt(total)}。${r.fixed ? `按节目档案换了 ${r.fixed} 处常错词。` : ''}`);
  console.log(`音量：${lv.noiseDb == null ? '句与句之间几乎没有停顿，底噪量不出来' : `句与句之间的底噪约 ${lv.noiseDb} dB`}；各段响度 10%–90% 在 ${lv.spread[0]} 到 ${lv.spread[1]} dB 之间（差得越多，越需要分人调平）。`);
  if (redid) logStep(e, '转写', T0);
  // 转写完自动在后台开始分说话人（不靠 AI 记得去开）：节目信息里写了"单人"、已经分过、正在分、或者加了 --no-speakers 就不开
  const info = readInfo(e);
  const solo = isSolo(info);
  const running = lockInfo(e, '分说话人')?.alive;
  // 分段有了、说话人.md 没有：上次分说话人半路断了，再开一次（分好的段直接用，几秒钟）
  if (!solo && !running && (!fs.existsSync(e.diar) || !fs.existsSync(e.names)) && !args.includes('--no-speakers')) {
    // 日志接着往后写（不清空）：万一同时有两个在写，也不会把对方写的冲掉；status 叫人看的是最后几行
    const logFile = path.join(e.mid, '分说话人.log');
    const log = fs.openSync(logFile, 'a');
    fs.writeSync(log, `\n==== ${new Date().toLocaleString()} 转写跑完，开始分说话人 ====\n`);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./speakers.mjs', import.meta.url)), e.work], { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: { ...process.env, BOKE_FROM_TRANSCRIBE: String(process.pid) } });
    const ended = new Promise((resolve) => { child.on('exit', (code, signal) => resolve({ code, signal })); child.on('error', (err) => resolve({ code: -1, err })); });
    // 先替它占好"分说话人"的锁（starter 记的是这个转写进程，speakers 认得是替自己占的），再放掉"转写"的锁：
    // 中间不留两把锁都不在的空当，不然这时再运行一次 transcribe 会又开一个 speakers。它自己拿锁时会写上自己的（wx：它已经拿了就不动）
    const spkLock = lockFile(e, '分说话人');
    // 留下的是上次被强行结束的分说话人的旧锁（进程已经不在了）：照样盖上。以前用 wx，旧锁在就什么都没写，
    // 放掉"转写"锁以后这时手动运行的 speakers 能抢进来，自动开的这个反而退出 3（2026-11-24 第 3 轮 5）。
    // 只有它自己已经拿到了（锁里是它的进程号）才不动，免得盖掉它记的 busyUntil
    if (child.pid) { try { if (readJsonLoose(spkLock, null)?.pid !== child.pid) fs.writeFileSync(spkLock, JSON.stringify({ pid: child.pid, at: new Date().toISOString(), starter: process.pid }) + '\n'); } catch {} }
    // 实测：新电脑 1 小时约 3 分钟，7 代 CPU 的老电脑 70 分钟要 12.5 分钟
    const m = total / 60 / 60;
    const est = mode === 'multitrack' ? '几秒钟' : m * 11 < 1.5 ? '1 分钟左右' : `约 ${Math.max(1, Math.round(m * 3))}–${Math.max(2, Math.round(m * 11))} 分钟，电脑越老越久`;
    console.log(`全文已经好了。现在开始分说话人（${est}，进度看 制作文件/分说话人.log，status.mjs 也会显示）。`);
    console.log('不用等它：现在就去读 全文提纲.md（再按需读 全文.txt）、问节目信息、写编排方案。但这个命令要等分说话人跑完才结束，别停它、别关它所在的终端或后台任务。');
    // 等它跑完再退出：有的宿主（如 WorkBuddy）后台任务一结束，就把它开出来的进程一起杀掉，detached 也没用（实测白跑 2 分多钟）。
    // 转写本身已经完了：放掉"转写"的锁，status 不会再显示"转写正在跑"
    const mine = lockInfo(e, '转写');
    if (mine?.pid === process.pid) fs.rmSync(mine.file, { force: true });
    // 等的时候每 20 秒打一行，长节目要等十几分钟，不打的话看着像卡住了（分说话人是一整块计算，日志里也没有进度）
    const t1 = Date.now();
    const lastLine = () => { try { return fs.readFileSync(logFile, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).at(-1)?.slice(0, 80) ?? ''; } catch { return ''; } };
    const beat = setInterval(() => { const t = lastLine(); console.log(`  还在分说话人，已 ${Math.round((Date.now() - t1) / 1000)} 秒${t ? `（日志最后一行：${t}）` : ''}`); }, 20000);
    const { code, signal, err } = await ended;
    clearInterval(beat);
    // 替它占的锁它没接手（没跑起来、一开始就出错退了）：删掉
    const left = readJson(spkLock, null);
    if (left?.starter === process.pid && left.pid === child.pid) fs.rmSync(spkLock, { force: true });
    if (code === 0 && fs.existsSync(e.names)) console.log('分说话人跑完了：结果在 说话人.md，status.mjs 会提示下一步。');
    else if (code === 3) console.log('另一个分说话人已经在跑（不是这次开的），这次没再开。等它跑完，status.mjs 会显示。');
    else {
      // 全文是好的，只是分说话人没成：退出码 3，和"转写失败"（1）分开；说明写到 stderr，宿主只看报错也能看到
      const why = err ? `没能启动：${err.message}` : signal ? `被 ${signal} 结束了` : code === 0 ? '没写出 说话人.md' : `退出码 ${code}`;
      console.error(`分说话人没跑完（${why}）。全文是好的，编排方案照常写；看 制作文件/分说话人.log 最后几行，处理好后在后台再运行一次 ${cmd('speakers.mjs', e.work)}${fs.existsSync(e.diar) ? '（已分好的段直接用，几秒钟）' : ''}。`);
      process.exitCode = 3;
    }
  } else if (running) console.log('分说话人已经在后台跑了，不用再开。');
  else console.log(solo ? `节目信息里写的是单人：不用分说话人，下一步 ${cmd('status.mjs', e.work, '--skip', '认人')}，然后先读 全文提纲.md、再按需读 全文.txt，写编排方案。` : '下一步：先读 全文提纲.md、再按需读 全文.txt，写编排方案。');
} catch (err) { console.error(err.message); process.exit(1); }
