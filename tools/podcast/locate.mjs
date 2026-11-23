#!/usr/bin/env node
// 精编版里的时间点 → 原录音：主理人说"精编版 12:30 那句"时，查出原录音的时间、第几句、原文、在哪个板块。
//
//   node tools/podcast/locate.mjs <节目目录> 12:30 [12:45 1:02:03 750 12分30秒 ...]
//
// 按 精编版/剪辑表.json 的 items 换算：每段 clip 记着在精编版里的位置（out）和在原录音里的位置（src），一段之内是原录音连续的一截。
// 落在配乐、节目片头片尾、板块之间的空当上，也说清楚是什么。只读，不改任何文件。

import path from 'node:path';
import { episode, mustExist, loadFull, readJson, fileSha, fmt, planSha, loadPlan, planBadMsg, cmd, recParts, inFile } from '../lib/podcast.mjs';

const [dir, ...times] = process.argv.slice(2);
if (!dir || !times.length) { console.error(`用法: ${cmd('locate.mjs')} <节目目录> <精编版里的时间点> [更多时间点……]，时间写成 12:30、1:02:03、750（秒）、12分30秒 或 1小时2分`); process.exit(2); }
mustExist(dir);
const e = episode(dir);
const edl = readJson(path.join(e.out, '剪辑表.json'), null);
if (!edl?.items) { console.error(`还没有精编版（精编版/剪辑表.json）。先运行 ${cmd('finish.mjs', e.work)}`); process.exit(1); }
let full;
try { full = loadFull(e); } catch (err) { console.error(err.message); process.exit(1); }

// "12:30" "1:02:03" "750" "12分30秒" "1小时2分" "1小时零20秒" → 秒。冒号后面的数、跟在小时/分后面的分和秒都要小于 60，不对就说看不懂，不瞎换算
function parseTime(s) {
  const t = String(s).trim().replace(/：/g, ':').replace(/\s+/g, '');
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^\d+(:\d+(\.\d+)?){1,2}$/.test(t)) {
    const xs = t.split(':').map(Number);
    return xs.slice(1).some((x) => x >= 60) ? null : xs.reduce((a, x) => a * 60 + x, 0);
  }
  const m = t.match(/^(?:(\d+)个?(?:小时|钟头|时))?零?(?:(\d+)分钟?)?零?(?:(\d+(?:\.\d+)?)(秒钟?)?)?$/);
  if (!m || (m[1] == null && m[2] == null && m[3] == null)) return null;
  if (m[3] != null && !m[4] && m[2] == null) return null; // "1小时30"：30 是分还是秒说不清
  const h = Number(m[1] ?? 0), mi = Number(m[2] ?? 0), se = Number(m[3] ?? 0);
  if ((m[1] != null && mi >= 60) || ((m[1] != null || m[2] != null) && se >= 60)) return null;
  return h * 3600 + mi * 60 + se;
}

const clips = edl.items.filter((x) => x.kind === 'clip');
// 几个录音前后接着拼起来的：原录音时间是拼起来以后的，后面再说是哪个文件第几秒（只有一个文件时不说）
const rp = recParts(e);
const inParen = (t) => inFile(rp, t).replace(/^（(.*)）$/, '，$1'); // 已经在括号里的：不再套一层括号
const length = edl.length ?? edl.voiceEnd + (edl.tail ?? 11);
const { plan, bad: planBad } = loadPlan(e);
const notes = [];
if (planBad) notes.push(`${planBadMsg(planBad)}。下面不看方案，只按剪辑表算；方案改好再运行 ${cmd('plan.mjs', e.work)}`);
if (plan && edl.plan !== planSha(plan, 'audio') && edl.plan !== fileSha(e.plan)) notes.push('编排方案在剪完之后改过（板块、句子范围、配乐或人声处理），精编版不是最新的。下面按现有的这版精编版算；重新剪之后时间点会变。');

// 片头钩子：剪辑表里记着（hook: true）；旧剪辑表没记，按位置认——钩子都在第一个"钩子后的配乐"或节目片头之前。不看现在的方案（方案可能改过、写坏了）
const hookEnd = Math.min(...edl.items.filter((x) => x.kind === 'swell' || (x.kind === 'asset' && x.name === 'intro')).map((x) => x.at));
const isHook = (c) => c.hook === true || (Number.isFinite(hookEnd) && c.out[1] <= hookEnd + 0.01);

// 剪的时候每段记了句子编号（ids）：拿现在的全文核一下，编号对不上就是剪完之后重新识别过
const byId = new Map(full.map((s) => [s.id, s]));
const offIds = (c) => { const s = byId.get(c.ids?.[0]); return !c.ids || !s || c.src[0] < s.start - 1.5 || c.src[0] > s.end + 0.5; };
const shifted = clips.filter((c) => c.ids && offIds(c)).length;
if (shifted) notes.push(`全文在剪完之后重新识别过（${shifted} 段的句子编号和剪的时候对不上）。下面的编号按现在的全文算；编排方案要先按 plan.mjs 的提示改好编号再改。`);

// 原录音里某个时间点落在哪一句：在句子里就是那句；在两句之间的停顿里，取近的那句
function sentenceAt(x) {
  let best = null, dist = Infinity;
  for (const s of full) {
    const d = x < s.start ? s.start - x : x > s.end ? x - s.end : 0;
    if (d < dist) { dist = d; best = s; }
    if (s.start > x + 30) break;
  }
  return { s: best, dist };
}
// 原文里标出这个时间点说到哪个字（▲），前后各带十几个字
function mark(s, x) {
  let k = 0;
  s.toks.forEach((t, i) => { if (t.s <= x) k = i; });
  const before = s.toks.slice(0, k).map((t) => t.t).join(''), after = s.toks.slice(k).map((t) => t.t).join('');
  return `${before.length > 16 ? `……${before.slice(-16)}` : before}▲${after.length > 20 ? `${after.slice(0, 20)}……` : after}`;
}
// 剪辑表里这一段的句子编号还可信（剪完之后没重新识别过）时，只在这一段剪进去的句子里找：
// 每段两头垫了零点几秒，垫音落在相邻（已删掉的）句子边上，按全文找最近会认成那句
const idsOk = (c) => !!c?.ids && !offIds(c);
function sentenceIn(x, c) {
  if (!idsOk(c)) return sentenceAt(x);
  let best = null, dist = Infinity;
  for (let id = c.ids[0]; id <= c.ids[1]; id++) { const s = byId.get(id); if (!s) continue; const d = x < s.start ? s.start - x : x > s.end ? x - s.end : 0; if (d < dist) { dist = d; best = s; } }
  return best ? { s: best, dist } : sentenceAt(x);
}
const firstOf = (c) => (idsOk(c) ? byId.get(c.ids[0]) : sentenceAt(c.src[0] + 0.05).s);
const lastOf = (c) => (idsOk(c) ? byId.get(c.ids[1]) : sentenceAt(c.src[1] - 0.05).s);
// 剪口另一边那句的时间：片段起止带着前后留的余量（比句子早、晚零点几秒），换文件的地方按片段起止认文件会认成前一个文件。
// 夹到这句话里面（句末再往里 0.1 秒）再标时间和文件（2026-11-24 第 3 轮 13）
const edgeOf = (s, t) => (s ? Math.min(Math.max(t, s.start), Math.max(s.start, s.end - 0.1)) : t);
const tail = (s) => { const t = s.text.replace(/[，。！？、；：,.!?;:]+$/, ''); return t.length > 12 ? `……${t.slice(-12)}` : t; };
const head = (s) => { const t = s.text; return t.length > 12 ? `${t.slice(0, 12)}……` : t; };
// 每段配乐是哪一处：剪辑表记着 part；v0.5.2 以前的剪辑表没记，按位置推：最开头的是片头，压着人声结尾的是片尾，和板块过渡重叠的是过渡
const transitions = edl.items.filter((x) => x.kind === 'transition');
const firstVoice = clips[0]?.out[0] ?? 0;
const partOf = (p) => p.part ?? (p.at < 1 || p.at <= firstVoice ? '片头'
  : edl.voiceEnd != null && p.at + p.dur >= edl.voiceEnd && p.at >= edl.voiceEnd - 3 ? '片尾'
    : transitions.some((x) => p.at < x.at + x.dur && x.at < p.at + p.dur) ? '过渡' : null);
const musicUnder = (t) => [...new Set((edl.music ?? []).filter((p) => p.at <= t && t < p.at + p.dur).map(partOf))];
const musicName = (k) => (k ? `${k}音乐` : '配乐'); // 推不出是哪一处的，只说"配乐"

function locate(t) {
  const out = [];
  const c = clips.find((x) => x.out[0] <= t && t < x.out[1]);
  if (c) {
    const x = c.src[0] + (t - c.out[0]);
    const { s, dist } = sentenceIn(x, c);
    const hook = isHook(c);
    // 几个小话题并成一段的：按这句的编号找它属于哪个小话题（剪辑表的 labels；旧剪辑表没记，只有第一个的 label）
    const label = (idsOk(c) && c.labels?.find(([a, b]) => s.id >= a && s.id <= b)?.[2]) || c.label;
    out.push(`精编版 ${fmt(t)} → 原录音 ${fmt(x)}${inFile(rp, x)}，第 ${s.id} 句${dist > 0.3 ? '（这里是句子前后的停顿）' : ''}；板块「${c.section}」${label ? `·「${label}」` : ''}${hook ? '（片头钩子）' : ''}`);
    out.push(`  原文〔${s.id}〕${s.speaker ? ` ${s.speaker}${s.name ? `（${s.name}）` : ''}` : ''}：${dist > 0.3 ? s.text : mark(s, x)}`);
    if (hook) {
      const body = clips.find((b) => !isHook(b) && b.src[0] <= x && x < b.src[1]);
      out.push(body ? `  这句在正文里还会出现：精编版 ${fmt(body.out[0] + x - body.src[0])}（板块「${body.section}」）` : '  这句只在片头用了，正文里没有（正文删掉了）');
    }
    const under = musicUnder(t);
    if (under.length) out.push(`  下面垫着${under.map(musicName).join('、')}`);
    // 离剪口近：说清楚剪口两边各是哪句、中间删了哪几句（按两段记的句子编号算），主理人说"这里接得别扭"时直接对上
    const i = clips.indexOf(c), prev = clips[i - 1], next = clips[i + 1];
    if (t - c.out[0] < 2 && prev) {
      const ps = lastOf(prev), cs = firstOf(c);
      const glued = Math.abs(prev.out[1] - c.out[0]) < 0.01;
      out.push(`  离剪口 ${(t - c.out[0]).toFixed(1)} 秒：${glued ? '紧接在' : `前面隔着 ${(c.out[0] - prev.out[1]).toFixed(1)} 秒空当，再往前是`}第 ${ps.id} 句「${tail(ps)}」（原录音 ${fmt(edgeOf(ps, prev.src[1]))}${inParen(edgeOf(ps, prev.src[1]))}）后面${glued && ps.id + 1 < cs.id ? `，中间删掉了第 ${ps.id + 1}–${cs.id - 1} 句` : ''}`);
    } else if (c.out[1] - t < 2 && next) {
      const ns = firstOf(next), cs = lastOf(c);
      out.push(`  离剪口 ${(c.out[1] - t).toFixed(1)} 秒：后面接的是第 ${ns.id} 句「${head(ns)}」（原录音 ${fmt(edgeOf(ns, next.src[0]))}${inParen(edgeOf(ns, next.src[0]))}）${ns.id > cs.id + 1 ? `，中间删掉了第 ${cs.id + 1}–${ns.id - 1} 句` : ''}`);
    }
    return out;
  }
  // 不在人声里：节目片头片尾、配乐、空当
  const asset = (edl.assets ?? []).find((a) => a.at <= t && t < a.at + a.dur);
  const prev = [...clips].reverse().find((x) => x.out[1] <= t), next = clips.find((x) => x.out[0] > t);
  const near = `${prev ? `前面是第 ${lastOf(prev).id} 句（精编版 ${fmt(prev.out[1])} 结束）` : ''}${prev && next ? '，' : ''}${next ? `后面是第 ${firstOf(next).id} 句（精编版 ${fmt(next.out[0])} 开始）` : ''}`;
  const nm = (a) => (a.name === 'intro' ? '节目片头' : '节目片尾');
  const after = (edl.assets ?? []).find((a) => a.at + a.dur <= t && t - a.at - a.dur < 1.5), before = (edl.assets ?? []).find((a) => a.at > t && a.at - t < 1.5);
  let what;
  if (asset) what = `${nm(asset)}（节目档案里的 ${asset.file}），放到第 ${(t - asset.at).toFixed(0)} 秒，不是录音里的内容`;
  else if (after) what = `${nm(after)}刚放完，${after.name === 'intro' ? '接正文前' : '结尾'}留的一点空当`;
  else if (before) what = `${nm(before)}开始前留的一点空当`;
  else if (t >= edl.voiceEnd) { const u = musicUnder(t); what = `人声在 ${fmt(edl.voiceEnd)} 已经结束，这里是结尾${u.includes('片尾') ? '的片尾音乐' : u.length ? `，下面垫着${u.map(musicName).join('、')}` : '留的安静'}`; }
  else {
    const it = edl.items.find((x) => (x.kind === 'swell' || x.kind === 'transition') && x.at <= t && t < x.at + x.dur);
    const under = musicUnder(t);
    if (it?.kind === 'swell') what = '片头几句原话之后的配乐（钩子和正文之间）';
    else if (it?.kind === 'transition') what = `板块之间的过渡${under.includes('过渡') ? '音乐' : under.length ? `（下面垫着${under.map(musicName).join('、')}）` : '空当'}（「${prev?.section}」→「${next?.section}」）`;
    else if (!prev) what = `节目最开头的空当${under.length ? `，${under.map(musicName).join('、')}铺底` : ''}`;
    else what = `两段之间 ${((next?.out[0] ?? edl.voiceEnd) - prev.out[1]).toFixed(1)} 秒的空当（「${prev.section}」${next && next.section !== prev.section ? `→「${next.section}」` : '里'}）${under.length ? `，下面垫着${under.map(musicName).join('、')}` : ''}`;
  }
  return [`精编版 ${fmt(t)} → 不是人声：${what}`, ...(near ? [`  ${near}`] : [])];
}

console.log(`精编版 ${fmt(length)}，${clips.length} 段；原录音 ${fmt(full.at(-1).end)}，${full.length} 句。${rp ? `原录音是 ${rp.length} 个文件前后接着拼起来的（${rp.map((p) => `${p.name} 从 ${fmt(p.start)} 起`).join('、')}），下面的原录音时间是拼起来以后的，括号里是哪个文件第几秒。` : ''}`);
for (const n of notes) console.log(`△ ${n}`);
let bad = 0;
for (const raw of times) {
  const t = parseTime(raw);
  console.log('');
  if (t == null) { console.log(`看不懂时间「${raw}」：写成 12:30、1:02:03、750（秒）、12分30秒 或 1小时2分（冒号后面、分和秒都要小于 60；数字用阿拉伯数字）`); bad++; continue; }
  if (t < 0 || t > length) { console.log(`精编版 ${fmt(t)} 超出了精编版的长度（${fmt(length)}）`); bad++; continue; }
  for (const l of locate(t)) console.log(l);
}
console.log(`\n要删、要留、要挪：按上面的句子编号改 编排方案.json，运行 ${cmd('plan.mjs', e.work)}，把改过的 编排方案.md 给主理人看，他同意后运行 ${cmd('status.mjs', e.work, '--confirm', '编排')}，再 ${cmd('finish.mjs', e.work)}（不重新确认编排，finish 不剪）`);
process.exit(bad ? 1 : 0);
