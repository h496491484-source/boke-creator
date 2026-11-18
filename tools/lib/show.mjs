// 节目档案：一档节目设置一次，每期自动用上。放在节目文件夹里，和各期并排：
//
//   <节目文件夹>/                比如 播客精编/某某播客/
//     节目档案/
//       档案.md        节目名、主播、目标时长、剪辑偏好、简介风格、片头片尾、配乐、响度、常错词（人填）
//       声纹.json      认过的常驻主播的声纹（程序写，show.mjs --learn）
//       素材/          片头、片尾、配乐音频，以前的简介
//     2026-11-20_第12期/   一期一个文件夹
//
// 一期节目找档案：先看 节目信息.md 的"节目档案"一栏（写了路径就用它），没写就从节目目录往上找三层，找到第一个 节目档案/档案.md。

import fs from 'node:fs';
import path from 'node:path';
import { readInfo, infoBlank, readJson, writeJson, RATE16 } from './podcast.mjs';

export const SHOW_DIR = '节目档案';
const FILE = '档案.md';

// 档案里能填的东西（顺序就是模板里的顺序）
export const SHOW_FIELDS = {
  节目名: '（比如"某某播客"）',
  主持人: '（称呼；几位就写几位，用顿号隔开）',
  常驻嘉宾: '（经常来的嘉宾的称呼，没有写"无"）',
  目标时长: '（精编版一般剪到多少分钟，比如 35–40）',
  剪辑偏好: '（随便写，AI 编排时照着做。比如"少删，闲聊也留着""开头不要钩子""每期都保留结尾的读者来信"）',
  简介风格: '（随便写，比如"口语、短句、带 emoji"；也可以把以前的简介放进 素材/，写文件名）',
  片头: '（素材/ 里的文件名：固定的片头曲或开场白，放在片头钩子之后、正文之前；没有钩子就放在最前面。不要写"无"）',
  片尾: '（素材/ 里的文件名：固定的片尾口播或片尾曲，放在正文结束之后。不要写"无"）',
  配乐: '（板块过渡和片头片尾铺底用的音乐：写"默认"用技能自带的 CC0 曲子；写 素材/ 里的文件名用自己的；写"无"不加）',
  配乐署名: '（用自己的音乐时写曲名、作者和授权，会写进简介）',
  响度: '（成品响度，默认 -16 LUFS；平台另有要求再改，比如 -14）',
  发布平台: '（小宇宙、喜马拉雅、B 站……）',
};

export function showTemplate(name = '') {
  return `# 节目档案

一档节目填一次，以后每期自动用上。拿不准的空着，不要猜。
片头、片尾、配乐的音频放进旁边的 素材/ 文件夹，这里写文件名。

${Object.entries(SHOW_FIELDS).map(([k, hint]) => `- ${k}：${k === '节目名' && name ? name : k === '配乐' ? '默认' : hint}`).join('\n')}

## 常错词

转写常把节目名、人名、术语认错。在下面加，每行以"- "开头，写成"- 错的 → 对的"，以后每期转写完自动替换。

`;
}

// 档案在哪：节目信息.md 里写了就用写的；没写就从节目目录往上找
export function findShowDir(e) {
  const v = readInfo(e)['节目档案'];
  if (!infoBlank(v) && v !== '无') {
    const p = path.resolve(e.work, v);
    const dir = path.basename(p) === FILE ? path.dirname(p) : path.basename(p) === SHOW_DIR ? p : path.join(p, SHOW_DIR);
    return fs.existsSync(path.join(dir, FILE)) ? dir : null;
  }
  if (v === '无') return null;
  let d = path.dirname(e.work);
  for (let i = 0; i < 3; i++) {
    const c = path.join(d, SHOW_DIR);
    if (fs.existsSync(path.join(c, FILE))) return c;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

export function readShow(dir) {
  const text = fs.readFileSync(path.join(dir, FILE), 'utf8');
  const fields = {};
  for (const m of text.matchAll(/^- ([^：:\n]+)[：:][ \t]*(.*)$/gm)) fields[m[1].trim()] = m[2].trim();
  const fixes = [];
  const sec = text.split(/^##\s*常错词\s*$/m)[1] ?? '';
  for (const line of sec.split(/\r?\n/)) {
    if (/^#/.test(line)) break;
    if (!/^\s*[-*]\s+/.test(line)) continue; // 只认"- 错的 → 对的"，说明文字不算
    const m = line.replace(/^\s*[-*]\s+/, '').match(/^\s*(.+?)\s*(?:→|->|=>|＝>|⇒)\s*(.*?)\s*$/);
    if (m && m[1] && m[1] !== m[2]) fixes.push({ from: m[1], to: m[2] });
  }
  fixes.sort((a, b) => b.from.length - a.from.length); // 长的先换
  const get = (k) => (infoBlank(fields[k]) ? '' : fields[k]);
  return { dir, file: path.join(dir, FILE), assets: path.join(dir, '素材'), voicesFile: path.join(dir, '声纹.json'), fields, get, fixes };
}

export function loadShow(e) {
  const dir = findShowDir(e);
  return dir ? readShow(dir) : null;
}

// 片头、片尾、配乐：返回音频路径；'default' = 技能自带配乐；null = 没有。写了文件名但找不到就报错（不悄悄忽略）
export function showAsset(show, field) {
  const v = show?.get(field);
  if (!v) return field === '配乐' ? 'default' : null;
  if (/^(无|没有|不要|不加|否)$/.test(v)) return null;
  if (field === '配乐' && /^(默认|自带|默认配乐)$/.test(v)) return 'default';
  const cands = [path.resolve(show.assets, v), path.resolve(show.dir, v), path.resolve(v)];
  const hit = cands.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (!hit) throw new Error(`节目档案里"${field}"写的是 ${v}，但在 ${show.assets} 里找不到这个文件。把文件放进去，或者改档案。`);
  return hit;
}

export function targetLufs(show) {
  const v = show?.get('响度');
  const n = v ? Number((v.match(/-?\d+(\.\d+)?/) ?? [])[0]) : NaN;
  if (!Number.isFinite(n)) return -16;
  const x = n > 0 ? -n : n; // 写成"16"也当 -16
  if (x < -24 || x > -10) throw new Error(`节目档案里的响度 ${v} 不合常理（播客一般在 -19 到 -14 LUFS 之间）。`);
  return x;
}

// 常错词：在一句话的逐字时间里换字。换掉的字落在原来那几个字上，时间不变；只换这句里的
export function applyFixes(toks, fixes) {
  if (!fixes?.length) return { toks, n: 0 };
  let out = toks, n = 0;
  for (const f of fixes) {
    for (let guard = 0; guard < 50; guard++) {
      let joined = ''; const owner = [];
      out.forEach((t, k) => { for (const _ of t.t) owner.push(k); joined += t.t; });
      const at = joined.indexOf(f.from);
      if (at < 0) break;
      const a = owner[at], b = owner[at + f.from.length - 1];
      let startChar = 0; for (let k = 0; k < a; k++) startChar += out[k].t.length;
      let endChar = startChar; for (let k = a; k <= b; k++) endChar += out[k].t.length;
      const text = joined.slice(startChar, at) + f.to + joined.slice(at + f.from.length, endChar);
      const span = out.slice(a, b + 1);
      const chars = [...text];
      // 新字按顺序落到原来那几个字的时间上；新的比旧的少，多出来的旧字丢掉；新的多，剩下的都并进最后一个
      const repl = [];
      for (let k = 0; k < span.length && k < chars.length; k++) repl.push({ t: k === span.length - 1 || k === chars.length - 1 ? chars.slice(k).join('') : chars[k], s: span[k].s });
      out =[...out.slice(0, a), ...repl, ...out.slice(b + 1)];
      n++;
      if (!f.to.includes(f.from)) continue;
      break; // "张三 → 张三丰"这种，换一次就停，免得越换越长
    }
  }
  return { toks: out, n };
}

// ---- 声纹 ----
// 每个人取最长的几段（每段最多 15 秒，合计约 60 秒）各算一个声纹，归一化后平均。
// 2026-11-18 用 VOL01（65 分钟、十来个人）试：同一编号前后半场相似度中位 0.89、最低 0.72（只有 16 秒的人）；
// 不同的人最高 0.67（被机器拆成两个编号的同一个人在 0.8–0.9）。所以 ≥0.75 算认出，0.62–0.75 算"可能是"。
export const VOICE = { match: 0.75, maybe: 0.62, margin: 0.06, same: 0.78 };
export function voiceExtractor(sherpa, model, threads) {
  return new sherpa.SpeakerEmbeddingExtractor({ model, numThreads: threads, provider: 'cpu', debug: 0 });
}
export function embedSegments(ex, samples, segs, maxSec = 60) {
  let acc = null, sec = 0;
  for (const s of [...segs].sort((a, b) => (b.end - b.start) - (a.end - a.start))) {
    if (s.end - s.start < 1.5 || sec >= maxSec) continue;
    const st = ex.createStream();
    const end = Math.min(s.end, s.start + 15);
    st.acceptWaveform({ sampleRate: RATE16, samples: samples.subarray(Math.round(s.start * RATE16), Math.round(end * RATE16)) });
    st.inputFinished();
    const v = ex.compute(st);
    let nv = 0; for (const x of v) nv += x * x; nv = Math.sqrt(nv) || 1;
    acc ??= new Float64Array(v.length);
    for (let i = 0; i < v.length; i++) acc[i] += v[i] / nv;
    sec += end - s.start;
  }
  return acc ? { v: unit(acc), sec: +sec.toFixed(1) } : null;
}
export function unit(v) { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return Array.from(v, (x) => +(x / n).toFixed(5)); }
export const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

export const loadVoices = (show) => (show ? readJson(show.voicesFile, { people: {} }) : { people: {} });
export const saveVoices = (show, data) => writeJson(show.voicesFile, data, 0);

// 每个编号和档案里的每个人比。够像（≥0.75）、而且明显比档案里第二像的人更像，才算认出。
// 一个人可以认给几个编号：机器常把同一个人拆成两个编号（11-18 下半场实测，乙被拆成 B、F，相似度 0.92、0.87，都对）
export function matchVoices(labelEmb, voices) {
  const people = Object.entries(voices.people ?? {});
  const res = {};
  if (!people.length) return res;
  const pairs = [];
  for (const [lab, x] of Object.entries(labelEmb)) {
    if (!x) continue;
    const sims = people.map(([name, p]) => ({ name, sim: cosine(x.v, p.v) })).sort((a, b) => b.sim - a.sim);
    const best = sims[0], second = sims[1]?.sim ?? -1;
    pairs.push({ lab, ...best, clear: best.sim - second >= VOICE.margin });
  }
  for (const p of pairs) {
    if (p.sim < VOICE.maybe) continue;
    res[p.lab] = { name: p.name, sim: +p.sim.toFixed(2), sure: p.sim >= VOICE.match && p.clear };
  }
  return res;
}
