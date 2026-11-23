// 播客精编几个工具共用的东西：节目目录里的文件位置、模型、识别程序、ffmpeg、节目信息。
//
// 一期节目一个文件夹（下文 <节目>）：
//   原始录音（一个或几个音频文件，放在第一层；同一个盘是硬链接，不占空间）      节目信息.md     说话人.md     声音点名.mp3
//   录音位置.json（录音在别的盘时，new.mjs 不拷贝，只在这里记原文件的位置）
//   全文.txt / 全文.json / 全文提纲.md     编排方案.草稿.json（机器切的）     编排方案.json → 编排方案.md
//   方案原文.json（plan.mjs 记的每段原文和检查时的指纹：重新识别后编号错位靠它拦，别删）
//   处理前后对比/     精编版/     状态.json
//   制作文件/   中间文件（转好的 wav、识别结果、分说话人结果、段响度）。别整个删（识别结果删了要重新识别，句子编号可能变）；
//               腾空间用 clean.mjs：成品确认后只删其中的大文件（wav），json 留着，重剪时自动重新转换

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT, loadConfig, saveConfig, findFfmpeg, ffBin, tryRun, platformName, cmd } from './env.mjs';
import { findSherpa, findModel } from '../asr.mjs';

export { ROOT, cmd };
export const RATE16 = 16000;
export const RATE = 44100;
export const PM_DIR = path.join(ROOT, 'models', 'podcast');
export const MUSIC = path.join(ROOT, 'template', '配乐', 'aurora_cc0.mp3');

// 播客精编额外要的三个模型（sherpa-onnx 项目转换发布的 onnx 文件），下载后按大小和 sha256 核对
const GH = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const HF = 'https://hf-mirror.com/csukuangfj';
export const PODCAST_MODELS = {
  vad: {
    file: 'silero_vad.onnx', bytes: 643854, sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
    what: '人声检测（Silero VAD，MIT）', urls: [`${GH}/asr-models/silero_vad.onnx`, `${HF}/vad/resolve/main/silero_vad.onnx`],
  },
  seg: {
    file: 'pyannote-segmentation-3-0.onnx', bytes: 5992913, sha256: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079',
    what: '说话人切分（pyannote segmentation 3.0，MIT）',
    urls: [{ archive: `${GH}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`, member: 'model.onnx' }, `${HF}/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx`],
  },
  emb: {
    file: '3dspeaker-eres2net-base-zh.onnx', bytes: 39593761, sha256: '1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b',
    what: '声纹（3D-Speaker ERes2Net base 中文，Apache-2.0）',
    urls: [`${GH}/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`, `${HF}/speaker-embedding-models/resolve/main/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`],
  },
};
export const pmPath = (key) => path.join(PM_DIR, PODCAST_MODELS[key].file);
export const pmReady = (key) => { try { return fs.statSync(pmPath(key)).size === PODCAST_MODELS[key].bytes; } catch { return false; } };
export const podcastModelsReady = () => Object.keys(PODCAST_MODELS).every(pmReady);

// ---- 识别程序 ----
// Mac 和 Linux 上要先告诉系统动态库在哪（sherpa-onnx-node 自己的说明这么要求：Mac 设 DYLD_LIBRARY_PATH，Linux 设 LD_LIBRARY_PATH），
// 系统只在进程启动时读这个变量，所以设好后重新启动自己一次。没在 Mac、Linux 上实测过。
// 自检（envChecks）和 setup 试加载时用同一套变量，免得转写能用、自检却说加载不起来（或者反过来）
export function sherpaLibEnv(s = findSherpa()) {
  const key = { darwin: 'DYLD_LIBRARY_PATH', linux: 'LD_LIBRARY_PATH' }[process.platform];
  if (!key || !s.ok) return {};
  const lib = path.join(s.dir, 'node_modules', `sherpa-onnx-${process.platform}-${process.arch}`);
  return { [key]: [lib, process.env[key]].filter(Boolean).join(':') };
}
// 真的加载一次识别程序（在子进程里，加载失败不影响自己）。文件在不算数：平台包缺了、动态库被杀毒软件隔离了都会加载不起来
export const sherpaLoads = (s = findSherpa()) => !!(s.ok && tryRun(process.execPath, ['-e', `require(${JSON.stringify(s.pkg)})`], { env: { ...process.env, ...sherpaLibEnv(s) } }));
// setup 已经删掉平台包重装过、还是加载不起来，之后平台包没动过（它记在 .state/sherpa-reinstalled.json，和 tools/setup.mjs 一个判断）：
// 再运行 setup 也不会重装，自检直接说原因
export function sherpaGaveUp() {
  try {
    const mark = JSON.parse(fs.readFileSync(path.join(ROOT, '.state', 'sherpa-reinstalled.json'), 'utf8'));
    return mark.stamp === fs.statSync(path.join(ROOT, 'node_modules', `sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`)).mtimeMs;
  } catch { return false; }
}
export function relaunchOnMac() { // 名字是历史原因，Linux 也走这里
  if (!['darwin', 'linux'].includes(process.platform) || process.env.BOKE_ASR_CHILD) return;
  // node 自己的启动参数（--max-old-space-size 之类）也带上；子进程起不来、被系统结束（内存不够、被超时结束）都要说出来，
  // 不能一声不吭地退出（2026-11-22 审查 85）。宿主只结束外层进程时子进程可能还在跑：要停就按 制作文件/*.lock 里记的进程号结束
  const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, BOKE_ASR_CHILD: '1', ...sherpaLibEnv() } });
  if (r.error) { console.error(`没能启动处理进程（${r.error.message}）。再运行一次同一条命令；还不行就运行 ${cmd('tools/doctor.mjs')} 自检`); process.exit(1); }
  if (r.signal) { console.error(`处理进程被系统结束了（${r.signal}），常见原因是内存不够，或者被宿主的超时结束。关掉别的大程序，再运行一次同一条命令`); process.exit(128 + (os.constants.signals[r.signal] ?? 0)); }
  process.exit(r.status ?? 1);
}
export function loadSherpa() {
  const s = findSherpa();
  if (!s.ok) throw new Error(`没找到识别程序 sherpa-onnx-node。先运行 ${cmd('tools/setup.mjs')}。`);
  return createRequire(path.join(s.dir, 'x.js'))('sherpa-onnx-node');
}
export function asrModel() {
  const m = findModel();
  if (!m.ok) throw new Error(`没找到识别模型（SenseVoice）。先运行 ${cmd('tools/setup.mjs')}。`);
  return m;
}
export function needPodcastModels(keys = Object.keys(PODCAST_MODELS)) {
  const miss = keys.filter((k) => !pmReady(k));
  if (miss.length) throw new Error(`缺播客用的模型：${miss.map((k) => PODCAST_MODELS[k].what).join('、')}。运行 ${cmd('tools/setup.mjs')} 补上。`);
}
// 识别、分说话人用几个线程：留一个核给系统，最多 8。BOKE_THREADS 可以手动指定（测速时模拟慢电脑也用它）
export const threads = () => {
  const n = Number(process.env.BOKE_THREADS);
  if (n >= 1) return Math.floor(n);
  return Math.max(2, Math.min(8, (os.availableParallelism?.() ?? os.cpus().length) - 1));
};

// ---- 磁盘空间 ----
// 开工前先算要多少空间，不够就停下来说清楚，不要跑到一半才"磁盘满"
export const GB = (b) => `${(b / 1024 ** 3).toFixed(1)} GB`;
export function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}
// 盘名只有 Windows 能从路径看出来（D:\）；Mac、Linux 的路径开头都是 /，外接硬盘在 /Volumes/… 下面，说"节目目录所在的盘"（2026-11-22 审查 86）
export function needSpace(dir, bytes, what) {
  const free = freeBytes(dir);
  if (free == null || free >= bytes) return;
  const win = process.platform === 'win32';
  throw new Error(`磁盘空间不够：${what}大约要 ${GB(bytes)}，${win ? `${path.parse(path.resolve(dir)).root} ` : `节目目录（${path.resolve(dir)}）所在的盘`}只剩 ${GB(free)}。`
    + `先清出空间，或者把整个节目目录挪到空间大的盘（${win ? '比如 D 盘' : '比如外接硬盘'}）再继续；挪过去后照常运行同一条命令，已经做完的不会重做。`);
}
// 一段 PCM（16 位）多大
export const pcmBytes = (seconds, rate, ch) => Math.ceil(seconds * rate * ch * 2);

// ---- ffmpeg ----
let ffCache = null;
export function ffmpeg() {
  ffCache ??= findFfmpeg(loadConfig());
  if (!ffCache.ok) throw new Error(`没找到能用的 ffmpeg。先运行 ${cmd('tools/setup.mjs')}。`);
  return { ff: ffBin(ffCache, 'ffmpeg') };
}
// 跑 ffmpeg，失败抛错（带最后一段报错）；返回 stderr（loudnorm 之类的测量结果在里面）
export function ff(args, label) {
  const r = spawnSync(ffmpeg().ff, ['-hide_banner', '-y', ...args.map(String)], { encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true });
  if (r.status !== 0) throw new Error(`${label}失败：${(r.stderr || r.error?.message || '').slice(-1200)}`);
  return r.stderr;
}
// 音频的时长、声道数、采样率。不用 ffprobe（2026-11-20 起不再下载它，省一半下载量）：
// wav 直接读文件头；别的格式看 ffmpeg -i 打出来的信息（和 ffprobe 读的是同一份，mp3 没有时长信息时两者一样按码率估）；
// 连 ffmpeg 都说不出时长（Duration: N/A）的，整段解码一遍看最后的 time=。
// 结果按"文件 + 大小 + 修改时间"记在内存里：transcribe 对同一个录音要问好几次（报错、算空间、看声道），流式文件不用每次都整段解码；
// 只要声道数（monoLike）时传 { needDuration: false }，不为时长解码（2026-11-20 审查 F3）
const CH_LAYOUT = { mono: 1, stereo: 2, '2.1': 3, '3.0': 3, quad: 4, '4.0': 4, '5.0': 5, '5.1': 6, '6.1': 7, '7.1': 8 };
const probeCache = new Map();
export function probe(file, { needDuration = true } = {}) {
  let key = null;
  try { const st = fs.statSync(file); key = `${path.resolve(file)}|${st.size}|${st.mtimeMs}`; } catch {}
  const hit = key && probeCache.get(key);
  if (hit && (hit.full || !needDuration)) return hit.r;
  const save = (r, full) => { if (key) probeCache.set(key, { r, full }); return r; };
  // declared：wav 文件头写的时长比文件里实际有的长（文件被截断、没拷完），见 wavInfo
  if (/\.wav$/i.test(file)) { try { const w = wavInfo(file); return save({ duration: w.frames / w.rate, channels: w.ch, rate: w.rate, streams: [{ channels: w.ch, rate: w.rate }], declared: w.declaredFrames ? w.declaredFrames / w.rate : null }, true); } catch { /* 读不懂的 wav（压缩编码之类）交给 ffmpeg */ } }
  const r = spawnSync(ffmpeg().ff, ['-hide_banner', '-i', file], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20 });
  const o = r.stderr || '';
  let dur = hmsSec(o.match(/Duration:\s*([\d:.]+)/)?.[1] ?? '');
  // 一个文件里可能有好几条音频流（m4a 这类带了几条音轨的）：都数出来，transcribe 要问用哪条（以前只悄悄用第一条）
  const chOf = (lay) => { lay = lay.trim().replace(/\(.*\)$/, ''); return CH_LAYOUT[lay] ?? (Number(lay.match(/^(\d+) channels/)?.[1]) || NaN); };
  const streams = [...o.matchAll(/Stream #\d+:\d+.*?: Audio: [^\n]*?, (\d+) Hz, ([^,\n]+)/g)].map((m) => ({ rate: Number(m[1]), channels: chOf(m[2]) }));
  const a = streams[0];
  const channels = a ? a.channels : NaN;
  // 读不出音频（录音软件崩溃留下的半截 m4a 缺 moov、没传完的文件）：bad 记下 ffmpeg 的原话，transcribe、new 用它说清楚是哪个文件坏了
  const noAudio = /Audio:/.test(o) ? null : (o.match(/moov atom not found|Invalid data found[^\n]*|Invalid argument|could not find codec[^\n]*|does not contain any stream/i)?.[0] ?? '读不出音频');
  if (!dur && a && !needDuration) return save({ duration: 0, channels, rate: a.rate, streams, bad: noAudio }, false);
  if (!dur && a) dur = decodedDuration(file);
  return save({ duration: dur, channels, rate: a ? a.rate : NaN, streams, bad: noAudio ?? (a && !dur ? '解码出来是 0 秒' : null) }, true);
}
const hmsSec = (s) => { const m = s.match(/(\d+):(\d+):([\d.]+)/); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0; };
// 整段解码一遍，看实际能解出多长（文件头写的时长可能不对：文件被截断、没下载完；mp3 文件头里的时长是按码率估的，可能差好几秒）。
// 前后接着拼的录音要准确知道每个文件在拼起来以后从哪儿开始，也用它。k：第几条音频流（从 0 数）。解不出来返回 0（要个数的调用处自己退回 duration）
export function decodedDuration(file, k = 0) {
  if (/\.wav$/i.test(file)) { try { const w = wavInfo(file); return w.frames / w.rate; } catch {} }
  const d = spawnSync(ffmpeg().ff, ['-hide_banner', '-i', file, '-map', `0:a:${k}`, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20 });
  const t = [...(d.stderr || '').matchAll(/time=\s*([\d:.]+)/g)].at(-1);
  return t ? hmsSec(t[1]) : 0;
}
export const duration = (file) => probe(file).duration || 0;
// 录音文件坏了、不完整：ffmpeg 读不出音频，或者解码出来是 0 秒。返回 [{ f, why }]（找不到的文件别处说）
export const badRecordings = (recs) => recs.filter((f) => fs.existsSync(f)).map((f) => { const p = probe(f); return p.bad ? { f, why: p.bad } : null; }).filter(Boolean);
export const badRecMsg = (e, bad) => `录音${bad.map((x) => `「${recName(e, x.f)}」`).join('、')}读不出来：文件不完整或者坏了（多半是录音软件没正常结束、崩溃了，或者文件没传完、没下载完。ffmpeg 说：${bad[0].why}）。`
  + `用录音软件修复或重新导出一份（m4a 缺 moov 的，可以试 untrunc 这类修复工具），换掉它再转写；这个文件不要了：${externalRecs(e).some((x) => x.name === recName(e, bad[0].f)) ? `运行 ${cmd('new.mjs', e.work, '--forget', recName(e, bad[0].f))} 去掉登记` : '把它挪出节目目录'}`;
export const transcribeErrFile = (e) => path.join(e.mid, '转写出错.json');
// wav 文件头：声道数、采样率、数据从第几个字节开始、一共多少帧。
// 只认每帧字节数固定的编码：PCM(1)、浮点(3)、A-law(6)、μ-law(7)，以及 WAVE_FORMAT_EXTENSIBLE(0xFFFE) 里子格式是 PCM/浮点的；
// ADPCM 这类压缩编码的 blockAlign 是"一个压缩块多大"，按它算帧数会差几百倍，抛错交给 ffmpeg（probe 会接住）。
// 帧数按 data 块自己写的大小算（后面还跟着 LIST、XMP 之类的块时不算进去）；大小写的是 0 或 0xFFFFFFFF（管道写出的、RF64）才按文件剩下的长度算
const WAV_FIXED = new Set([1, 3, 6, 7]);
export function wavInfo(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const h = Buffer.alloc(4096); fs.readSync(fd, h, 0, 4096, 0);
    if (!/^(RIFF|RF64)$/.test(h.toString('ascii', 0, 4)) || h.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`读不懂这个 wav：${file}`);
    let p = 12, ch = 2, rate = RATE, align = 0, fmt = null;
    while (p + 8 <= h.length) {
      const id = h.toString('ascii', p, p + 4), size = h.readUInt32LE(p + 4);
      if (id === 'fmt ') {
        fmt = h.readUInt16LE(p + 8); ch = h.readUInt16LE(p + 10); rate = h.readUInt32LE(p + 12); align = h.readUInt16LE(p + 20);
        if (fmt === 0xfffe && size >= 40 && p + 34 <= h.length) fmt = h.readUInt16LE(p + 32); // 扩展格式：子格式 GUID 的前两个字节
      }
      if (id === 'data') {
        if (fmt == null || !WAV_FIXED.has(fmt)) throw new Error(`这个 wav 是压缩编码（格式 ${fmt}），文件头算不出时长：${file}`);
        const dataOff = p + 8, rest = fs.fstatSync(fd).size - dataOff;
        const bytes = size === 0 || size === 0xffffffff ? rest : Math.min(size, rest);
        // 文件头写的比实际有的多（截掉了后半截、没拷完）：照实际的算，另外记下文件头写的帧数，transcribe 据此提醒
        const declaredFrames = size !== 0 && size !== 0xffffffff && size > rest ? Math.floor(size / (align || 2 * ch)) : null;
        return { ch, rate, dataOff, frames: Math.floor(bytes / (align || 2 * ch)), declaredFrames };
      }
      p += 8 + size + (size & 1);
    }
    throw new Error(`读不懂这个 wav：${file}`);
  } finally { fs.closeSync(fd); }
}
// 每个声道的平均音量（astats 的 RMS，dB；完全没声音是 -Infinity）。pan 给了就先按它重新组合声道再量。t：只看前多少秒（null 看整条）
export function channelLevels(file, opts = {}) {
  return channelStats(file, opts).map((c) => c.rms);
}
// 同上，另带每个声道的峰值（最响的一下，dB）
// k：量第几条音频流（从 0 数；和转换时用的是同一条，不让 ffmpeg 自己挑）
function channelStats(file, { t = 300, pan = null, k = 0 } = {}) {
  const o = ff(['-nostats', ...(t == null ? [] : ['-t', t]), '-i', file, '-map', `0:a:${k}`, '-af', `${pan ? `${pan},` : ''}astats`, '-f', 'null', '-'], '看声道');
  const num = (s) => (/inf/.test(s) ? -Infinity : Number(s));
  return [...o.matchAll(/Channel:\s*\d+[\s\S]*?Peak level dB:\s*(-?[\d.]+|-?inf)[\s\S]*?RMS level dB:\s*(-?[\d.]+|-?inf)/g)].map((m) => ({ peak: num(m[1]), rms: num(m[2]) }));
}
// 源录音的声道（只看前 5 分钟，解码一遍，几秒钟）：
//   mono：本来就一个声道；或者左右几乎一样（左右相减比相加低 30 dB 以上）；或者只有一边有声音。是的话整条流程按单声道处理，
//         磁盘和音频处理的活都少一半；成品配上音乐时再变成立体声。
//   only：只有一边有声音时是哪边（0 左、1 右）：另一边完全没声音，或者比它低 30 dB 以上（话筒插在声卡输入 1、录成了立体声）。
//         这时只取有声音的那边，不和没声音的那边平均（平均会小 6 dB，还会混进那边的底噪）；以前当成立体声，成品人声只在一只耳朵里（2026-11-22 审查 73）
//         前 5 分钟看着只有一边有声音时，再把整条量一遍确认：另一边过了 5 分钟才开口（嘉宾那路话筒晚开）的，整条量下来差不到 30 dB，
//         照立体声留着，不然那边说的话会整段丢掉。整条量还看那边"有声音的时长"：每 0.2 秒量一次音量，
//         和有声音那边同一时刻、整条平均都差不到 30 dB 的合计满 1 秒，就是真说了话（只在很后面说了一两句、整条平均下来很小的也算），照样留着。
//         以前看的是最响的一下，没接话筒那边插拔线"啪"的一下就会被当成有声音、整条当立体声，成品人声只在一只耳朵里
//         （2026-11-23 合并后修）；一两下咔哒声合计只有零点几秒，不算。整条量只在这种少见的情况才做（1 小时的录音多十几秒）
// k：看第几条音频流（一个文件里有几条音轨、节目信息写了"音轨选择"时）
export function channelInfo(file, k = 0) {
  const p = probe(file, { needDuration: false });
  const ch = p.streams?.[k]?.channels ?? p.channels;
  if (ch === 1) return { mono: true, only: null };
  if (ch !== 2) return { mono: false, only: null };
  const pan = 'pan=4.0|c0=c0|c1=c1|c2=0.5*c0-0.5*c1|c3=0.5*c0+0.5*c1';
  const gone = (a, b) => (a > -Infinity ? b - a >= 30 : b > -Infinity);
  const [l, r, side, mid] = channelStats(file, { pan, k });
  let dead = (a, b) => gone(a.rms, b.rms); // a 这边几乎没声音、b 那边有
  if (dead(r, l) || dead(l, r)) {
    const w = channelWindows(file, k);
    const all = w.map(powerAvg); // 整条的平均音量
    // 这边"真有声音"的合计秒数：和那边同一时刻比差不到 30 dB（串音、漏进来的声音总是比那边同时说的小 30 dB 以上，不算），
    // 而且和那边整条的平均也差不到 30 dB（那边停顿时，这边的底噪不算）
    const voiced = (i) => w[i].filter((x, t) => x >= (w[1 - i][t] ?? -Infinity) - 30 && x >= all[1 - i] - 30).length * WIN;
    dead = (a, b) => { const i = a === l ? 0 : 1; return gone(all[i], all[1 - i]) && voiced(i) < 1; };
  }
  if (dead(r, l)) return { mono: true, only: 0 };
  if (dead(l, r)) return { mono: true, only: 1 };
  return { mono: !(side.rms > -Infinity) || mid.rms - side.rms >= 30, only: null };
}
// 整条每 WIN 秒量一次左右声道的平均音量（dB；完全没声音是 -Infinity）。先转成 16 kHz：只看音量，快一些
const WIN = 0.2;
function channelWindows(file, k = 0) {
  const n = Math.round(16000 * WIN);
  const o = ff(['-nostats', '-i', file, '-map', `0:a:${k}`, '-af', `aresample=16000,asetnsamples=n=${n}:p=0,astats=metadata=1:reset=1,`
    + 'ametadata=mode=print:key=lavfi.astats.1.RMS_level,ametadata=mode=print:key=lavfi.astats.2.RMS_level', '-f', 'null', '-'], '看声道');
  const num = (s) => (/inf/.test(s) ? -Infinity : Number(s));
  return [1, 2].map((c) => [...o.matchAll(new RegExp(`lavfi\\.astats\\.${c}\\.RMS_level=(-?[\\d.]+|-?inf)`, 'g'))].map((m) => num(m[1])));
}
const powerAvg = (dbs) => { let s = 0; for (const x of dbs) s += x > -Infinity ? 10 ** (x / 10) : 0; return dbs.length && s > 0 ? 10 * Math.log10(s / dbs.length) : -Infinity; };
export const monoLike = (file, k = 0) => channelInfo(file, k).mono;
// 整体响度 / 真峰值 / 响度范围（ebur128）
export function measure(file, { ss, t } = {}) {
  const pre = ss != null ? ['-ss', ss, '-t', t] : [];
  const o = ff(['-nostats', ...pre, '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], '响度测量');
  const last = (re) => { const m = [...o.matchAll(re)]; return m.length ? Number(m.at(-1)[1]) : null; };
  return { lufs: last(/I:\s+(-?[\d.]+) LUFS/g), lra: last(/LRA:\s+([\d.]+) LU/g), peak: last(/Peak:\s+(-?[\d.]+|-inf) dBFS/g) };
}

// ---- 提示 AI 的命令 ----
// cmd()（能直接复制运行的完整命令，引号和开头的 node 怎么写）在 env.mjs，setup、get-model 这些不引这个文件的脚本也用它

// ---- 环境自检 ----
// doctor.mjs 用全量（真的加载一次识别程序，记下找到的 ffmpeg 位置）；start.mjs 用 quick：只看东西在不在、ffmpeg 能不能跑，
// 不加载识别程序、不写配置、不下载，一两秒。save: false 时全量也不写配置（setup --check 调 doctor --no-save）。
// 返回 [{ name, status: 通过/未通过/提示, detail, fix }]
export async function envChecks({ quick = false, save = !quick } = {}) {
  const rows = [];
  const add = (name, status, detail, fix) => rows.push({ name, status, detail, fix });
  const cfg = loadConfig();
  const SETUP = `运行：${cmd('tools/setup.mjs')}`;
  // 1. Node
  const major = Number(process.versions.node.split('.')[0]);
  add('Node', major >= 18 ? '通过' : '未通过', `v${process.versions.node}（${platformName()}）`, major >= 18 ? null : '请安装 Node 18 或更新的版本：https://nodejs.org');
  // 2. ffmpeg（每个候选都真的跑一次；不再要 ffprobe，时长、声道数都用 ffmpeg 自己看）
  const f = findFfmpeg(cfg);
  if (f.ok) {
    add('ffmpeg', '通过', `${f.version}，来自${f.from}`);
    // 找到的位置记下来，下次不用再挨个试
    if (save && f.dir && cfg.ffmpegDir !== f.dir && !process.env.FFMPEG_DIR && !f.dir.startsWith(ROOT)) saveConfig({ ffmpegDir: f.dir });
  } else add('ffmpeg', '未通过', f.tried.length ? f.tried.join('；') : '哪里都没找到', `${SETUP}（会下载一份放进技能目录）`);
  // 3. 识别程序和模型
  const sh = findSherpa(cfg);
  const shLoads = sh.ok && (quick || sherpaLoads(sh));
  let shVer = '';
  try { shVer = JSON.parse(fs.readFileSync(path.join(sh.pkg, 'package.json'), 'utf8')).version; } catch {}
  // 用的不是技能目录里装的那份（环境变量 SHERPA_ONNX_DIR 或本机配置 sherpaDir 指过去的）：setup 在技能目录里重装也没用
  const shElse = sh.ok && path.resolve(sh.dir) !== path.resolve(ROOT);
  add('识别程序', shLoads ? '通过' : '未通过', shLoads ? `sherpa-onnx-node ${shVer}${quick ? '（文件在；没有试加载，完整自检用 doctor）' : ''}` : (sh.ok ? `文件在${shElse ? ` ${sh.dir}` : ''}，但加载不起来` : '没装'),
    shLoads ? null : shElse ? `这份是环境变量 SHERPA_ONNX_DIR（或本机配置的 sherpaDir）指过去的，不是技能目录里装的：删掉那个设置改用技能目录里的（没装的话再运行 setup），或者改成一份能用的`
      : !sh.ok ? SETUP
      // setup 已经删了重装过、还是加载不起来（它记了 .state/sherpa-reinstalled.json）：再运行 setup 它也不会重装，直接说原因
      : sherpaGaveUp() ? `setup 已经重装过，还是加载不起来：不是网络问题，${process.platform === 'win32' ? `多半是缺微软的 VC++ 运行库（https://aka.ms/vs/17/release/vc_redist.${process.arch === 'arm64' ? 'arm64' : 'x64'}.exe），也可能是杀毒软件隔离了 dll` : process.platform === 'darwin' ? '多半是系统拦了下载来的动态库（系统设置 → 隐私与安全性里放行，或 xattr -dr com.apple.quarantine 技能目录/node_modules）' : '多半是系统太旧或缺系统库'}。处理好再${SETUP}。确实想再重装：删掉 node_modules/sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch} 再运行 setup`
      : `${SETUP}（会删掉平台包、换着来源重装一次，要联网；装好了还加载不起来，它会说原因）`);
  const md = findModel(cfg);
  add('识别模型', md.ok ? '通过' : '未通过', md.ok ? `SenseVoice，在 ${md.dir}` : '没下载', md.ok ? null : SETUP);
  // 4. 播客精编用的模型和配乐
  const pmMiss = Object.keys(PODCAST_MODELS).filter((k) => !pmReady(k));
  add('播客模型', pmMiss.length ? '未通过' : '通过', pmMiss.length ? `缺：${pmMiss.map((k) => PODCAST_MODELS[k].what).join('、')}` : '人声检测、说话人切分、声纹', pmMiss.length ? SETUP : null);
  add('配乐', fs.existsSync(MUSIC) ? '通过' : '提示', fs.existsSync(MUSIC) ? 'Aurora（CC0）' : '技能包里的配乐文件不在，精编版会没有片头片尾音乐', fs.existsSync(MUSIC) ? null : '重新解压技能包');
  // 配乐曲库：缺了只算提示（用到时会自动下载，下不下来用 Aurora）；曲库文件读不出来才算没过
  try {
    const { loadLibrary, trackReady } = await import('./library.mjs');
    const lib = loadLibrary().filter((t) => t.url), miss = lib.filter((t) => !trackReady(t));
    if (lib.length) add('配乐曲库', miss.length ? '提示' : '通过', miss.length ? `${lib.length} 首里还差 ${miss.length} 首没下载（剪辑用到时会自动下载，不用管）` : `${lib.length} 首都在`, miss.length ? `想提前全部下好：${cmd('tools/setup.mjs', '--music')}` : null);
  } catch (err) { add('配乐曲库', '未通过', err.message, '重新解压技能包'); }
  // 5. 下到一半的文件（setup 中途断了留下的 .part）：只是提示，再跑 setup 会接着下
  const { partialDownloads, mb } = await import('./download.mjs');
  const parts = partialDownloads(['sense-voice', 'podcast', 'music', '.download'].map((d) => path.join(ROOT, 'models', d)).concat(path.join(ROOT, '.state', 'ffmpeg', 'bin')));
  if (parts.length) add('没下完的', '提示', `${parts.length} 个文件下到一半（共 ${mb(parts.reduce((s, p) => s + p.bytes, 0))}）`, `${SETUP}（会接着下，不从头来）`);
  // 6. 旧版本（v0.3 及以前）留下的东西：解压新版覆盖旧版时会留下，只有 setup 会清
  const { oldLeftovers } = await import('./leftovers.mjs');
  const old = oldLeftovers({ sizes: !quick });
  if (old.length) {
    const names = old.slice(0, 3).map((x) => path.relative(ROOT, x.p)).join('、') + (old.length > 3 ? ` 等 ${old.length} 项` : '');
    add('旧版残留', '提示', `旧版本留下的 ${names}${quick ? '' : `，共 ${mb(old.reduce((s, x) => s + x.bytes, 0))}`}`, `${SETUP}（会先列出清单再删，不下载已有的东西；自己改过旧版模板的先另存）`);
    rows.at(-1).act = true; // start.mjs 全部通过时也把办法打出来
  }
  return rows;
}

// ---- 节目目录 ----
// 收的录音格式。AIFF、CAF 是 Mac 上 GarageBand、Logic、语音备忘录常用的无损格式，ffmpeg 都能解（2026-11-22 审查 81）
export const AUDIO = /\.(m4a|m4b|mp3|aac|flac|ogg|oga|opus|wma|amr|wav|aif|aiff|aifc|caf)$/i;
export const AUDIO_EXTS = 'mp3、m4a、wav、flac、aac、ogg、opus、wma、amr、aiff、caf';
// 视频和不收的音频格式：不当录音，但放进来了要说清楚"格式不认、怎么办"，不能说成"没有录音文件"
export const VIDEO = /\.(mp4|mov|m4v|mkv|avi|webm|flv|wmv|3gp|mts|m2ts)$/i;
const OTHER_AUDIO = /\.(ape|wv|dsf|dff|mp2|ac3|dts|ra|au|snd|tta|mpc|weba|spx|mka)$/i;
// 先把视频里的声音提取出来的命令（用技能找到的 ffmpeg）。音轨是 AAC 的直接拷出来（不重新编码），不行就转成 wav
export function extractCmd(file) {
  let ffp = 'ffmpeg'; try { ffp = ffmpeg().ff; } catch {}
  const q = (s) => `"${s}"`, src = path.resolve(file), stem = path.join(path.dirname(src), path.parse(src).name);
  return `${q(ffp)} -i ${q(src)} -vn -c:a copy ${q(`${stem}.m4a`)}（报错的话改用 ${q(ffp)} -i ${q(src)} -vn ${q(`${stem}.wav`)}）`;
}
// 节目目录第一层放着、但格式不认的媒体文件（视频、不收的音频格式）
export const unknownMedia = (e) => { try { return fs.readdirSync(e.work).filter((n) => !n.startsWith('.') && (VIDEO.test(n) || OTHER_AUDIO.test(n))); } catch { return []; } };
export function unknownMediaMsg(e, names) {
  const video = names.find((n) => VIDEO.test(n));
  return `节目目录里有${names.map((n) => `「${n}」`).join('、')}，${video ? '是视频或格式不认的文件' : '格式不认'}，没当成录音（能用的录音格式：${AUDIO_EXTS}）。`
    + `${video ? `视频先把声音提取出来：${extractCmd(path.join(e.work, video))}` : '先用别的软件转成 wav 或 mp3'}，再用 ${cmd('new.mjs', e.work, '<转好的文件>')} 放进来`;
}
export function episode(dir) {
  const work = path.resolve(dir);
  const mid = path.join(work, '制作文件');
  const j = (...p) => path.join(work, ...p);
  return {
    work, mid,
    info: j('节目信息.md'), names: j('说话人.md'), rollcall: j('声音点名.mp3'),
    full: j('全文.json'), fullTxt: j('全文.txt'), outline: j('全文提纲.md'), plan: j('编排方案.json'), planMd: j('编排方案.md'), draft: j('编排方案.草稿.json'), draftOld: j('编排方案.草稿.旧.json'),
    // plan.mjs 记的每段开头结尾原文 + 检查通过时方案和全文的指纹。放在节目目录第一层，不放 制作文件/：那里的东西被当成"删了会重建"
    anchors: j('方案原文.json'), anchorsOld: path.join(mid, '方案原文.json') /* 2026-11-20 之前的位置，读一次就挪 */,
    compare: j('处理前后对比'), out: j('精编版'), state: j('状态.json'),
    wav44: path.join(mid, '原始_44k.wav'), wav44dn: path.join(mid, '原始_44k_降噪.wav') /* 旧版留下的，现在只在剪的时候给用到的片段降噪，看到就删 */, wav16: path.join(mid, '16k.wav'),
    asr: path.join(mid, '识别.json'), diar: path.join(mid, '说话人分段.json'), levels: path.join(mid, '段响度.json'),
  };
}
export function mustExist(dir) {
  if (!fs.existsSync(dir)) { console.error(`没有这个目录：${dir}。新节目先运行 ${cmd('new.mjs', path.resolve(dir), '<录音文件>')}（"<录音文件>"换成录音的完整路径）。已经开工的节目目录挪了地方的话，命令里的目录换成新位置再跑`); process.exit(1); }
}
// ---- 读写节目里的文件 ----
// 给人看的错误：哪里都没接住时只打这句中文，不打 Node 的英文堆栈（下面 uncaughtException）
export const userError = (msg) => Object.assign(new Error(msg), { boke: true });
process.on('uncaughtException', (err) => { console.error(err?.boke ? err.message : err); process.exit(1); });
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);
// 文件属于哪一期：制作文件/、精编版/ 里的往上一层
const workOf = (f) => (['制作文件', '精编版'].includes(path.basename(path.dirname(f))) ? path.dirname(path.dirname(f)) : path.dirname(f));
const shortName = (f) => path.relative(workOf(f), f) || path.basename(f);
// 只读、被占用时怎么办（Windows：文件属性里的"只读"；Mac/Linux：没有写的权限）
export const roFix = (work) => (process.platform === 'win32'
  ? `关掉占着它的程序（播放器、编辑器、同步盘）；是只读的话，在文件属性里去掉"只读"，或者整期一起改：attrib -R /S /D "${work}\\*"`
  : `关掉占着它的程序；没有写的权限的话：chmod -R u+w "${work}"`);
// 写坏了的 json 怎么重新生成
const JSON_REDO = { '识别.json': 'transcribe.mjs', '录音.json': 'transcribe.mjs', '段响度.json': 'transcribe.mjs', '全文.json': 'transcribe.mjs', '剪辑表.json': 'finish.mjs', '检查报告.json': 'finish.mjs', '状态.json': 'status.mjs' };
// 读 json：{ value } 读到了；{ missing } 没有这个文件；{ bad } 读不了（坏了 / 被占着 / 没权限），bad 是给人看的一句话
export function readJsonResult(f) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { missing: true };
    return { bad: BUSY.has(err.code) ? `读不了 ${shortName(f)}：正被别的程序占着，或者没有读它的权限。关掉占着它的程序（编辑器、同步盘）；没有权限的话，`
      + (process.platform === 'win32' ? '在文件属性的"安全"页给自己加上"读取"和"写入"' : `运行 chmod -R u+rw "${workOf(f)}"`) + '，再运行一次同一条命令' : `读不了 ${shortName(f)}（${err.message}）`, busy: BUSY.has(err.code) };
  }
  try { return { value: JSON.parse(text.replace(/^﻿/, '')) }; } catch {
    const redo = JSON_REDO[path.basename(f)];
    return { bad: `${shortName(f)} 坏了（多半是上次写到一半被打断，或者被别的程序改过），读不出来。`
      + (redo === 'status.mjs' ? `运行 ${cmd('status.mjs', workOf(f))} 看怎么办` : redo ? `运行 ${cmd(redo, workOf(f))} 重新生成` : '打开看看改好；实在不行把它改个名字挪开，再运行一次'), damaged: true };
  }
}
// 没有这个文件返回 def。坏了、读不了的不再当成"没有"（以前会悄悄从头来过、把确认记录清掉），抛出说清楚的错（2026-11-22 审查 77）
export const readJson = (f, def) => { const r = readJsonResult(f); if (r.bad) throw userError(r.bad); return r.missing ? def : r.value; };
// 缓存、用时记录、锁这类坏了也无所谓的：坏了、读不了都当成没有
export const readJsonLoose = (f, def) => { const r = readJsonResult(f); return r.missing || r.bad ? def : r.value; };
// 写到 .tmp 再改名：写到一半被打断不会留下半截文件。只读、被占着的说清楚怎么办，不打英文堆栈（2026-11-22 审查 77、80）
export function writeText(f, text) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    // 杀毒软件、同步盘偶尔短暂占着刚写的文件：等一下再试两次
    for (let k = 0; ; k++) { try { fs.renameSync(tmp, f); break; } catch (err) { if (k >= 2 || !BUSY.has(err.code)) throw err; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); } }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw BUSY.has(err.code) ? userError(`写不进 ${shortName(f)}：它是只读的，或者正被别的程序占着。${roFix(workOf(f))}，再运行一次同一条命令`) : err;
  }
}
export const writeJson = (f, v, indent = 1) => writeText(f, JSON.stringify(v, null, indent) + '\n');
// 要覆盖、删掉的几个文件里，哪些现在换不了：只读的、被播放器占着（不让写或者不让删）的。返回文件名。
// 出成品前先查一遍，查出来就停，旧文件一个都不动；不然删了一半、写了一半，留下新旧混着的半套成品（2026-11-22 审查 78、80）
export function stuckFiles(dir, names) {
  return names.filter((n) => {
    const p = path.join(dir, n);
    if (!fs.existsSync(p)) return false;
    try {
      fs.closeSync(fs.openSync(p, 'r+')); // 只读、别人开着不让写
      fs.renameSync(p, `${p}.chk`); fs.renameSync(`${p}.chk`, p); // 别人开着不让删、不让改名
      return false;
    } catch { if (!fs.existsSync(p) && fs.existsSync(`${p}.chk`)) try { fs.renameSync(`${p}.chk`, p); } catch {} return true; }
  });
}
export const stuckMsg = (work, where, names) => `${names.map((n) => `${where}${n}`).join('、')} 换不了：正被别的程序（多半是播放器）打开着，或者是只读的。这次什么都没动，旧文件都还在。${roFix(work)}，再运行同一条命令`;
export const sha = (data) => crypto.createHash('sha1').update(data).digest('hex').slice(0, 12);
// 文件被播放器独占打开时读不了：说清楚，不打英文堆栈（2026-11-22 审查 77）
export const fileSha = (f) => {
  try { return sha(fs.readFileSync(f)); } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (BUSY.has(err.code)) throw userError(`读不了 ${shortName(f)}：它正被别的程序（多半是播放器）占着。关掉播放器，再运行一次同一条命令`);
    throw err;
  }
};

// 编排方案的指纹。只算"会改变成品"的部分：写简介（intro）、标题、说明文字、记下人声处理的选择，不让已确认的编排失效，也不用重剪
//   edit：主理人确认"编排"时看的——板块、句子范围、删减清单、配乐
//   audio：决定精编版声音的——板块、句子范围、配乐、人声处理
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
export function planSha(plan, kind = 'edit') {
  if (!plan) return null;
  // 小话题名（label）只出现在简介时间轴和 编排方案.md 里，不影响声音：算进 edit，不算进 audio
  const keys = kind === 'audio' ? ['from', 'to', 'startText', 'endText'] : ['from', 'to', 'startText', 'endText', 'label'];
  const secs = (plan.sections ?? []).map((s) => ({ ...pick(s, ['name', 'kind']), parts: (s.parts ?? []).map((p) => pick(p, keys)) }));
  const body = kind === 'audio' ? { secs, music: plan.music ?? null, voice: plan.voice ?? null } : { secs, cuts: plan.cuts ?? [], music: plan.music ?? null };
  return sha(JSON.stringify(body));
}

// 全文"句子编号"的指纹：只看每句的编号和起止时间。重新识别（编号可能变）会变；填称呼、换常错词（只改字）不变
export const fullSha = (full) => (Array.isArray(full) ? sha(JSON.stringify(full.map((s) => [s.id, +(+s.start).toFixed(2), +(+s.end).toFixed(2)]))) : null);

// plan.mjs 记的东西（方案原文.json）：{ full, file, audio, parts: [{ i, j, sec, label, from, to, text }] }
//   full：检查时全文的编号指纹；file：检查通过时 编排方案.json 的指纹；audio：planSha(plan, 'audio')
// 旧版（2026-11-20 之前）记在 制作文件/ 里、只有 parts: { "起-止": 原文 }，照样读（legacy: true）
export function loadAnchors(e) {
  const a = readJson(e.anchors, null) ?? readJson(e.anchorsOld, null);
  if (!a || typeof a !== 'object') return null;
  return Array.isArray(a.parts) ? a : { legacy: true, parts: a.parts && typeof a.parts === 'object' ? a.parts : {} };
}

// 编排方案检查过没有：按 plan.mjs 检查通过时记下的指纹比，不看文件修改时间（Copy-Item 会带着旧时间）。
// 返回 null 是检查过了；否则返回一句原因。
//   strict：方案文件要和检查时一字不差（给主理人看 编排方案.md、确认编排时用）；
//   不 strict：只要决定声音的部分（板块、句子范围、配乐、人声处理）没变就行（build 用：写简介、改标题不用重新检查）
// 全文在检查之后重新识别过（编号指纹变了），两种都不算检查过。
// 旧版没记指纹的（没有 方案原文.json，或者只有旧位置的旧写法）：不再看修改时间（拷贝会带着旧时间，plan 没过也不改文件，
// 方案错了照样被当成"检查过"——VOL01 实测 cuts 写着删的句子剪进了成品），一律要用现在的 plan.mjs 检查一次（v0.7 审查 18）
export function planCheck(e, plan, { strict = true } = {}) {
  const NOT = '编排方案.json 改过之后还没检查';
  const a = loadAnchors(e);
  if (a?.file) {
    const fp = fullSha(readJson(e.full, null));
    if (a.full && fp && a.full !== fp) return '全文在上次检查编排方案之后重新识别过，句子编号可能变了，要重新检查';
    if (strict && !fs.existsSync(e.planMd)) return '还没有 编排方案.md';
    if (a.file === fileSha(e.plan)) return null;
    if (!strict && a.audio && a.audio === planSha(plan, 'audio')) return null;
    return NOT;
  }
  return '这期的编排方案还没用现在的 plan.mjs 检查过（旧版做的，或者检查记录 方案原文.json 不在了）';
}

// 机器草稿留下的"待改"占位：标题、标题备选、一句话主题、板块名、小话题。plan、status 用同一个
export function planTodos(plan) {
  if (!plan) return 0;
  const secs = Array.isArray(plan.sections) ? plan.sections : [];
  return [plan.title, plan.theme, ...(Array.isArray(plan.titleOptions) ? plan.titleOptions : []), ...secs.flatMap((s) => [s?.name, ...(Array.isArray(s?.parts) ? s.parts.map((p) => p?.label) : [])])]
    .filter((x) => typeof x === 'string' && x.includes('待改')).length;
}
export const TODO_WHERE = '标题、标题备选、一句话主题、板块名、小话题';
// mp3 标签里的标题（build 写、notes 换）：没定标题、还写着"待改"的，写"精编版"，不把占位写进成品
export const mp3Title = (plan) => (typeof plan?.title === 'string' && plan.title.trim() && !plan.title.includes('待改') ? plan.title : '精编版');

// 读 编排方案.json：{ plan }；没有这个文件 { missing: true }；写坏了 { bad: "第几行附近、原因" }。
// AI 手写 JSON 常见的错（中文引号、多一个逗号、字符串里直接换行）要说清楚在哪，不能当成"还没有方案"。
// 开头的 BOM（PowerShell 写文件常带）去掉再读
const JSON_WHY = [
  [/after property value|after array element/, '上一项后面少了逗号，或者括号没配对'],
  [/Expected double-quoted property name/, '最后一项后面多了逗号，或者名字没用英文双引号'],
  [/Expected property name/, '名字要用英文双引号括起来'],
  [/Bad control character|Bad escaped character/, '引号里直接换了行或用了反斜杠（换行写成 \\n，或者拆成数组的几项）'],
  [/Unterminated string/, '有个字符串少了结尾的英文双引号'],
  [/Unexpected end/, '文件没写完，结尾少了括号'],
  [/after JSON/, '方案结束以后还多了东西（多了个括号？）'],
  [/Unexpected token '[“”‘’「」]'/, '用了中文引号，要换成英文双引号 "'],
  [/Unexpected token '[\]}]'/, '最后一项后面多了逗号（看上一行末尾），或者括号没配对'],
  [/Unexpected token '''/, '用了单引号，要换成英文双引号 "'],
];
// 新版 Node 对"Unexpected token"不给位置。自己从头扫一遍，找第一个不合 JSON 写法的字符在哪（找不到返回 -1）
function jsonErrorAt(text) {
  let i = 0;
  const fail = () => { throw i; };
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const str = () => {
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') { i++; return; }
      if (c === '\\') { if (!/["\\/bfnrtu]/.test(text[i + 1] ?? '')) { i++; fail(); } i += 2; continue; }
      if (c < ' ') fail();
      i++;
    }
    fail();
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++; ws(); if (text[i] === '}') { i++; return; }
      for (;;) { ws(); if (text[i] !== '"') fail(); str(); ws(); if (text[i] !== ':') fail(); i++; value(); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === '}') { i++; return; } fail(); }
    }
    if (c === '[') {
      i++; ws(); if (text[i] === ']') { i++; return; }
      for (;;) { value(); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === ']') { i++; return; } fail(); }
    }
    if (c === '"') return str();
    const m = /^(-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400));
    if (m) { i += m[0].length; return; }
    fail();
  };
  try { value(); ws(); if (i < text.length) fail(); return -1; } catch (p) { if (typeof p === 'number') return p; throw p; }
}
export function jsonWhere(text, err) {
  const msg = (err.message ?? String(err)).replace(/\s+/g, ' ');
  let line = Number(msg.match(/\(line (\d+) column \d+\)/)?.[1]);
  if (!line) {
    // 旧版 Node 只给 position；新版 Node 的"Unexpected token"什么位置都不给，自己扫出来。都没有就说位置不明，不瞎猜
    const pos = Number(msg.match(/position (\d+)/)?.[1] ?? NaN);
    const at = Number.isFinite(pos) ? pos : /Unexpected end/.test(msg) ? text.length : jsonErrorAt(text);
    line = at >= 0 ? text.slice(0, at).split('\n').length : 0;
  }
  const why = JSON_WHY.find(([re]) => re.test(msg))?.[1] ?? `写法不对（${msg.slice(0, 60)}）`;
  const rows = text.split('\n'), short = (s) => (s.length > 50 ? `${s.slice(0, 50)}……` : s);
  const src = line ? (rows[line - 1] ?? '').trim() : '';
  // 少逗号、多逗号时，解析器停在下一项（或括号）开头；真正的问题在上一行末尾，两行都给出来
  let prev = '';
  if (line > 1 && /after property value|after array element|double-quoted property name|Unexpected token '[\]}]'/.test(msg)) { for (let k = line - 2; k >= 0 && !prev; k--) prev = rows[k].trim(); }
  return `${line ? `第 ${line} 行附近` : '位置不明'}：${why}${prev ? `。上一行是：${short(prev)}` : ''}${src ? `${prev ? '；' : '。'}这一行是：${short(src)}` : ''}`;
}
// 编排方案.json 的编码：UTF-8（带不带 BOM 都行）；PowerShell 5.1 的 > / Out-File 存出来的 UTF-16 也认。
// 别的编码（Set-Content 默认的 ANSI/GBK）解出来是乱码，不往下解析，直接说清楚
const SAVE_UTF8 = 'PowerShell 里用 [IO.File]::WriteAllText(路径, 内容) 或 Set-Content -Encoding utf8，别用 > 和 Out-File';
export function readPlanText(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString('utf16le') };
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1))); b.swap16(); return { text: b.toString('utf16le') }; }
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '') }; } catch {
    return { bad: `文件不是 UTF-8 编码（多半是存成了 ANSI/GBK，中文会变乱码）。重新存成 UTF-8：${SAVE_UTF8}` };
  }
}
export function loadPlan(e, file = e.plan) {
  if (!fs.existsSync(file)) return { plan: null, missing: true };
  const { text, bad } = readPlanText(file);
  if (bad) return { plan: null, bad };
  try {
    const plan = JSON.parse(text);
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { plan: null, bad: '最外层要是一个 { } 对象' };
    return { plan };
  } catch (err) { return { plan: null, bad: jsonWhere(text, err) }; }
}
export const planBadMsg = (bad) => `编排方案.json 格式写错了（${bad}）`;
// 简介正文（intro）：一段一个字符串的数组。写成一个字符串也照用（空行分段）：只写 intro 不用重跑 plan，
// plan 的格式检查碰不到，notes 以前在这里打英文堆栈、finish 第 3 步崩（2026-11-24 第 3 轮 8）。
// 返回 { paras }；数字、对象之类认不出的返回 { bad: 一句话 }
export function introOf(plan) {
  const v = plan?.intro;
  if (v == null || v === '') return { paras: [] };
  if (typeof v === 'string') return { paras: v.split(/\r?\n\s*\r?\n/).map((x) => x.trim()).filter(Boolean) };
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return { paras: v.filter((x) => x.trim()) };
  return { bad: 'intro（简介正文）要写成字符串数组，一段一项：["第一段", "第二段"]' };
}
// plan / build / check / notes 共用：写坏了就报出来退出；没有方案返回 null，各自说该怎么办
export function planOrExit(e) {
  const r = loadPlan(e);
  if (r.bad) { console.error(`${planBadMsg(r.bad)}。改好再运行；不用重读全文`); process.exit(1); }
  return r.plan;
}

// 每一步用了多久、节目目录占多少硬盘：记在 制作文件/用时.json，status 打出来。以后用户说慢，有数可查
export function dirBytes(dir) {
  let n = 0;
  const walk = (d) => { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, x.name); if (x.isDirectory()) walk(p); else if (x.isFile()) try { n += fs.statSync(p).size; } catch {} } };
  try { walk(dir); } catch {}
  return n;
}
export function logStep(e, step, t0, extra = {}) {
  try {
    const f = path.join(e.mid, '用时.json');
    const log = readJsonLoose(f, []);
    log.push({ step, seconds: Math.round((Date.now() - t0) / 1000), at: new Date().toISOString(), diskGB: +(dirBytes(e.work) / 1024 ** 3).toFixed(2), threads: threads(), ...extra });
    writeJson(f, log.slice(-200), 0);
  } catch {}
}

// 后台任务的锁：转写、分说话人在后台跑时写一个，status 据此说"正在跑"，避免 AI 重复启动。
// 进程被强行结束时锁会留下，而 Windows 会把同一个进程号再分给别的程序；所以跑着的进程每 30 秒摸一下锁文件，
// 30 分钟没摸过就算死了（sherpa 的计算是同步的，算的时候摸不了，留足余量）。
// 分说话人整个是同步计算，长录音会超过 30 分钟：拿锁时按录音长短写一个 busyUntil（预计最晚什么时候跑完），这之前不按"没摸过"算死
const LOCK_QUIET_MIN = 30;
export function lockFile(e, name) { return path.join(e.mid, `${name}.lock`); }
export function lockInfo(e, name) {
  const f = lockFile(e, name), l = readJsonLoose(f, null);
  if (!l) return null;
  let beat = 0; try { beat = fs.statSync(f).mtimeMs; } catch {}
  let alive = false;
  if (Date.now() - beat < LOCK_QUIET_MIN * 60000 || Date.now() < (Number(l.busyUntil) || 0)) { try { process.kill(l.pid, 0); alive = true; } catch (err) { alive = err.code === 'EPERM'; } }
  return { ...l, alive, file: f, minutes: Math.round((Date.now() - Date.parse(l.at)) / 60000) };
}
// extra：额外记进锁里的东西（rewav：自动补转；busyUntil：见上）
export function takeLock(e, name, extra = {}) {
  fs.mkdirSync(e.mid, { recursive: true });
  const f = lockFile(e, name);
  writeJson(f, { pid: process.pid, at: new Date().toISOString(), ...extra });
  setInterval(() => { try { const t = new Date(); fs.utimesSync(f, t, t); } catch {} }, 30000).unref();
  process.on('exit', () => { try { const l = readJsonLoose(f, null); if (l?.pid === process.pid) fs.rmSync(f, { force: true }); } catch {} });
}

// 节目信息.md："- 字段：值" 的行。栏下面紧跟着的几行（缩进的子项、接着写的说明，到空行或下一栏为止）也算这一栏的值，
// 用换行接在后面——比如"- 不想删的："下面一条条列出来的。
// infoSnapshot 另外给出 rest：第一栏之后、不属于任何一栏的文字（空行后另起的补充说明、表格……）的指纹。
// 开头的标题和说明是模板文字，不算（status 会把旧版模板的说明换成新的，不能让确认失效）。
// 确认"素材"时记下 fields 和 rest，之后比对：改了确认过的栏、或 rest 变了，要重新确认（2026-11-20 审查 F2）
export function infoSnapshot(e) {
  const fields = {}, rest = [];
  if (!fs.existsSync(e.info)) return { fields, rest: sha('') };
  let cur = null, started = false;
  for (const raw of fs.readFileSync(e.info, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = raw.match(/^- ([^：:\n]+)[：:][ \t]*(.*)$/);
    if (m) { cur = m[1].trim(); fields[cur] = m[2].trim(); started = true; continue; }
    if (!raw.trim()) { cur = null; continue; }
    if (cur && !/^#/.test(raw)) { fields[cur] = fields[cur] ? `${fields[cur]}\n${raw.trim()}` : raw.trim(); continue; }
    cur = null;
    if (started) rest.push(raw.trim());
  }
  return { fields, rest: sha(rest.join('\n')) };
}
export const readInfo = (e) => infoSnapshot(e).fields;
export const infoBlank = (v) => !v || /^（.*）$/.test(v);
// 一栏的值放进一行话里（多行的值用分号接起来）
export const infoOneLine = (v) => String(v ?? '').replace(/\s*\n\s*/g, '；');
// AI 先替主理人填、还没念给他确认的值，写成"（开场原话：……，待确认）"：确认"素材"前要去掉括号和"待确认"
export const infoPending = (v) => /待确认/.test(v ?? '');
// "嘉宾是否同意"：'no' 有人明确不同意发布（哪怕只有一个人）；'unsure' 没填、没问清；'yes' 其余。
// notes 写进"发布前要确认"、status 在交付前拦一下，都用这一个（2026-11-20 审查 F2）
export function consentOf(info) {
  const v = info['嘉宾是否同意'];
  if (infoBlank(v) || infoPending(v)) return 'unsure';
  if (/不同意|没同意|未同意|不愿|拒绝|不让|不允许|不能发|别发|不要发|不公开|不想公开|^否|^不$/.test(v)) return 'no';
  if (/不确定|不知道|不清楚|没问(?!题)|未问|还没|待定|再问|不一定|想想|考虑/.test(v)) return 'unsure';
  // 看得出是同意的才算同意；别的写法（"小林说回头告诉我"）算没问清，发布前再问一次
  return /同意|可以|没问题|知道|允许|愿意|^是|^好|^(ok|yes)$/i.test(v) ? 'yes' : 'unsure';
}
// 有人明确不同意发布时，交付前要停下说的话。status 和 finish 用同一段（v0.7 审查 22）；单人节目、没有人不同意时返回 null
export function consentStopMsg(info) {
  if (isSolo(info) || consentOf(info) !== 'no') return null;
  return `节目信息里"嘉宾是否同意"写的是「${infoOneLine(info['嘉宾是否同意'])}」：有人不同意公开发布。先和主理人商量怎么办（这期不发，或者删掉这位嘉宾的内容、重新编排），处理好、把这一栏改清楚之前不要交付、不要发布`;
}
// 节目信息.md 开头的说明（new.mjs 写模板用）。旧版写的说明和现在的规则对不上，status 看到就换成这句（只换这一行，各栏不动）
export const INFO_GUIDE = '开工前和主理人问清楚。拿不准的写"不确定"，不要猜。AI 先替主理人填的写成"（开场原话：……，待确认）"，念给他、他说对了再去掉括号和"待确认"。'
  + '确认"素材"之后，原来空着的栏补上不用重新确认（"嘉宾是否同意"这类会影响简介和发布的，status 会提示重出简介，或在交付前停下）；改了已经确认过的栏（包括"不确定"改成别的）、栏下面另写的内容，要重新确认。';
export const INFO_GUIDE_OLD = [
  '开工前和主理人问清楚。拿不准的写"不确定"，不要猜。改完这个文件要重新确认"素材"这一步。',
  '开工前和主理人问清楚。拿不准的写"不确定"，不要猜。确认"素材"之后，原来空着的栏补上不用重新确认；改了已经确认过的栏（包括"不确定"改成别的）要重新确认。',
];
export function updateInfoGuide(e) {
  try {
    const text = fs.readFileSync(e.info, 'utf8');
    const lines = text.split('\n');
    const i = lines.findIndex((l) => INFO_GUIDE_OLD.includes(l.replace(/\r$/, '')));
    if (i < 0 || lines.slice(0, i).some((l) => /^- [^：:\n]+[：:]/.test(l))) return false; // 只换开头说明里的，不碰各栏
    lines[i] = INFO_GUIDE + (lines[i].endsWith('\r') ? '\r' : '');
    const st = fs.statSync(e.info);
    fs.writeFileSync(e.info, lines.join('\n'), 'utf8');
    fs.utimesSync(e.info, st.atime, st.mtime); // 只换了说明：修改时间不变（status 拿它和简介比新旧）
    return true;
  } catch { return false; }
}
// 节目简介用到的节目信息（notes 记进剪辑表，status 比对：改过就提示重出简介）
export const BRIEF_FIELDS = ['节目名', '本期主题', '嘉宾', '录音是否完整', '嘉宾是否同意'];
export const briefInfo = (info) => Object.fromEntries(BRIEF_FIELDS.map((k) => [k, info[k] ?? '']));
// 单人节目："嘉宾"写了 单人、1、一人、一个人、独白。没填不算（模板的提示里也有"单人"两个字）。transcribe、status、notes 都用这一个
export const isSolo = (info) => { const g = info['嘉宾']; return !infoBlank(g) && (/^(1|一)\s*(个)?人?$/.test(g.trim()) || /单人|一个人|独白|只有主持人/.test(g)); };

// 录音方式：几个文件是"前后接着"录的（拼接），还是"多轨"（每人一个话筒、同时录，要对齐混音）
export function recordingMode(e) {
  const v = readInfo(e)['录音方式'] ?? '';
  if (infoBlank(v)) return null; // 没填（模板里的提示文字本身就带"多轨"两个字）
  if (/多轨|同时|每人一/.test(v)) return 'multitrack';
  if (/前后|接着|分段|拼接|上下半/.test(v)) return 'sequential';
  return null;
}
// "a.mp3=老王、b.mp3=小李" 这类"文件=值"的列表；文件名可以不带扩展名
export function fileMap(e, field) {
  const v = readInfo(e)[field];
  const out = {};
  if (infoBlank(v)) return out;
  for (const kv of v.split(/[、,，;；\n]+/)) { const m = kv.match(/^\s*(.+?)\s*[=＝:：]\s*(.+?)\s*$/); if (m) out[m[1]] = m[2]; }
  return out;
}
// new.mjs 放录音进来时起的名字：反引号、引号、& % 这类在命令行里容易出事的字符和空格，都换成 _
export const safeName = (s) => String(s).replace(/[`'"$&|<>^%!]/g, '_').replace(/\s+/g, '_');
// 节目信息里手写的文件名和实际文件名比：不分大小写、NFC/NFD（Mac 和 Windows 之间传过的文件名）一样看待，
// 照原文件名写的也认（new.mjs 换掉的空格、& % 之类按同样的规则换一遍再比），带不带扩展名都行（2026-11-20 审查 F3、2026-11-22 审查 75）
const nameKey = (s) => safeName(String(s).normalize('NFC').trim()).toLowerCase();
const nameKeys = (f) => { const b = path.basename(f); return [nameKey(b), nameKey(path.parse(b).name)]; };
export const sameName = (written, file) => nameKeys(file).includes(nameKey(written));
export const lookupFile = (map, file) => {
  const direct = map[path.basename(file)] ?? map[path.parse(file).name];
  if (direct !== undefined) return direct;
  const k = Object.keys(map).find((x) => sameName(x, file));
  return k === undefined ? undefined : map[k];
};
// "音轨对应""音轨偏移"写了、但有名字对不上任何录音（手误，或者写的名字和实际文件差得太多）：返回一句说明，列出实际的录音名；
// 都对得上（或者没填）返回 null。以前对不上就当没写，偏移悄悄不生效、称呼空着，日志还说"没填"（2026-11-22 审查 75）
export function fileMapIssue(e, field, names) {
  const bad = Object.keys(fileMap(e, field)).filter((k) => !names.some((n) => sameName(k, n)));
  return bad.length ? `节目信息.md 的"${field}"里写的${bad.map((n) => `「${n}」`).join('、')}对不上任何录音。实际的录音有：${names.join('、')}。照抄这几个名字改好` : null;
}
export const trackWav = (e, i) => path.join(e.mid, `音轨${i + 1}_16k.wav`);
// 一个文件里有几条音频流、节目信息里又没写"音轨选择"的录音：transcribe 一开工就会停下来问，status、new 提前说（和"录音方式"一样）。
// 返回提示话（没有这种录音时返回 null）；读不了的文件不管（transcribe 会说）
// "音轨选择"写的值：全部 → 每条都用；第几条（从 1 数）→ [k-1]；超出范围、认不出数字 → { bad: 一句话 }。transcribe 和 status、new 用同一个
export function streamPick(name, v, n) {
  if (/全部|都用|所有|一起|混/.test(v)) return { sel: Array.from({ length: n }, (_, k) => k) };
  const k = Number(String(v).match(/\d+/)?.[0]);
  if (k >= 1 && k <= n) return { sel: [k - 1] };
  return { bad: `节目信息"音轨选择"里 ${name} 写的是「${v}」，可是这个文件${n > 1 ? `只有 ${n} 条音轨：写 1–${n} 之间的数（第几条），或者"全部"` : '只有 1 条音轨，不用选：把这一项删掉'}` };
}
const streamsOf = (f) => { try { return probe(f, { needDuration: false }).streams ?? []; } catch { return null; } };
// "音轨选择"写了、但超出这个文件的音轨数（2 条写成 3）或认不出：transcribe 会停下，status、new 先说怎么改（2026-11-24 复核）。没有返回 null
export function streamPickIssue(e, recs) {
  const picks = fileMap(e, '音轨选择');
  const bad = recs.flatMap((f) => {
    const v = lookupFile(picks, recName(e, f));
    if (v == null || infoBlank(v)) return [];
    const s = streamsOf(f);
    return s ? [streamPick(recName(e, f), v, s.length || 1).bad].filter(Boolean) : [];
  });
  return bad.length ? `${bad.join('；')}。改好再在后台运行 ${cmd('transcribe.mjs', e.work)} 转写` : null;
}
export function streamsAskMsg(e, recs) {
  const issue = streamPickIssue(e, recs);
  if (issue) return issue;
  const picks = fileMap(e, '音轨选择');
  const list = recs.flatMap((f) => {
    const v = lookupFile(picks, recName(e, f));
    if (v != null && !infoBlank(v)) return [];
    const s = streamsOf(f) ?? [];
    return s.length > 1 ? [{ name: recName(e, f), s }] : [];
  });
  if (!list.length) return null;
  const ch = (n) => (n === 1 ? '单声道' : n === 2 ? '立体声' : `${n} 声道`);
  return `${list.map((x) => `${x.name} 里有 ${x.s.length} 条音轨（${x.s.map((s, k) => `第 ${k + 1} 条${ch(s.channels)}`).join('，')}）`).join('；')}，转写前要先定用哪条。`
    + `先运行 ${cmd('transcribe.mjs', e.work)}（几秒钟就停下，不转写，列出每条音轨的平均音量），照着问主理人用哪条，在 节目信息.md 加一行"- 音轨选择：${list[0].name}=2"（写第几条，从 1 数；几条是不同的人、要一起用写"全部"），再在后台运行 ${cmd('transcribe.mjs', e.work)} 转写`;
}

// 原始录音：第一层的音频文件，加上 录音位置.json 里登记的别的盘上的录音（new.mjs 跨盘时不拷贝，只记原文件在哪）；
// 有几个时按 节目信息.md 的"录音顺序"，没写就按名字。返回完整路径；登记的录音找不到了也照样返回（用 missingRecordings 查）。
// 点开头的文件不算录音：Mac 在 exFAT/U 盘上会在旁边写 4KB 的 ._录音.mp3（AppleDouble），不是音频
export const extFile = (e) => path.join(e.work, '录音位置.json');
export const externalRecs = (e) => (readJson(extFile(e), null)?.files ?? []).filter((x) => x?.name && x?.path);
// 录音顺序：写了、但有名字对不上实际文件（或者有文件没写进去）时，不再悄悄改按名字排序（前后半场会被倒过来拼），
// 返回 orderIssue 说清楚；transcribe 拼接前看到它就停下，status 打出来
export function recordingsInfo(e) {
  const local = fs.readdirSync(e.work).filter((n) => AUDIO.test(n) && !n.startsWith('.') && n !== path.basename(e.rollcall));
  const where = Object.fromEntries(local.map((n) => [n, path.join(e.work, n)]));
  for (const x of externalRecs(e)) where[x.name] ??= x.path; // 节目目录里有同名文件的，用节目目录里的
  const files = Object.keys(where);
  const sorted = () => [...files].sort((a, b) => a.localeCompare(b, 'zh')).map((n) => where[n]);
  const order = readInfo(e)['录音顺序'];
  if (files.length < 2) return { files: sorted(), orderIssue: null };
  // 前后接着、几个文件、"录音顺序"空着：也停下（2026-11-22 审查）。按名字排会拼反："补录"排在"第1期"前面、"后半场"排在"前半场"前面。
  // 多轨不用顺序；录音方式没写的，transcribe 先问录音方式
  if (infoBlank(order)) return recordingMode(e) !== 'sequential' ? { files: sorted(), orderIssue: null } : { files: sorted(), blankOrder: true,
    orderIssue: `录音方式是"前后接着"，有 ${files.length} 个录音，可"录音顺序"没写，按名字排可能拼反（补录会排到正片前面、后半场排到前半场前面）。实际的录音有：${files.join('、')}。按播放顺序把这几个名字（照抄，用顿号隔开）写进"录音顺序"再继续` };
  // 先按顿号、逗号、分号、换行分；分出来的一项对不上、里面又有空格的，再按空格分（"a.mp3 b.mp3" 这种写法）
  const names = order.split(/[、,，;；\n]+/).map((x) => x.trim()).filter(Boolean)
    .flatMap((n) => (files.some((f) => sameName(n, f)) || !/\s/.test(n) ? [n] : n.split(/\s+/)));
  const picked = [], unknown = [];
  // 先找一字不差的（带不带扩展名），再放宽比；放宽比时跳过已经对上的文件：
  // "录音 1.wav""录音_1.wav"（Linux 上还有 Part.mp3 / part.mp3）放宽比是同一个名字，不这样第二个永远对不上
  for (const n of names) {
    const exact = (x) => x === n || path.parse(x).name === n;
    if (picked.some(exact)) continue; // 同一个名字写了两遍
    const free = files.filter((x) => !picked.includes(x));
    const f = free.find(exact) ?? free.find((x) => sameName(n, x)) ?? files.find((x) => sameName(n, x));
    if (!f) unknown.push(n); else if (!picked.includes(f)) picked.push(f);
  }
  const left = files.filter((f) => !picked.includes(f));
  if (!unknown.length && !left.length) return { files: picked.map((n) => where[n]), orderIssue: null };
  const clash = files.filter((f) => files.some((x) => x !== f && nameKeys(x).some((k) => nameKeys(f).includes(k))));
  const orderIssue = `节目信息.md 的"录音顺序"和实际的录音对不上：${unknown.length ? `写的${unknown.map((n) => `「${n}」`).join('、')}找不到` : ''}${unknown.length && left.length ? '；' : ''}${left.length ? `${left.map((n) => `「${n}」`).join('、')}没写进去` : ''}。`
    + `实际的录音有：${files.join('、')}。按播放顺序把这几个名字（照抄，用顿号隔开）写进"录音顺序"再继续，不然前后顺序可能拼反`
    + (clash.length ? `。其中${clash.map((n) => `「${n}」`).join('、')}名字只差大小写、空格或下划线：照抄完整的文件名（带扩展名，大小写、空格都一样）；还对不上就把其中一个文件改个名` : '');
  return { files: sorted(), orderIssue, unlisted: left };
}
// 录音方式和别的栏对不上（2026-11-22 审查：多轨节目照文档加补录，两种写法都会悄悄做坏）。transcribe 停下，status 打出来；返回一句话或 null
//   多轨：有文件不在"音轨对应"里（写了音轨对应的话），或者没写进"录音顺序"（写了录音顺序的话）——多轨会把它当成同时录的一条音轨、从头叠着混音；
//   前后接着：还写着"音轨对应""音轨偏移"（多轨才用）——多半是多轨节目为了加补录改成了前后接着，会把每个人的音轨首尾相接
export const MT_NO_SPLICE = '多轨节目暂时不能加补录旁白、也不能和另一期拼接。真要加：先用别的软件把各条音轨混成一个文件，再和补录一起按"前后接着"交进来（这样认人改用机器分说话人）';
export function modeIssue(e, info = recordingsInfo(e), mode = info.files.length > 1 ? recordingMode(e) : 'single') {
  if (info.files.length < 2) return null;
  const names = info.files.map((f) => recName(e, f));
  const map = fileMap(e, '音轨对应'), offs = fileMap(e, '音轨偏移');
  const q = (xs) => xs.map((n) => `「${n}」`).join('、');
  if (mode === 'multitrack') {
    const notMapped = Object.keys(map).length ? names.filter((n) => lookupFile(map, n) === undefined) : [];
    const extra = [...new Set([...notMapped, ...(info.unlisted ?? [])])];
    if (!extra.length) return null;
    // "音轨对应"里还有对不上任何录音的名字：多半是把这个文件名写错了，先说写错的那个，不先讲补录（2026-11-24 第 3 轮 4）
    const typo = notMapped.length ? fileMapIssue(e, '音轨对应', names) : null;
    if (typo) return `${typo}。${q(notMapped)}多半就是写错的那个：它现在不在"音轨对应"里，所以先停下（多轨会把它当成同时录的一条音轨叠着混音）。`
      + `它要真不是这期的音轨（补录的旁白、另一期的录音）：${MT_NO_SPLICE}`;
    return `录音方式写的是多轨，可${q(extra)}${notMapped.length ? '不在"音轨对应"里' : '没写进"录音顺序"'}。多轨会把每个文件都当成同时录的一条音轨、从头叠在一起混音：它要是补录的旁白、另一期的录音，会叠在开场上。`
      + `是漏写的音轨：把它是谁补进"音轨对应"（也写进"录音顺序"）。是补录：${MT_NO_SPLICE}；这期不要它：${externalRecs(e).some((x) => x.name === extra[0]) ? `运行 ${cmd('new.mjs', e.work, '--forget', extra[0])} 去掉登记` : '把它挪出节目目录（同一个盘放进来的是硬链接，挪走、删掉都不影响原文件）'}`;
  }
  if (mode === 'sequential') {
    const tf = [Object.keys(map).length && '音轨对应', Object.keys(offs).length && '音轨偏移'].filter(Boolean);
    if (!tf.length) return null;
    return `录音方式写的是"前后接着"（几个文件按顺序首尾拼起来），可节目信息里还写着${tf.map((x) => `"${x}"`).join('、')}（多轨才用）。多轨节目改成"前后接着"，会把每个人的音轨首尾相接：长度翻倍、对话顺序全乱。`
      + `是多轨节目：录音方式改回多轨。${MT_NO_SPLICE}。确实是前后接着录的：把${tf.map((x) => `"${x}"`).join('、')}清空再转写`;
  }
  return null;
}
export const recordings = (e) => recordingsInfo(e).files;
// 录音的名字（节目信息里"录音顺序""音轨对应"写的就是它）：节目目录里的是文件名，登记的外部录音用登记时的名字
export function recName(e, f) {
  const x = path.dirname(path.resolve(f)) === e.work ? null : externalRecs(e).find((r) => path.resolve(r.path) === path.resolve(f));
  return x ? x.name : path.basename(f);
}
export const missingRecordings = (e) => recordings(e).filter((f) => !fs.existsSync(f));
// 当初转写用的录音（制作文件/录音.json 的 files）现在还在不在：节目目录里的被删了、挪走了、改了名，几段里少了一段，
// 登记在别的盘上的找不到了，都算缺。clean 据此拒绝清理（清了就没法重剪），status 据此不提示清理。返回缺的录音名
// 名字按 NFC 比：Mac 和 Windows 之间传过的文件名，同一个字可能是两种写法（韩文、日文假名、带音标的字母），看着一样、字节不一样（2026-11-22 审查 82）
const nfc = (s) => String(s).normalize('NFC');
export function sourceMissing(e) {
  const meta = readJson(path.join(e.mid, '录音.json'), null);
  const now = recordings(e);
  const present = now.filter((f) => fs.existsSync(f)).map((f) => nfc(recName(e, f)));
  const lost = now.filter((f) => !fs.existsSync(f)).map((f) => recName(e, f));
  const gone = (meta?.files ?? []).filter((n) => !present.includes(nfc(n)));
  return [...new Set([...gone, ...lost])];
}
export function sourceMissingMsg(e, names) {
  const ext = externalRecs(e);
  const forgotten = (readJson(extFile(e), {}).forgotten ?? []).map(nfc);
  const isExt = (n) => ext.some((x) => nfc(x.name) === nfc(n));
  const dropped = names.filter((n) => forgotten.includes(nfc(n)) && !isExt(n));
  const far = names.filter(isExt);
  const near = names.filter((n) => !far.includes(n) && !dropped.includes(n));
  const parts = [];
  if (dropped.length) parts.push(`录音${dropped.map((n) => `「${n}」`).join('、')}已经用 --forget 去掉了登记：先改好 节目信息.md 的"录音顺序""录音方式"，再运行 ${cmd('transcribe.mjs', e.work)} 按剩下的录音重新转写（句子编号会变，编排方案要重新检查）`);
  if (near.length) parts.push(`转写时用的录音${near.map((n) => `「${n}」`).join('、')}不在节目目录里了（被删掉、挪走或者改了名）。放回节目目录、名字和原来一样就行；是有意去掉的（不要这段录音了）：先改好 节目信息.md 的"录音顺序""录音方式"，再运行 ${cmd('transcribe.mjs', e.work)} 按剩下的录音重新转写（句子编号会变，编排方案要重新检查）`);
  if (far.length) parts.push(missingMsg(e, far.map((n) => ext.find((x) => nfc(x.name) === nfc(n)).path)));
  return parts.join('；').replace(/。$/, ''); // 调用的地方自己接"。"（missingMsg 以"。"结尾，不去掉会出现"。。"，v0.7 审查 27）
}

// 前后接着拼起来的几个录音：每个文件在拼起来以后的录音里从哪儿开始、多长（transcribe 记进 录音.json 的 parts）。
// 全文、提纲在换文件的地方标出来，locate、编排方案.md 把时间换回"哪个文件第几秒"。只有一个文件、多轨的：null
// v0.7 以前转写的拼接节目没记 parts：录音还是转写时那几个、没变过，就按每个文件实际解码出来的长度补算一次、记回 录音.json
// （和 transcribe 算法一样，不重新识别；2026-11-23 复核：不补的话 plan 照旧把补录前后的正片报成"挪了位置"）。录音变了、找不到：null
export function recParts(e) {
  const f = path.join(e.mid, '录音.json');
  const m = readJson(f, null);
  if (m?.mode !== 'sequential') return null;
  if (Array.isArray(m.parts)) return m.parts.length > 1 ? m.parts : null;
  if (!(m.files?.length > 1)) return null;
  try {
    const recs = recordingsInfo(e).files;
    if (recs.length !== m.files.length || recs.some((x) => !fs.existsSync(x)) || nfc(recs.map((x) => recName(e, x)).join('|')) !== nfc(m.files.join('|')) || !sameRecStamp(m, recStamp(e, recs))) return null;
    let start = 0;
    const parts = recs.map((x) => { const d = decodedDuration(x) || duration(x); const p = { name: recName(e, x), start: +start.toFixed(3), dur: +d.toFixed(3) }; start += d; return p; });
    writeJson(f, { ...m, parts });
    return parts;
  } catch { return null; }
}
// 拼起来以后的时间 t 在第几个文件、文件里第几秒
export function partAt(parts, t) {
  if (!parts) return null;
  let k = 0;
  parts.forEach((p, i) => { if (t >= p.start - 0.05) k = i; });
  return { ...parts[k], k, at: Math.max(0, t - parts[k].start) };
}
// "（补录.wav 第 00:01）"：多个文件时跟在拼起来以后的时间后面；一个文件时是空的
export const inFile = (parts, t) => { const p = partAt(parts, t); return p ? `（${p.name} 第 ${fmt(p.at)}）` : ''; };

// 录音的"指纹"：录音方式 + 每个文件的名字、大小、音轨偏移、修改时间（transcribe 记进 制作文件/录音.json 的 stamp）。
// 一个文件里有几条音轨、节目信息里写了"音轨选择"的，偏移后面再记选的哪条（#2、#全部）：换一条音轨也算录音变了。
// v05：v0.4–v0.5.2 的写法（没有修改时间）；legacy：更早的（连"single|"前缀和偏移都没有）
export function recStamp(e, recs = recordingsInfo(e).files) {
  const mode = recs.length > 1 ? recordingMode(e) : 'single';
  const offsets = fileMap(e, '音轨偏移'), picks = fileMap(e, '音轨选择');
  const pick = (n) => { const v = lookupFile(picks, n); return v == null || infoBlank(v) ? '' : `#${v}`; };
  // 名字按 NFC 记、按 NFC 比（和 sourceMissing 一样）：Mac 拷过来的 NFD 文件名不算录音变了（2026-11-24 第 3 轮 2）
  const entry = (f, withTime) => { const st = fs.statSync(f), n = recName(e, f); return `${nfc(n)}:${st.size}:${lookupFile(offsets, n) ?? ''}${pick(n)}${withTime ? `:${Math.round(st.mtimeMs)}` : ''}`; };
  return { mode, offsets, stamp: nfc(`${mode}|` + recs.map((f) => entry(f, true)).join('|')), v05: nfc(`${mode}|` + recs.map((f) => entry(f, false)).join('|')), legacy: nfc(recs.map((f) => `${recName(e, f)}:${fs.statSync(f).size}`).join('|')) };
}
// 和 录音.json 记的比。只有两种旧写法才放宽比较，新写法一律逐项比
export function sameRecStamp(meta, s) {
  if (!meta?.stamp) return false;
  const was = nfc(meta.stamp);
  const legacy = !/^(single|sequential|multitrack)\|/.test(was);
  return was === s.stamp || was === s.v05
    || (legacy && (s.mode === 'single' || meta.mode === s.mode) && !Object.keys(s.offsets).length && was === s.legacy);
}
// 现在的录音和上次转写时还是不是同一份（2026-11-22 审查：补录加进来、录音顺序改了却没重新转写，或者转写半路被打断，
// status 照样说第 5 步、finish 照旧全文的时间去剪新录音）。返回 null 是没变（或者从没转写过、录音找不到——那些别处说）；
// 否则返回 { why, mtimeOnly }。mtimeOnly：名字、大小、顺序、偏移都没变，只是修改时间变了（可能只是被碰了一下，也可能在原位置改过）：
// 剪辑前会先核对内容（ensureWavs 的 recheck），不挡编排
export function recordingsChanged(e) {
  const meta = readJson(path.join(e.mid, '录音.json'), null);
  if (!meta?.stamp) return null;
  const { files: recs } = recordingsInfo(e);
  if (!recs.length || recs.some((f) => !fs.existsSync(f))) return null;
  const names = recs.map((f) => recName(e, f)), was = meta.files ?? [];
  // 名字按 NFC 比：同一个名字 NFC、NFD 两种写法不算"新加了一个、少了一个"（2026-11-24 第 3 轮 2）
  const nNames = names.map(nfc), nWas = was.map(nfc);
  const added = names.filter((n) => !nWas.includes(nfc(n))), removed = was.filter((n) => !nNames.includes(nfc(n)));
  if (removed.length && !added.length) return null; // 少了录音：sourceMissing 说（放回来，或者 --forget 之后重新转写）
  const s = recStamp(e, recs);
  if (sameRecStamp(meta, s)) {
    // 录音没变，可是识别结果不在、全文还在：上次转写换上新录音以后被打断了（旧版留下的）
    if (!fs.existsSync(e.asr) && fs.existsSync(e.full)) return { why: '上次转写半路断了：识别结果不在，全文还是旧的', mtimeOnly: false, unfinished: true };
    // 录音.json 已经按现在的录音记好，全文（或识别结果）却不在：转写还在跑，或者半路断了（现在的 transcribe 换录音前先删旧全文）。
    // 这时编排方案、精编版、检查都还是上次的，不能确认编排/成品、不能清理（2026-11-23 复核）
    if (!fs.existsSync(e.full) || !fs.existsSync(e.asr)) return lockInfo(e, '转写')?.alive
      ? { why: '转写正在后台跑，还没做完', mtimeOnly: false, unfinished: true, running: true }
      : { why: '上次转写半路断了：全文还没出来', mtimeOnly: false, unfinished: true };
    return null;
  }
  const q = (xs) => xs.map((n) => `「${n}」`).join('、');
  const why = [];
  if (added.length) why.push(`新加了${q(added)}`);
  if (removed.length) why.push(`少了${q(removed)}`);
  if (meta.mode && meta.mode !== 'single' && s.mode !== meta.mode) why.push(s.mode ? `录音方式从"${meta.mode === 'multitrack' ? '多轨' : '前后接着'}"改成了"${s.mode === 'multitrack' ? '多轨' : '前后接着'}"` : '有几个录音文件，可节目信息里没写清"录音方式"');
  else if (!added.length && !removed.length && nNames.join('|') !== nWas.join('|')) why.push('录音顺序改了');
  const body = (x) => nfc(x).replace(/^(single|sequential|multitrack|null)\|/, '').split('|').map((p) => p.split(':').slice(0, 3).join(':')).join('|');
  const sameButTime = !why.length && body(meta.stamp) === body(s.stamp);
  // 只是修改时间变了，可剪辑前按现在这个样子核对过、内容和转写时不一样（transcribe 自动补转记的 contentChanged）：就是在原位置改过
  if (sameButTime && meta.contentChanged?.stamp && nfc(meta.contentChanged.stamp) === s.stamp) return { why: '录音文件在原位置改过：名字、大小都没变，可内容和转写时不一样了（剪之前核对出来的）', mtimeOnly: false, edited: true, added };
  if (!why.length) why.push(sameButTime ? '名字、大小都没变，只是文件的修改时间变了' : '录音文件改过（大小、音轨偏移或音轨选择变了）');
  return { why: why.join('，'), mtimeOnly: sameButTime, added };
}
// 录音变了以后该怎么办（status、plan、build、finish、clean 共用一句话）
export function recChangedMsg(e, ch) {
  if (ch.running) return `${ch.why}，不要再启动。等它跑完，再运行 ${cmd('plan.mjs', e.work)} 按新全文核对编排方案`;
  if (ch.unfinished) return `${ch.why}。先在后台重新运行 ${cmd('transcribe.mjs', e.work)}（会整期重新识别，句子编号可能变），再运行 ${cmd('plan.mjs', e.work)} 按新全文核对编排方案`;
  if (ch.mtimeOnly) return `录音和上次转写时不太一样（${ch.why}）。剪之前会先核对内容：内容没变就照常剪；变了会停下说清楚`;
  if (ch.edited) return `${ch.why}，全文、编排方案、精编版还是按改之前的录音做的，现在剪会对不上。录音不该改的话（降噪后原地保存、被同名文件盖掉了）：把原来那份放回来，就能照常剪；`
    + `改过的这份才是要用的：在后台运行 ${cmd('transcribe.mjs', e.work)} 重新转写（会整期重新识别，句子编号会变），然后运行 ${cmd('plan.mjs', e.work)} 按新全文核对编排方案，改过的方案要重新给主理人确认`;
  const many = recordingsInfo(e).files.length > 1;
  // 多轨节目：不能照"补录写前后接着"改（会把各人的音轨首尾相接）
  const mt = recordingMode(e) === 'multitrack' || readJson(path.join(e.mid, '录音.json'), {}).mode === 'multitrack';
  return `录音和上次转写时不一样了（${ch.why}），全文、编排方案还是按旧录音做的，现在剪会对不上。`
    + `${!many ? '先' : mt ? `这期是多轨：${MT_NO_SPLICE}。新加的是漏掉的音轨，就在"音轨对应""录音顺序"里补上它，再` : '先在 节目信息.md 改好"录音方式"（补录、两期拼成一期写"前后接着"）和"录音顺序"（按播放顺序写全），再'}在后台运行 ${cmd('transcribe.mjs', e.work)} 重新转写（内容变了会整期重新识别，句子编号会变），然后运行 ${cmd('plan.mjs', e.work)} 按新全文核对编排方案，改过的方案要重新给主理人确认`;
}

// ---- 清理过的中间文件 ----
// clean.mjs 只删 制作文件/ 里能重新生成的大文件（转好的 wav 之类），json 都留着。
// 要用转好的录音（剪辑、对比、重新分说话人、记声纹）时发现没有了，先自动跑一次 transcribe 重新转换（BOKE_REWAV）：
// 只恢复 wav，识别、分说话人、段响度、全文一律不动，几十秒。
// 录音和当初转写时不一样了（换过、重新导出过、改了音轨偏移，硬链接的原文件被改过）而且转出来的内容也不一样，
// 自动补转就停下说清楚、什么都不删：悄悄重新识别会让句子编号对不上已经确认的编排方案（2026-11-20 审查 F3）
export const CLEAN_KEEP = /\.(json|log|lock|txt|md)$/i; // 制作文件/ 里这些留着（识别、分说话人、段响度、用时、日志、旧版的方案原文……）
export function cleanable(e) {
  const out = [];
  const walk = (d) => { let xs = []; try { xs = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of xs) { const p = path.join(d, x.name); if (x.isDirectory()) walk(p); else if (x.isFile() && !CLEAN_KEEP.test(x.name)) { try { out.push({ file: p, bytes: fs.statSync(p).size }); } catch {} } } };
  walk(e.mid);
  return out;
}
export const sizeText = (b) => (b >= 1024 ** 3 ? GB(b) : `${Math.max(b > 0 ? 1 : 0, Math.round(b / 1024 ** 2))} MB`);
// recheck：录音文件只是修改时间变了（recordingsChanged 的 mtimeOnly）：wav 都在也重新转换一次，核对内容和转写时一样不一样
export function ensureWavs(e, { tracks = false, recheck = false } = {}) {
  const meta = readJson(path.join(e.mid, '录音.json'), null);
  if (!meta) return; // 从没转写过：调用的脚本照旧说"先运行 transcribe"
  const need = [e.wav44, e.wav16, ...(tracks && meta.mode === 'multitrack' ? (meta.files ?? []).map((_, i) => trackWav(e, i)) : [])];
  if (!recheck && need.every((f) => fs.existsSync(f))) return;
  console.log(recheck ? '录音文件的修改时间变了，先核对一下内容和转写时一样不一样（重新转换一次，几十秒）……' : '中间文件清理过（或被删了），先重新转换录音（几十秒）……');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'podcast', 'transcribe.mjs'), e.work, '--no-speakers'], { stdio: 'inherit', windowsHide: true, env: { ...process.env, BOKE_REWAV: '1' } });
  if (r.status !== 0 || !need.every((f) => fs.existsSync(f))) throw new Error(`重新转换录音没成功（上面是原因），这次没剪。处理好再运行一次同一条命令`);
}
// Windows 上识别程序（sherpa）读 wav 用的是老接口：完整路径到 260 个字（中文也按一个字算）就读不了，只报一句英文。
// 节目目录太深时先说清楚（transcribe、speakers、check 开工前，status 的下一步）。nTracks：多轨时每条轨的 16k（名字更长）
export function longPathMsg(e, nTracks = 0) {
  if (process.platform !== 'win32') return null;
  const files = [e.wav16, path.join(e.mid, 'check16k.wav'), ...Array.from({ length: nTracks }, (_, i) => trackWav(e, i))];
  const worst = files.reduce((a, b) => (b.length > a.length ? b : a));
  if (worst.length < 260) return null;
  const room = 259 - (worst.length - e.work.length);
  return `节目目录的路径太长了（${e.work.length} 个字）：Windows 上识别程序读不了完整路径到 260 个字的文件（${path.relative(e.work, worst)} 的完整路径有 ${worst.length} 个字）。`
    + `把整个节目目录挪到浅一点的地方（比如 D:\\播客\\${path.basename(e.work)}），节目目录的完整路径不要超过 ${room} 个字，再对新位置运行同一条命令（已经做完的不会重做）`;
}
// 识别出 0 句：transcribe 停下、status 给下一步，用同一句话
export const NO_VOICE = (e) => `录音里没识别出人声（一句都没有）：可能整段是静音、只有底噪，或者放进来的不是这期的录音、用错了音轨。先听一下录音，换成对的文件后再运行 ${cmd('transcribe.mjs', e.work)}（换了录音会整期重新识别）。这次没出全文，也没分说话人`;
export const asrEmpty = (e) => { const a = readJson(e.asr, null); return Array.isArray(a) && a.length === 0; };
// 全文.txt、全文提纲.md 被别的程序独占着（编辑器、预览窗口）或者是只读的：transcribe 最后要重写它们，写不进去。
// 返回写不进的文件名（都写得进、或者还没有这两个文件时是 []）。transcribe 开工前先看（以前换录音时删旧全文就报一句英文 EPERM、
// 识别结果已经删了；2026-11-24 复核 #79），status 的下一步也用它，不再一遍遍叫人原样重跑
export function fullBusy(e) {
  return [e.fullTxt, e.outline].filter((f) => {
    try { fs.closeSync(fs.openSync(f, 'r+')); return false; } catch (err) { return BUSY.has(err.code); }
  }).map((f) => path.basename(f));
}
export const fullBusyMsg = (e, names) => `${names.join('、')} 被别的程序占着（编辑器、预览窗口开着它），或者是只读的：转写最后要重写${names.length > 1 ? '这几个文件' : '它'}，写不进去。${roFix(e.work)}`;
// 登记在 录音位置.json 的录音找不到了。没拷进节目目录有两种：录音在别的盘；或者同一个盘但不支持硬链接（U 盘的 exFAT 之类）
export const missingMsg = (e, miss) => `录音找不到了：${miss.map((f) => `「${recName(e, f)}」（开这期时登记的位置是 ${f}）`).join('、')}。`
  + `这期的录音没有拷进节目目录，只记了位置（${path.basename(extFile(e))}）。被移走或删掉了的话：放回原处；或者挪到了别处，运行 ${cmd('new.mjs', e.work, '<录音的新位置>')}（"<录音的新位置>"换成录音现在的完整路径）重新登记，已经做完的不会重做。`
  + `文件名也改了的话照样运行这条命令：大小一样（或者只丢了这一个、这次也只给一个）的会自动换掉找不到的那条登记；换不掉时加 --forget <找不到的录音名> 去掉旧登记（会整期重新转写）。`;

// ---- 全文 ----
export const PUNCT = /^[，。！？、；：,.!?;:]$/;
export const fmt = (s) => { s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60); return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; };
export const mins = (s) => `${(s / 60).toFixed(1)} 分钟`;
export function loadFull(e) {
  const full = readJson(e.full, null); // 坏了、读不了的会说清楚（readJson），不当成"还没有"
  if (!full) throw userError(`还没有 全文.json。先运行 ${cmd('transcribe.mjs', e.work)}`);
  return full;
}
// 在一句话的逐字时间里找一段原文，返回第一个和最后一个字的序号
export function findInSentence(s, text) {
  let joined = ''; const map = [];
  s.toks.forEach((t, k) => { for (const _ of t.t) map.push(k); joined += t.t; });
  const at = joined.indexOf(text);
  if (at < 0) return null;
  return { first: map[at], last: map[at + text.length - 1] };
}

// ---- 剪口：编排方案里的一段 → 实际剪下来的几个片段 ----
// build 剪的时候用，plan 估片头配乐要铺多长也用同一套（以前 plan 按句子时间估、build 按实际片段算，同一首曲子两边差 1 秒）
export const CUT = { LONG_PAUSE: 0.9, PAD: { tail: 0.35, head: 0.25, edge: 0.2 }, FILLER: /^[呃嗯]$/ };
// 片头：钩子前空 2 秒，几句原话之间空 0.7 秒，钩子后 2.5 秒；片头配乐铺到钩子后再 3.5 秒
export const HOOK_GAP = { hookLead: 2.0, betweenQuotes: 0.7, afterHook: 2.5, bedAfter: 3.5 };
export const introBedSeconds = (quoteSecs) => HOOK_GAP.hookLead + quoteSecs.reduce((a, b) => a + b, 0) + HOOK_GAP.betweenQuotes * Math.max(0, quoteSecs.length - 1) + HOOK_GAP.afterHook + HOOK_GAP.bedAfter;
// sentence(id)、find(s, text, 'startText')：找不到时怎么办由调用的地方定（build 停下说"全文变过"；默认抛错）
export function makeClipper(full, { sentence, find } = {}) {
  const byId = new Map(full.map((s) => [s.id, s]));
  sentence ??= (id) => { const s = byId.get(id); if (!s) throw new Error(`第 ${id} 句不在全文里`); return s; };
  find ??= (s, text, which) => { const m = findInSentence(s, text); if (!m) throw new Error(`第 ${s.id} 句里找不到 ${which}「${text}」`); return m; };
  const { LONG_PAUSE, PAD, FILLER } = CUT;
  const prevEnd = (id) => byId.get(id - 1)?.end ?? 0;
  const nextStart = (id) => byId.get(id + 1)?.start ?? Infinity;
  function partSpans(p) {
    const spans = [];
    for (let id = p.from; id <= p.to; id++) {
      const s = sentence(id);
      const words = s.toks.filter((t) => !PUNCT.test(t.t));
      if (p.from !== p.to && words.length && words.every((t) => FILLER.test(t.t) || t.t === '啊')) continue; // 整句只有"嗯""呃"
      spans.push({ id, s: s.start, e: s.end, hardStart: false, hardEnd: false });
    }
    const first = spans[0], last = spans.at(-1);
    if (!first) return spans;
    if (p.startText) { const s = byId.get(first.id), m = find(s, p.startText, 'startText'); first.s = s.toks[m.first].s - 0.08; first.hardStart = true; }
    if (p.endText) {
      const s = byId.get(last.id), m = find(s, p.endText, 'endText');
      const next = s.toks.slice(m.last + 1).find((t) => !PUNCT.test(t.t));
      last.e = next ? Math.min(next.s - 0.01, s.toks[m.last].s + 0.55) : s.end;
      last.hardEnd = true;
    }
    return spans;
  }
  function skipLeadingFiller(sp) {
    if (sp.hardStart) return;
    const toks = byId.get(sp.id).toks;
    if (!toks.length || !FILLER.test(toks[0].t)) return;
    const real = toks.find((t) => !FILLER.test(t.t) && !PUNCT.test(t.t));
    if (real && real.s - sp.s < 3) { sp.s = real.s - 0.06; sp.hardStart = true; }
  }
  function clipsOf(spans) {
    const clips = [];
    let cur = null, prev = null;
    for (const sp of spans) {
      if (prev && !prev.hardEnd && !sp.hardStart && sp.id === prev.id + 1 && sp.s - prev.e <= LONG_PAUSE) { cur.to = sp.e; cur.lastId = sp.id; cur.hardEnd = sp.hardEnd; prev = sp; continue; }
      if (cur) clips.push(cur);
      skipLeadingFiller(sp);
      const pad = prev ? PAD.head : PAD.edge;
      cur = { from: sp.hardStart ? sp.s : Math.max(sp.s - pad, prevEnd(sp.id) + 0.03), to: sp.e, firstId: sp.id, lastId: sp.id, hardEnd: sp.hardEnd };
      prev = sp;
    }
    clips.push(cur);
    clips.forEach((c, k) => { if (!c.hardEnd) c.to = Math.min(c.to + (k + 1 < clips.length ? PAD.tail : PAD.edge + 0.1), nextStart(c.lastId) - 0.03); });
    return clips;
  }
  // 这一段剪下来一共几秒
  const partSeconds = (p) => clipsOf(partSpans(p)).filter(Boolean).reduce((s, c) => s + (c.to - c.from), 0);
  return { partSpans, clipsOf, partSeconds };
}

// ---- 全文提纲和编排方案草稿（fulltext.mjs 每次出全文时一起写）----
// 纯机械，没有大模型：按停顿和说话人轮次把全文切成约 2–4 分钟一块，每块一行：句子编号、时间、谁在说、开头一句和结尾一句的节选。
// 长度约全文的 1/9：AI 先扫一遍提纲，想细看哪块再去 全文.txt 找那个〔编号〕，不用每次从头读两万字
const BLOCK = { min: 120, max: 240, aim: 180, tail: 60 };
export function outlineBlocks(full) {
  const blocks = [], end = full.at(-1)?.end ?? 0;
  let a = 0;
  while (a < full.length) {
    const t0 = full[a].start;
    if (end - t0 <= BLOCK.max) { blocks.push(full.slice(a)); break; }
    // 在 2–4 分钟之间挑断点：停顿越长越好，换人说话加分，离 3 分钟越近越好；剩下不到 1 分钟的不在这断
    let best = -1, bestScore = -Infinity;
    for (let j = a; j < full.length - 1; j++) {
      const dur = full[j].end - t0;
      if (dur < BLOCK.min) continue;
      if (dur > BLOCK.max || end - full[j + 1].start < BLOCK.tail) break;
      const score = Math.min(5, full[j + 1].start - full[j].end) + (full[j + 1].speaker !== full[j].speaker ? 0.8 : 0) - Math.abs(dur - BLOCK.aim) / BLOCK.aim * 0.6;
      if (score > bestScore) { bestScore = score; best = j; }
    }
    if (best < 0) { best = a; while (best < full.length - 1 && full[best].end - t0 < BLOCK.min) best++; } // 一句就很长：够 2 分钟就断
    blocks.push(full.slice(a, best + 1));
    a = best + 1;
  }
  return blocks;
}
function outlineLine(b) {
  const chars = b.reduce((n, s) => n + s.text.length, 0);
  const n = Math.max(20, Math.min(80, Math.round((chars / 9 - 45) / 2))); // 开头、结尾各节选多少字：跟着这块的字数走，整份约全文的 1/9
  // 开头从第一句往后、结尾从最后一句往前，凑够 n 个字（一句太短，比如"对。"，就多带一两句）；两头不重叠
  const half = Math.ceil(b.length / 2);
  const take = (xs) => { const got = []; let len = 0; for (const s of xs) { got.push(s); len += s.text.length; if (len >= n) break; } return got; };
  const heads = take(b.slice(0, half)), tails = b.length > 1 ? take(b.slice(half).reverse()).reverse() : [];
  const tag = (s) => (s.speaker ? `${s.speaker}${s.name ? `（${s.name}）` : ''}：` : '');
  const text = (xs) => xs.map((s, i) => (i && s.speaker && s.speaker !== xs[i - 1].speaker ? `／${tag(s)}` : '') + s.text).join('');
  const cap = Math.round(n * 1.3);
  const headT = text(heads), tailT = text(tails);
  const share = {};
  for (const s of b) if (s.speaker) { const k = `${s.speaker}${s.name ? `（${s.name}）` : ''}`; share[k] = (share[k] ?? 0) + s.text.length; }
  const who = Object.entries(share).sort((x, y) => y[1] - x[1]).filter(([, v]) => v / chars >= 0.1).map(([k, v]) => `${k} ${Math.round(v / chars * 100)}%`).join('、');
  return `- 〔${b[0].id}–${b.at(-1).id}〕${fmt(b[0].start)}–${fmt(b.at(-1).end)}${who ? `｜${who}` : ''}`
    + `｜开头${heads[0].speaker ? ` ${tag(heads[0])}` : '：'}${headT.length > cap ? `${headT.slice(0, cap)}……` : headT}`
    + (tails.length ? `｜结尾${tails[0].speaker ? ` ${tag(tails[0])}` : '：'}${tailT.length > cap ? `……${tailT.slice(-cap)}` : tailT}` : '');
}
// 草稿的"说明"：另存成 编排方案.json 以后也说得通（不写"不要改这个文件"），并且叫 AI 另存后删掉这一栏
export const DRAFT_NOTE_MARK = '这是机器草稿';
export function draftPlan(blocks, e) {
  return {
    说明: `${DRAFT_NOTE_MARK}（编排方案.草稿.json，按 全文提纲.md 切的）：一块一个板块，全文都留着、没有删减，名字和小话题都写着"待改"。`
      + '复制一份另存为 编排方案.json，在那份上改：合并板块、起名字、加片头钩子；要删的句子从 sections 里拿掉（把段拆开、跳过那几句），cuts 只写删的原因。'
      + `另存后把这一栏"说明"删掉，改好运行 ${cmd('plan.mjs', e.work)}。草稿本身别改：重新出全文时会重写`,
    title: '待改', titleOptions: ['待改'], theme: '待改',
    sections: blocks.map((b, i) => ({ name: `待改：第 ${i + 1} 块（${fmt(b[0].start)} 起）`, parts: [{ from: b[0].id, to: b.at(-1).id, label: '待改' }] })),
    cuts: [],
  };
}
export function writeOutline(e, full) {
  if (!full.length) return null;
  // 前后接着拼起来的几个录音（补录、两期拼成一期）：按文件分开切块，每个文件前面标一行，块不跨文件（2026-11-22 审查）
  const rp = recParts(e);
  const groups = [];
  for (const s of full) { const k = partAt(rp, s.start)?.k ?? 0; if (groups.at(-1)?.k !== k) groups.push({ k, xs: [] }); groups.at(-1).xs.push(s); }
  const blocks = [], lines = [];
  for (const g of groups) {
    const bs = outlineBlocks(g.xs);
    if (rp) lines.push('', `## 第 ${g.k + 1} 个录音「${rp[g.k].name}」（拼起来以后从 ${fmt(rp[g.k].start)} 开始，〔${g.xs[0].id}–${g.xs.at(-1).id}〕）`);
    blocks.push(...bs); lines.push(...bs.map(outlineLine));
  }
  fs.writeFileSync(e.outline, [
    '# 全文提纲（机器按停顿和说话人切的，内容以 全文.txt 为准）',
    `# 原始录音 ${fmt(full.at(-1).end)}，${full.length} 句，切成 ${blocks.length} 块，每块约 2–4 分钟。每行：〔句子编号〕原位置｜谁在说（按字数）｜开头和结尾的原话节选。`,
    ...(rp ? [`# 这期是 ${rp.length} 个录音前后接着拼起来的（${rp.map((p) => p.name).join(' + ')}），下面按录音分开；原位置是拼起来以后的时间。`] : []),
    '# 先扫一遍这个，想细看哪块，再去 全文.txt 找那个〔编号〕。编排方案.草稿.json（没被改过的话）的板块就是按这些块切的。',
    '', ...lines, ''].join('\n'), 'utf8');
  // 草稿：AI 在上面改过（指纹和上次写的不一样）就不动——除非句子编号变了（重新识别过）：改过的那份编号是旧的，
  // 留着会和提纲对不上，挪成 编排方案.草稿.旧.json，重新写一份
  const mark = path.join(e.mid, '草稿指纹.json');
  const old = readJson(mark, null), now = fileSha(e.draft), fp = fullSha(full);
  let draft = 'kept';
  if (now && now !== old?.sha && old?.full && old.full !== fp) { fs.renameSync(e.draft, e.draftOld); draft = 'replaced'; }
  if (!fs.existsSync(e.draft) || now === old?.sha) { writeJson(e.draft, draftPlan(blocks, e), 2); writeJson(mark, { sha: fileSha(e.draft), full: fp }); if (draft !== 'replaced') draft = 'written'; }
  return { blocks: blocks.length, chars: lines.join('\n').length, draft };
}
