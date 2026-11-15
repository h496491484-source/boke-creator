#!/usr/bin/env node
// 把 timeline.json 生成成可渲染的页面。零依赖，Node 18+。
//
//   node build.mjs <timeline.json> --out <作品渲染目录> [--template <模板目录>]
//
// 输出目录里会有 index.html、style.css、assets/、voice.wav、timeline.built.json。
// 如果目录里已有上一次的 timeline.built.json，会比较两次的差别，告诉你只需重渲哪一段。
// 页面结构：静态 DOM + 一条暂停的 GSAP 时间线，window.__seek 只推进时间、不返回 timeline 对象
// （返回 timeline 对象会让 OpenEdit 首次渲染卡住，2026-11-14 实测）。
//
// 画面节点有四种（稿子里的记号）：
//   @字    一行金字加下划线            @大字  更大的字，给金句和结论
//   @对比  上面一行划掉、下面一行亮起   @步骤  连着的几条累加成带序号的清单
// 一个节点从它出现一直显示到下一个节点出现；连着的 @步骤 算一块，整块一起消失。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const tlFile = args.find((a, i) => !a.startsWith('--') && !['--out', '--template'].includes(args[i - 1]));
const outDir = opt('--out');
const tplDir = opt('--template', path.join(here, '..', 'template', '黑金水墨'));
if (!tlFile || !outDir) {
  console.error('用法: node build.mjs <timeline.json> --out <作品渲染目录> [--template <模板目录>]');
  process.exit(2);
}

const tl = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
const D = tl.canvas.duration;
const { width: W, height: H, fps } = tl.canvas;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TONE = { 淡: 'tone-light', 暗: 'tone-dark', 灰: 'tone-grey' };

// 字幕里的关键词换色：按出现位置从左到右包一层 span，重叠的后者跳过
function captionHtml(text, keywords) {
  const marks = [];
  for (const kw of keywords ?? []) {
    let from = 0, at;
    while ((at = text.indexOf(kw.word, from)) >= 0) { marks.push({ at, end: at + kw.word.length, color: kw.color }); from = at + kw.word.length; }
  }
  marks.sort((a, b) => a.at - b.at);
  let html = '', pos = 0;
  for (const m of marks) {
    if (m.at < pos) continue;
    html += esc(text.slice(pos, m.at)) + `<span class="kw"${m.color ? ` style="color:${esc(m.color)}"` : ''}>${esc(text.slice(m.at, m.end))}</span>`;
    pos = m.end;
  }
  return html + esc(text.slice(pos));
}

// 把时间线里的画面节点排成"块"：一块就是内容区里同时显示的一组东西
function toBlocks(timeline) {
  const blocks = [];
  for (const s of timeline.scenes) for (const it of s.items) {
    const kind = it.kind ?? '字', prev = blocks.at(-1);
    if (kind === '步骤' && prev?.kind === '步骤' && prev.scene === s.id) { prev.rows.push({ at: it.at, text: it.text }); continue; }
    if (kind === '步骤') blocks.push({ kind, scene: s.id, at: it.at, rows: [{ at: it.at, text: it.text }] });
    else if (kind === '对比') blocks.push({ kind, scene: s.id, at: it.at, left: it.left, right: it.right });
    else blocks.push({ kind, scene: s.id, at: it.at, text: it.text, ...(it.tone ? { tone: it.tone } : {}) });
  }
  const total = timeline.canvas.duration;
  blocks.forEach((b, i) => { b.until = i + 1 < blocks.length ? blocks[i + 1].at : total; });
  return blocks;
}

function blockHtml(b, i) {
  const id = `item-${i}`;
  if (b.kind === '步骤') {
    return `<div id="${id}" class="item steps">${b.rows.map((r, j) => `<div id="${id}-r${j}" class="step"><span class="step-n">${j + 1}</span><span class="step-t">${esc(r.text)}</span></div>`).join('')}</div>`;
  }
  if (b.kind === '对比') {
    return `<div id="${id}" class="item vs"><div class="vs-a"><span class="vs-a-text">${esc(b.left)}<i class="vs-strike"></i></span></div><div class="vs-b">${esc(b.right)}</div><div class="item-underline"></div></div>`;
  }
  const cls = ['item', b.kind === '大字' ? 'big' : '', TONE[b.tone] ?? ''].filter(Boolean).join(' ');
  return `<div id="${id}" class="${cls}"><div class="item-word">${esc(b.text)}</div>${b.kind === '大字' ? '' : '<div class="item-underline"></div>'}</div>`;
}

const blocks = toBlocks(tl);
const headings = tl.scenes.map((s) => ({ start: s.start, end: s.end }));
const captions = tl.captions.map((c) => ({ id: c.id, start: c.start, end: c.end }));
// 页面脚本只需要时间和种类，文字已经在 DOM 里
const cues = blocks.map((b) => ({ k: b.kind, at: b.at, until: b.until, ...(b.rows ? { rows: b.rows.map((r) => r.at) } : {}) }));
const accent = /^#[0-9a-fA-F]{6}$/.test(tl.accent ?? '') ? tl.accent : null;

const html = `<!doctype html><html lang="zh-CN" data-resolution="portrait"><head><meta charset="utf-8"><meta name="viewport" content="width=${W},height=${H}"><script src="assets/gsap.min.js"></script><link rel="stylesheet" href="style.css">${accent ? `<style>:root{--keyword:${accent}}</style>` : ''}</head>
<body><main id="stage" data-stage data-stateless data-composition-id="main" data-start="0" data-duration="${D}" data-width="${W}" data-height="${H}" data-fps="${fps}">
<svg class="ink" data-layout-ignore viewBox="0 0 1080 1920"><path class="wide" d="M-100 1100 Q380 760 1180 1120"/><path d="M-100 1090 Q380 750 1180 1110"/><path d="M-100 1110 Q380 770 1180 1130"/><path d="M-100 1650 Q620 1300 1180 1700"/></svg>
<div class="scene-content" data-safe><div class="brand">${esc(tl.brand ?? '')}</div><h1 class="title">${esc(tl.title)}</h1><div class="rule"></div><div class="concept"><div class="heading-stage">${
  tl.scenes.map((s, i) => `<div id="heading-${i}" class="heading">${esc(s.heading)}</div>`).join('\n')
}</div><div class="item-stage">${blocks.map(blockHtml).join('\n')}</div></div></div>
${tl.captions.map((c) =>
  `<div id="${esc(c.id)}" class="caption clip" data-safe data-captions data-start="${c.start}" data-duration="${(c.end - c.start).toFixed(3)}" data-track-index="3"><span class="caption-inner">${captionHtml(c.text, c.keywords)}</span></div>`).join('\n')}
<audio id="narration" src="voice.wav" data-start="0" data-duration="${D}" data-track-index="5" data-volume="1"></audio></main>
<script>
const D=${D};
const headings=${JSON.stringify(headings)};
const cues=${JSON.stringify(cues)};
const captions=${JSON.stringify(captions)};
const tl=gsap.timeline({paused:true});
const IN={immediateRender:true};
tl.from('.brand',{y:12,duration:.4,ease:'sine.out'},.1);
tl.from('.title',{y:22,duration:.55,ease:'power3.out'},.16);
tl.from('.rule',{scaleX:0,duration:.5,ease:'expo.out'},.25);
headings.forEach((c,i)=>{tl.fromTo('#heading-'+i,{opacity:0,y:12},{opacity:1,y:0,duration:.32,ease:'power2.out',...IN},c.start+.06);if(i<headings.length-1)tl.to('#heading-'+i,{opacity:0,duration:.2,ease:'sine.in'},c.end-.2);});
cues.forEach((c,i)=>{
  const el='#item-'+i, last=i===cues.length-1, span=c.until-c.at;
  if(c.k==='步骤'){
    tl.fromTo(el,{opacity:0},{opacity:1,duration:.05,...IN},c.at);
    c.rows.forEach((at,j)=>{
      const row=el+'-r'+j;
      tl.fromTo(row,{opacity:0,x:-22},{opacity:1,x:0,duration:.34,ease:'power3.out',...IN},at);
      if(j<c.rows.length-1)tl.to(row,{opacity:.42,duration:.25,ease:'sine.out'},c.rows[j+1]);
    });
  }else if(c.k==='对比'){
    const d=Math.min(.55,span*.35);
    tl.fromTo(el,{opacity:0},{opacity:1,duration:.05,...IN},c.at);
    tl.fromTo(el+' .vs-a',{opacity:0,x:-18},{opacity:1,x:0,duration:.3,ease:'power2.out',...IN},c.at);
    tl.fromTo(el+' .vs-strike',{scaleX:0},{scaleX:1,duration:.28,ease:'power2.inOut',...IN},c.at+d*.55);
    tl.to(el+' .vs-a',{opacity:.5,duration:.25,ease:'sine.out'},c.at+d*.55);
    tl.fromTo(el+' .vs-b',{opacity:0,y:22},{opacity:1,y:0,duration:.36,ease:'power3.out',...IN},c.at+d);
    tl.fromTo(el+' .item-underline',{scaleX:0},{scaleX:1,duration:.4,ease:'expo.out',...IN},c.at+d+.1);
  }else if(c.k==='大字'){
    tl.fromTo(el,{opacity:0,scale:1.1,y:10},{opacity:1,scale:1,y:0,duration:.42,ease:'power3.out',...IN},c.at);
  }else{
    tl.fromTo(el,{opacity:0,y:24},{opacity:1,y:0,duration:.36,ease:'power3.out',...IN},c.at);
    tl.fromTo(el+' .item-underline',{scaleX:0},{scaleX:1,duration:.4,ease:'expo.out',...IN},c.at+.1);
  }
  if(!last)tl.to(el,{opacity:0,duration:.18,ease:'sine.in'},c.until-.18);
});
captions.forEach(c=>{tl.fromTo('#'+c.id,{opacity:0,y:12},{opacity:1,y:0,duration:.12,ease:'power2.out',...IN},c.start);tl.set('#'+c.id,{opacity:0},c.end);});
window.__timelines=window.__timelines||{};window.__timelines.main=tl; window.__seek=(t)=>{tl.seek(t,false);};
</script></body></html>
`;

// ---- 和上一次构建比较，算出需要重渲的时间段 ----
const PAD = 0.6; // 动画会比节点时间早晚各伸出一点
const builtFile = path.join(outDir, 'timeline.built.json');
let patch = null, why = '首次构建';
if (fs.existsSync(builtFile) && fs.existsSync(path.join(outDir, 'index.html'))) {
  let old = null;
  try { old = JSON.parse(fs.readFileSync(builtFile, 'utf8')); } catch { /* 读不了就整片重渲 */ }
  const oldBlocks = old ? toBlocks(old) : [];
  const sameShell = old && old.title === tl.title && old.brand === tl.brand && (old.accent ?? null) === (tl.accent ?? null)
    && JSON.stringify(old.canvas) === JSON.stringify(tl.canvas)
    && old.captions.length === tl.captions.length && old.scenes.length === tl.scenes.length
    && oldBlocks.length === blocks.length; // 某一块换了样式或文字没关系，只重渲它显示的那几秒
  if (!sameShell) why = '标题、强调色、时长，或句子和画面节点的数量变了';
  else {
    const spans = [];
    old.captions.forEach((o, i) => { const n = tl.captions[i]; if (JSON.stringify(o) !== JSON.stringify(n)) spans.push([Math.min(o.start, n.start), Math.max(o.end, n.end)]); });
    old.scenes.forEach((o, i) => {
      const n = tl.scenes[i];
      if (o.heading !== n.heading || o.start !== n.start || o.end !== n.end) spans.push([Math.min(o.start, n.start), Math.max(o.end, n.end)]);
    });
    oldBlocks.forEach((o, i) => { const n = blocks[i]; if (JSON.stringify(o) !== JSON.stringify(n)) spans.push([Math.min(o.at, n.at), Math.max(o.until, n.until)]); });
    if (!spans.length) { patch = 'none'; why = '和上一次构建相比没有变化'; }
    else {
      patch = { from: Math.max(0, Math.round((Math.min(...spans.map((s) => s[0])) - PAD) * 100) / 100), to: Math.min(D, Math.round((Math.max(...spans.map((s) => s[1])) + PAD) * 100) / 100) };
      why = `有 ${spans.length} 处变化`;
    }
  }
}

// ---- 写文件 ----
fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
const sameFile = (a, b) => { try { const x = fs.statSync(a), y = fs.statSync(b); return x.size === y.size && y.mtimeMs >= x.mtimeMs; } catch { return false; } };
const copyIfChanged = (src, dst) => { if (!sameFile(src, dst)) fs.copyFileSync(src, dst); };
// 样式文件改了也要整片重渲（模板升级后旧片段不能复用）
const cssSrc = path.join(tplDir, 'style.css'), cssDst = path.join(outDir, 'style.css');
if (fs.existsSync(cssDst) && fs.readFileSync(cssSrc, 'utf8') !== fs.readFileSync(cssDst, 'utf8')) { patch = null; why = '模板样式变了'; }
fs.copyFileSync(cssSrc, cssDst);
for (const f of fs.readdirSync(path.join(tplDir, 'assets'))) copyIfChanged(path.join(tplDir, 'assets', f), path.join(outDir, 'assets', f));
if (tl.audio) {
  const src = path.resolve(path.dirname(path.resolve(tlFile)), tl.audio), dst = path.join(outDir, 'voice.wav');
  if (!fs.existsSync(dst) || !fs.readFileSync(src).equals(fs.readFileSync(dst))) fs.copyFileSync(src, dst);
}
fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');
fs.writeFileSync(builtFile, JSON.stringify(tl, null, 2) + '\n', 'utf8');
// 给 make.mjs 读：patch 为 null（要整片渲染）、"none"（不用重渲）或 {from, to}
fs.writeFileSync(path.join(outDir, 'build-result.json'), JSON.stringify({ patch, why, duration: D, fps }) + '\n', 'utf8');

const nodes = blocks.reduce((n, b) => n + (b.rows?.length ?? 1), 0);
console.log(`已生成 ${path.join(outDir, 'index.html')}（${tl.captions.length} 条字幕，${nodes} 个画面节点，${D} 秒）。`);
if (patch === 'none') console.log(`${why}，不需要重渲。`);
else if (patch) console.log(`${why}，只需重渲 ${patch.from}–${patch.to} 秒：render 时加 --from ${patch.from} --to ${patch.to}`);
else console.log(`${why}，需要整片渲染。`);
