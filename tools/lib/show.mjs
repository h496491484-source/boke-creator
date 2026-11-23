// 节目档案：一档节目设置一次，每期自动用上。放在节目文件夹里，和各期并排：
//
//   <节目文件夹>/                比如 播客精编/某某播客/
//     节目档案/
//       档案.md        节目名、主播、目标时长、剪辑偏好、简介风格、片头片尾、配乐、响度、常错词（人填）
//       声纹.json      认过的常驻主播的声纹（程序写，show.mjs --learn）
//       素材/          片头、片尾、配乐音频，以前的简介
//     2026-11-20_第12期/   一期一个文件夹
//
// 一期节目找档案：先看 节目信息.md 的"节目档案"一栏（写了路径就用它），没写（或写的地方没有档案）就从节目目录往上找三层，找到第一个 节目档案/档案.md。

import fs from 'node:fs';
import path from 'node:path';
import { readInfo, infoBlank, readJson, writeJson, fileSha, RATE16, cmd, episode } from './podcast.mjs';
import { isLibRef, libTrack } from './library.mjs';

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
  片头: '（素材/ 里的文件名：固定的片头曲或开场白，放在片头钩子之后、正文之前；没有钩子就放在最前面。没有就空着或写"无"）',
  片尾: '（素材/ 里的文件名：固定的片尾语或片尾曲，放在正文结束之后。没有就空着或写"无"）',
  配乐: '（板块过渡和片头片尾铺底用的音乐：写"默认"用技能自带的 CC0 曲子；写"库:<编号>"固定用曲库里的一首；写 素材/ 里的文件名用自己的；写"无"不加。不固定的话，每期按内容从曲库里挑）',
  配乐署名: '（用自己的音乐时写曲名、作者和授权，会写进简介）',
  片头片尾署名: '（片头、片尾里用了别人的音乐时写曲名、作者和授权，会写进简介；都是自己的、不用署名就写"不用"）',
  响度: '（成品响度，默认 -16 LUFS；平台另有要求再改，比如 -14）',
  人声处理: '（第一期听过处理前后对比后填"处理"或"不处理"；填了以后每期照这个，不再听对比。想重新比，在某一期的编排方案里写 voice）',
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

// 从 start 这个文件夹算起往上找 n 层（start 自己算第 1 层），返回第一个 节目档案/ 文件夹。
// 一期节目找档案（findShowDir）从节目目录的上一层找三层；show.mjs --new、没档案时的建议也用它，范围对得上
export function showUp(start, n) {
  let d = path.resolve(start);
  for (let i = 0; i < n; i++) {
    const c = path.join(d, SHOW_DIR);
    if (fs.existsSync(path.join(c, FILE))) return c;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

// 档案在哪：节目信息.md 里写了就用写的；没写就从节目目录往上找。
// 写了路径但那里没有档案（多半是节目目录挪过，比如按季整理挪进了子文件夹）：不悄悄当成没档案，退回往上找，并在 note 里说清楚（2026-11-22 审查 #55）
export function showRef(e) {
  const v = readInfo(e)['节目档案'];
  if (v === '无') return { dir: null, note: null };
  let note = null;
  if (!infoBlank(v)) {
    const p = path.resolve(e.work, v);
    const dir = path.basename(p) === FILE ? path.dirname(p) : path.basename(p) === SHOW_DIR ? p : path.join(p, SHOW_DIR);
    if (fs.existsSync(path.join(dir, FILE))) return { dir, note: null };
    note = `节目信息.md 的"节目档案"写的是 ${v}，那里找不到 档案.md（节目目录挪过？）`;
  }
  const dir = showUp(path.dirname(e.work), 3);
  if (note) note += dir ? `。现在用的是往上找到的 ${dir}：把这一栏清空（程序会自己往上找），或者改成 ${path.relative(e.work, dir)}` : '。把这一栏改成档案现在的位置，或者清空让程序自己往上找';
  return { dir, note };
}
export const findShowDir = (e) => showRef(e).dir;

// 没找到档案时，status、new 给什么建议（2026-11-22 审查 #28、#60）：
// 上面更远的地方其实有档案，就指过去，不建议再建；上一层还放着别的节目，就别在那里建（几档节目会共用一份档案）
export function noShowHint(e) {
  const parent = path.dirname(e.work);
  const far = showUp(parent, 30);
  if (readInfo(e)['节目档案'] === '无') return `节目信息.md 写了"节目档案：无"，这期不用档案${far ? `；要用上面的 ${path.dirname(far)} 那份，把这一栏改成 ${path.relative(e.work, far)}` : ''}`;
  if (far) return `上面的 ${path.dirname(far)} 有节目档案，但离这期超过三层，没自动用上。是这档节目的话，在 节目信息.md 写"节目档案：${path.relative(e.work, far)}"（或者把这期挪到离它近一点的地方，比如直接放在 ${path.dirname(far)} 下面）；确实是另一档节目，给它单独建一个文件夹再建档案`;
  const name = showNameOf(e);
  const kids = showKids(parent, e.work);
  // 这期节目名还没填（刚 new）：旁边几期的节目名就有两种以上，也算放着别的节目
  const named = kids.eps.filter((x) => x.name);
  const diff = name ? named.filter((x) => x.name !== name) : new Set(named.map((x) => x.name)).size > 1 ? named : [];
  const others = [...kids.shows.map((k) => `节目文件夹「${k}」`), ...diff.map((x) => `「${x.dir}」是${x.name}`)];
  if (others.length) {
    const home = path.join(parent, name ? name.replace(/[\\/:*?"<>|]/g, '_') : '<节目名>');
    return `这期的上一层 ${parent} 里还放着别的节目（${others.join('、')}），不是这档节目专用的文件夹，不要在那里建档案（几档节目会共用一份）。这档节目以后还剪的话：给它单独建一个文件夹（比如 ${home}），把这期挪进去，再运行 ${cmd('show.mjs', '--new', home)}`;
  }
  // 这期节目名还没填，旁边的几期都是同一档（比如刚 new 的第 2 期）：多半是同一档，但说不准，两种都说（2026-11-23 复核 #28）
  if (!name && named.length) {
    const n = named[0].name;
    return `这期的上一层 ${parent} 里还放着「${named.slice(0, 3).map((x) => x.dir).join('」「')}」${named.length > 3 ? `等 ${named.length} 期` : ''}，节目名是${n}。这期也是${n}、以后还剪的话，在上一层建一份：${cmd('show.mjs', '--new', parent)}；是另一档节目的话，不要在那里建（会和${n}共用一份），给它单独建一个文件夹，把这期挪进去再建档案`;
  }
  return `这档节目以后还剪的话，建一份：${cmd('show.mjs', '--new', parent)}；节目文件夹一般是节目目录的上一层`;
}
const showNameOf = (e) => { const v = readInfo(e)['节目名']; return infoBlank(v) || /待确认/.test(v) ? '' : String(v).trim(); };
// dir 下面三层以内的（在 dir 建档案，这些都会往上找到它，和 showUp 的三层对得上）：已经有档案的节目文件夹（shows），各期节目和它们的节目名（eps）。
// dir 是相对 dir 的路径（"第1期"、"无档案\第1期"）。节目文件夹、一期节目里面不再往下看；skip 这个目录不算；
// 写了"节目档案：无"、或者写了别处的档案（那里有）的一期，不会用上 dir 的档案，不算（2026-11-23 复核 #28：别的节目放在子文件夹里也要看见）
export function showKids(dir, skip = null, depth = 3) {
  const shows = [], eps = [];
  const root = path.resolve(dir);
  let queue = [[root, 1]], seen = 0;
  while (queue.length && seen < 3000) {
    const [d, lv] = queue.shift();
    let kids = [];
    try { kids = fs.readdirSync(d, { withFileTypes: true }).filter((x) => x.isDirectory() && x.name !== SHOW_DIR && !x.name.startsWith('.') && x.name !== 'node_modules'); } catch {}
    for (const k of kids) {
      const p = path.join(d, k.name);
      seen++;
      if (skip && p === path.resolve(skip)) continue;
      const rel = path.relative(root, p);
      if (fs.existsSync(path.join(p, SHOW_DIR, FILE))) shows.push(rel);
      else if (fs.existsSync(path.join(p, '节目信息.md'))) {
        const e = episode(p), v = readInfo(e)['节目档案'];
        if (v === '无' || (!infoBlank(v) && showRef(e).dir && !showRef(e).note)) continue;
        eps.push({ dir: rel, name: showNameOf(e) });
      } else if (lv < depth) queue.push([p, lv + 1]);
    }
  }
  return { shows, eps };
}

// 这个目录是不是节目文件夹（下面直接有 节目档案/档案.md）：是的话它不是某一期。start、status、new 拿到它时停下说清楚，
// 不然会说"没有档案"、建议在上一层再建一份，或者把节目文件夹本身当成一期（2026-11-20 审查 F2）
export const isShowFolder = (dir) => fs.existsSync(path.join(path.resolve(dir), SHOW_DIR, FILE));
export function showFolderMsg(dir) {
  const root = path.resolve(dir);
  let eps = [];
  try { eps = fs.readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory() && fs.existsSync(path.join(root, x.name, '节目信息.md'))).map((x) => x.name).sort(); } catch {}
  const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let n = 1; while (fs.existsSync(path.join(root, `${day}_${String(n).padStart(2, '0')}`))) n++;
  const fresh = path.join(root, `${day}_${String(n).padStart(2, '0')}`);
  return `这是节目文件夹（里面放的是这档节目的 节目档案/），不是某一期节目，不要在这里直接开工。\n`
    + (eps.length ? `已有的几期：${eps.join('、')}。继续哪一期，就对那一期运行，比如 ${cmd('start.mjs', path.join(root, eps.at(-1)))}\n` : '')
    + `新的一期建在它下面：${cmd('new.mjs', fresh, '<录音文件>')}（文件夹名可以改，一般是"日期_期号"；"<录音文件>"换成录音的完整路径）`;
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

// 一栏的"头一个词"：去掉后面的标点、括号说明（"无。""没有（以后再加）""不处理，声音本来就好"），只用来认"无""默认""处理"这类字眼
const headWord = (v) => String(v ?? '').trim().split(/[，,。．.;；：:！!？?、\s（(]/)[0].trim();

// 片头、片尾、配乐：返回音频路径；'default' = 技能自带配乐；null = 没有。写了文件名但找不到就报错（不悄悄忽略）
export function showAsset(show, field) {
  const v = show?.get(field);
  if (!v) return field === '配乐' ? 'default' : null;
  const w = headWord(v);
  if (/^(无|没有|不要|不加|不用|不需要|否)$/.test(w)) return null;
  if (field === '配乐' && /^(默认|自带|默认配乐)$/.test(w)) return 'default';
  if (field === '配乐' && isLibRef(v)) return libTrack(v).path; // 技能自带曲库里的一首，写"库:<id>"
  const cands = [path.resolve(show.assets, v), path.resolve(show.dir, v), path.resolve(v)];
  const hit = cands.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (!hit) throw new Error(`节目档案里"${field}"写的是 ${v}，但在 ${show.assets} 里找不到这个文件。把文件放进去，或者改档案。`);
  return hit;
}

// 节目档案记住的人声处理选择：'processed' / 'raw' / null（没记）
// 后面带说明、标点的也认（"处理（第一期听过）""不处理。"）；写了但认不出来的，showVoiceBad 返回原文，status、show 会说出来（2026-11-22 审查 #56）
export function showVoice(show) {
  const v = show?.get('人声处理');
  if (!v) return null;
  const w = headWord(v);
  if (/^(不处理|不要|raw|原声|否)$/i.test(w)) return 'raw';
  if (/^(处理|要|processed|是)$/i.test(w)) return 'processed';
  return null;
}
export const showVoiceBad = (show) => (show?.get('人声处理') && !showVoice(show) ? show.get('人声处理') : null);
export const showVoiceBadMsg = (v) => `节目档案里"人声处理"写的是「${v}」，认不出来，现在按没填算（每期要听对比）。请改成"处理"或"不处理"（后面可以加括号说明）`;
// 这一期实际用哪种：编排方案写了 voice 就听它的；没写看节目档案；都没有默认处理
export const effectiveVoice = (plan, show) => plan?.voice ?? showVoice(show) ?? 'processed';

// 全角数字、全角负号也认；开头留着模板提示"（……）"的去掉再认；写了东西但认不出数字就报错，不悄悄用 -16（2026-11-22 审查 #57）
export function targetLufs(show) {
  const raw = show?.get('响度');
  if (!raw) return -16;
  const v = raw.normalize('NFKC').replace(/[−–—]/g, '-').replace(/^\s*\([^)]*\)\s*/, '');
  if (!v.trim()) return -16; // 只剩括号里的说明
  const n = Number((v.match(/-?\d+(\.\d+)?/) ?? [])[0]);
  // 写"默认""默认值""按默认"（后面带标点、括号说明也行）：就是 -16（2026-11-23 复核：模板提示里写着"默认 -16"，主理人照着写很常见）。
  // 写"无""没有""不用"（"无。""没有（用默认）"也算）：当成没写，也是 -16（references/播客_节目档案.md 说这几个字眼可以带标点；以前 plan 报错退出）
  if (!Number.isFinite(n) && (/^[\s"'“「]*(按|用)?默认/.test(v) || /^(无|没有|不要|不用|不需要|不改|空|空着|否)$/.test(headWord(v.replace(/^[\s"'“「]+/, ''))))) return -16;
  if (!Number.isFinite(n)) throw new Error(`节目档案里的响度写的是「${raw}」，认不出数字。写成 -16 这样的数字（LUFS 可写可不写）；不用改就空着，按默认 -16。`);
  const x = n > 0 ? -n : n; // 写成"16"也当 -16
  if (x < -24 || x > -10) throw new Error(`节目档案里的响度 ${raw} 不合常理：只接受 -24 到 -10 之间（播客一般在 -19 到 -14 LUFS）。`);
  return x;
}

// 片头片尾的长度：读不出来（0 秒）或者太长，plan 和 build 都拦下（2026-11-22 审查 #57）
export const showClipBad = (k, file, dur) => (dur > 0.5 && dur < 180 ? null : `节目档案的${k} ${path.basename(file)} 长 ${dur.toFixed(1)} 秒，读不出来或太长（片头片尾一般几秒到一两分钟）。`);

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
// 每个人从最长的几段里取（长的一段切成每块 15 秒，合计约 60 秒），每块算一个声纹，归一化后平均。
// 2026-11-22 审查 #58：以前每段只取开头 15 秒，一直说话的人（独白、长发言）只用到 15–34 秒，相似度明显偏低。
// 2026-11-18 用 VOL01（65 分钟、十来个人）试：同一编号前后半场相似度中位 0.89、最低 0.72（只有 16 秒的人）；
// 不同的人最高 0.67（被机器拆成两个编号的同一个人在 0.8–0.9）。所以 ≥0.75 算认出，0.62–0.75 算"可能是"。
// 2026-11-22 改成长段切块、合计 60 秒以后（审查 #58），同一份 VOL01 不同的人最高到 0.73（K-M），离 0.75 只差一点：
// 所以还要"明显比档案里别的人更像"（margin）、只记了一个人时要 ≥0.78，才预填
// close：同一个称呼下"有点像"的编号，和认出的那个相差不到这么多，才当成可能认错（冲突）
export const VOICE = { match: 0.75, maybe: 0.62, margin: 0.06, same: 0.78, close: 0.15 };
export function voiceExtractor(sherpa, model, threads) {
  return new sherpa.SpeakerEmbeddingExtractor({ model, numThreads: threads, provider: 'cpu', debug: 0 });
}
export function embedSegments(ex, samples, segs, maxSec = 60) {
  let acc = null, sec = 0;
  for (const s of [...segs].sort((a, b) => (b.end - b.start) - (a.end - a.start))) {
    if (sec >= maxSec) break;
    for (let t = s.start; sec < maxSec; t += 15) {
      const end = Math.min(s.end, t + 15, t + (maxSec - sec));
      if (end - t < 1.5) break;
      const st = ex.createStream();
      st.acceptWaveform({ sampleRate: RATE16, samples: samples.subarray(Math.round(t * RATE16), Math.round(end * RATE16)) });
      st.inputFinished();
      const v = ex.compute(st);
      let nv = 0; for (const x of v) nv += x * x; nv = Math.sqrt(nv) || 1;
      acc ??= new Float64Array(v.length);
      for (let i = 0; i < v.length; i++) acc[i] += v[i] / nv;
      sec += end - t;
    }
  }
  return acc ? { v: unit(acc), sec: +sec.toFixed(1) } : null;
}
export function unit(v) { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return Array.from(v, (x) => +(x / n).toFixed(5)); }
export const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// 旧版（0.7 以前）记的声纹：没有按期分开存（没有 parts），或者还带着旧版的底子（base）。那时每段只取开头 15 秒，和现在的算法不一样
export const oldVoice = (p) => !!p?.v && (!p.parts || !!p.base);
export const oldVoiceHint = (names, work) => `节目档案里 ${names.join('、')} 的声纹是旧版（0.7 以前）记的，现在算声纹的方法改了，用它认人可能不准（认错或认不出），要相似度更高才预填。最好重记：对最近一期认人确认过、${names.length > 1 ? '这几个人' : '这个人'}说了话的节目运行 ${cmd('show.mjs', '--learn', '<那一期>')}，会扔掉旧版的、用那一期重新记（不用先 --forget，也不会叠在旧的上面）`;
export const loadVoices = (show) => (show ? readJson(show.voicesFile, { people: {} }) : { people: {} });
export const saveVoices = (show, data) => writeJson(show.voicesFile, data, 0);

// 每个编号和档案里的每个人比。够像（≥0.75）、而且明显比档案里别的人更像，才算认出。
// 一个人可以认给几个编号：机器常把同一个人拆成两个编号（11-18 下半场实测，乙被拆成 B、F，相似度 0.92、0.87，都对）
// 2026-11-22 审查 #53 补的三条，宁可不填，不乱填：
//   - 档案里和第一名声纹几乎一样（≥0.78）的条目，多半是同一个人记了两个称呼，不算"别人"（dup 里列出来，提醒删掉一个）
//   - 档案里没有别人可比（只记了一个人）时，要 ≥0.78 才算认出
//   - 同一个称呼认给了几个编号，这几个编号彼此要像（≥0.78，机器拆开的同一个人）；不像就说明有人认错了，这几个都不填（conflict，规则见下面）
export function matchVoices(labelEmb, voices) {
  const people = Object.entries(voices.people ?? {}).filter(([, p]) => p?.v);
  const res = {};
  if (!people.length) return res;
  for (const [lab, x] of Object.entries(labelEmb)) {
    if (!x) continue;
    const sims = people.map(([name, p]) => ({ name, v: p.v, sim: cosine(x.v, p.v) })).sort((a, b) => b.sim - a.sim);
    const best = sims[0];
    if (best.sim < VOICE.maybe) continue;
    const dup = sims.slice(1).filter((s) => cosine(s.v, best.v) >= VOICE.same).map((s) => s.name);
    const other = sims.slice(1).find((s) => cosine(s.v, best.v) < VOICE.same);
    const clear = other ? best.sim - other.sim >= VOICE.margin : best.sim >= VOICE.same;
    // 旧版（0.7 以前）记的声纹算法不一样，和新算的比，相似度会偏：要 ≥0.78 才算认出
    const old = oldVoice(voices.people[best.name]);
    res[lab] = { name: best.name, sim: +best.sim.toFixed(2), sure: best.sim >= (old ? VOICE.same : VOICE.match) && clear, ...(dup.length ? { dup } : {}), ...(old ? { old } : {}) };
  }
  // 冲突：同一个称呼下，一个认出的编号和另一个编号彼此明显不像（<0.78，不是机器拆开的同一个人），而另一个编号
  //   - 也认出了，或者
  //   - 只是"有点像"、但和认出的那个差不多像（相差不到 0.15）：档案里这个人的声纹混进过别人的声音（以前记错过、旧版记的），
  //     会出现一个编号 0.82、另一个 0.76，彼此却不像，填上去的可能正好是嘉宾（2026-11-23 复核 #53）
  // 认出的那个明显最像（比如主持人 1.0、某位嘉宾 0.63）不算冲突：嘉宾的声音本来就可能有点像主持人（不同的人最高到 0.7 左右），
  // 主持人照常预填，那个"有点像"的编号只是不填（2026-11-23 合并后修：以前多嘉宾节目里主持人常常一个都不填）
  const groups = {};
  for (const [lab, m] of Object.entries(res)) (groups[m.name] ??= []).push(lab);
  for (const labs of Object.values(groups)) {
    if (labs.length < 2) continue;
    const bad = new Set(); let low = 1;
    for (const a of labs) {
      if (!res[a].sure) continue;
      for (const b of labs) {
        if (b === a) continue;
        const c = cosine(labelEmb[a].v, labelEmb[b].v);
        if (c >= VOICE.same) continue;
        if (!res[b].sure && res[a].sim - res[b].sim >= VOICE.close) continue;
        bad.add(a); bad.add(b); low = Math.min(low, c);
      }
    }
    const blabs = labs.filter((l) => bad.has(l));
    for (const l of blabs) { res[l].sure = false; res[l].conflict = { labs: blabs, sim: +low.toFixed(2) }; }
  }
  return res;
}

// ---- 记声纹（show.mjs --learn）和 status 共用 ----
// 档案.md 里的主持人、常驻嘉宾：记声纹的名单
export const splitNames = (v) => (v || '').split(/[、,，;；\s]+/).map((x) => x.replace(/[（(].*?[)）]/g, '').trim()).filter((x) => x && !/^(无|没有)$/.test(x));
export const regularsOf = (show) => new Set([...splitNames(show?.get('主持人')), ...splitNames(show?.get('常驻嘉宾'))]);
// 这期要记的人：{ 称呼: [编号…] }。names 是 说话人.md 里填的（readNames）；hasEmb(编号)：这个编号有没有声纹（说得太少的没有）
export function learnWant(names, regulars, { all = false, hasEmb = () => true } = {}) {
  const want = {};
  for (const [lab, name] of Object.entries(names)) {
    if (/不确定|不认识|不知道|[?？]/.test(name) || !hasEmb(lab)) continue;
    if (!all && !regulars.has(name)) continue;
    (want[name] ??= []).push(lab);
  }
  for (const k of Object.keys(want)) want[k].sort();
  return want;
}
// 这一期在档案里叫什么：相对节目文件夹的路径（"第二季/第1期"和"第1期"分得开），再记一个录音的指纹（目录改名了也认得出是同一期）
// 2026-11-22 审查 #54：以前只按目录名认，不同季的同名一期会当成记过，改名后同一期会记两次
export function episodeKey(e, show) {
  const rel = path.relative(path.dirname(show.dir), e.work).split(path.sep).join('/');
  return { ep: rel || path.basename(e.work), wav: readJson(path.join(e.mid, '录音.json'), {}).wav16sha ?? null };
}
// 这个人在这期记的那一份：按路径找；找不到再按录音指纹找原来那个目录已经不在了的（这期改过名）
const epThere = (show, ep) => fs.existsSync(path.join(path.dirname(show.dir), ep, '节目信息.md'));
export const findPart = (person, key, show) => person?.parts?.find((p) => p.ep === key.ep) ?? (key.wav ? person?.parts?.find((p) => p.wav === key.wav && !epThere(show, p.ep)) : undefined);
// 同一份录音的另一期（拷贝出来的）记过了：不重复记
export const copyPart = (person, key, show) => (key.wav ? person?.parts?.find((p) => p.wav === key.wav && p.ep !== key.ep && epThere(show, p.ep)) : undefined);
// 旧版（没有按期分开存）记过这期：只能按目录名认
export const legacyHas = (person, e) => (person?.parts ? person.base?.episodes ?? [] : person?.episodes ?? []).includes(path.basename(e.work));
// 记这期时，称呼和编号的对应（加上分说话人结果的指纹）：变了就要把这期那份换掉
export const learnSig = (diarSha, labs) => `${diarSha}|${labs.join(',')}`;
// 一个人的声纹 = 各期按顺序合起来（旧的最多按 5 分钟算权重：声音会随设备、环境变，新的几期要有分量）
export function foldVoice(person) {
  const items = [...(person.base ? [person.base] : []), ...(person.parts ?? [])];
  let acc = null, sec = 0;
  for (const it of items) {
    if (!acc) { acc = Array.from(it.v); sec = it.sec; continue; }
    const w0 = Math.min(sec, 300), w1 = it.sec;
    acc = acc.map((x, i) => x * w0 + it.v[i] * w1);
    sec += it.sec;
  }
  if (!acc) return null;
  return { v: unit(acc), sec: +sec.toFixed(1), episodes: [...(person.base?.episodes ?? []), ...(person.parts ?? []).map((p) => p.ep)] };
}
// status 用：这期该记的人记了没有、记的还是不是现在的称呼
export function learnStatus(e, show, voices, names, { hasEmb } = {}) {
  const regulars = regularsOf(show);
  const want = learnWant(names, regulars, { hasEmb });
  const people = voices.people ?? {};
  const key = episodeKey(e, show), diarSha = fileSha(e.diar);
  const changed = [];
  const missing = Object.keys(want).filter((n) => {
    if (copyPart(people[n], key, show)) return false;
    const part = findPart(people[n], key, show);
    if (part && part.sig !== learnSig(diarSha, want[n])) changed.push(n);
    return part ? part.sig !== learnSig(diarSha, want[n]) : !legacyHas(people[n], e);
  });
  const extra = Object.keys(people).filter((n) => findPart(people[n], key, show) && !Object.values(names).includes(n));
  return { regulars, want, missing, changed, extra };
}
