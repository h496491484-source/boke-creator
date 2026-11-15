// 解析带记号的口播稿（沿用 2026-10 槐安旧流程的写法），产出分镜数据。
//
// 稿子长这样：
//   标题：让观点落地            ← 头部，一行一项；// 开头是注释
//   署名：槐安 · 访谈研究
//   读音：当真=荡真，在转=在赚   ← 屏幕字=读法，配音读右边，字幕显示左边
//   配音：voice.wav             ← 可省，默认 voice.wav
//   时间轴：timing.json         ← 可省，默认 timing.json
//   ---
//   # 小标题                    ← 单独一行：从下一句起换场
//   正文里 *金字* 是字幕里换色的关键词，【大字】是说到这里时画面出现的大字。
//   @字 画面上的一行字           ← 单独一行：下一个字开口时出现
//   @大字 画面上的大字           ← 金句、结论：字更大
//   @对比 旧说法 | 新说法        ← 上面一行划掉，下面一行亮起来
//   @步骤 第一步做什么           ← 连着写几行，画面上一条一条累加成清单（一组最多 4 条）
//   空一行 = 分段（一个配音分段）
// 头部还可以写 强调色：#d9b566（关键词和画面字的颜色）。
//
// 字幕按标点切开（，。！？；：），顿号不切；想在别处切开就写一个 /。屏幕上不显示标点。
// 2026-11-14 用旧流程第 01、02 期的稿子和时间轴核对过：切出的字幕、换场位置、大字和画面文字的出现时间都和旧结果一致。

// 切字幕的标点。顿号不切（和旧流程一致："一百年、八百年"是一条）；要在别处强行切开，写一个 /
const SPLIT = new Set([...'，。！？；：…,.!?;:/']);
const isPunct = (ch) => /[\s\p{P}\p{S}]/u.test(ch);
const isAsciiWord = (ch) => ch != null && /[A-Za-z0-9]/.test(ch);
const isDigit = (ch) => ch != null && /[0-9０-９]/.test(ch);
const TONES = new Set(['淡', '暗', '灰']); // 旧流程里大字的三种弱化色调
const HEAD = { 标题: 'title', 署名: 'brand', 封面: 'cover', 水印: 'watermark', 发布: 'publish', 配音: 'audio', 时间轴: 'timing', 读音: 'say', 模板: 'template', 强调色: 'accent' };

export function parseScript(src) {
  const errors = [], warnings = [];
  const lines = src.replace(/^﻿/, '').split(/\r?\n/);
  const meta = {};
  const sep = lines.findIndex((l) => l.trim() === '---');
  if (sep >= 0) {
    lines.slice(0, sep).forEach((l, i) => {
      const t = l.trim();
      if (!t || t.startsWith('//')) return;
      const m = t.match(/^([^：:]+)[：:](.*)$/);
      if (!m || !HEAD[m[1].trim()]) { warnings.push(`头部第 ${i + 1} 行看不懂，已忽略：${t}`); return; }
      meta[HEAD[m[1].trim()]] = m[2].trim();
    });
  }
  const sayMap = (meta.say ? meta.say.split(/[，,]/) : []).map((p) => p.split('=').map((s) => s.trim())).filter((p) => p[0] && p[1]);

  const pieces = [];
  // pos：每个字在稿子里的位置 [行号, 这一行里第几个字]，给 beats.mjs 往稿子里插记号用
  const fresh = () => ({ chars: [], pos: [], keywords: [], beats: [], scene: undefined, line: 0 });
  let cur = fresh(), para = 0, inBig = null, inKw = null;
  const close = (force) => {
    if (!cur.chars.length) return;
    if (!force && cur.chars.every(isDigit)) return; // "2." 这种编号并到后面一句
    cur.para = para;
    pieces.push(cur);
    cur = fresh();
  };

  lines.slice(sep + 1).forEach((raw, idx) => {
    const lineNo = sep + 2 + idx;
    const t = raw.trim();
    if (t.startsWith('//')) return;
    // 空行：分段，同时换一页画面（和旧流程一致）；后面紧跟 # 小标题时由小标题接管
    if (!t) { close(true); para++; if (pieces.length && cur.scene === undefined) cur.scene = null; return; }
    if (t.startsWith('#')) { close(true); cur.scene = t.replace(/^#+\s*/, ''); return; }
    if (t.startsWith('@')) {
      const [name, ...rest] = t.slice(1).split(/\s+/);
      const beat = { kind: name, offset: cur.chars.length, line: lineNo };
      if (name === '字' || name === '大字') {
        if (name === '大字' && TONES.has(rest[0]) && rest.length > 1) beat.tone = rest.shift(); // @大字 淡 因人而异
        beat.show = rest.join(' ');
        if (!beat.show) errors.push(`第 ${lineNo} 行：@${name} 后面要写画面上的字`);
      } else if (name === '步骤') {
        beat.show = rest.join(' ').replace(/^[0-9０-９一二三四五六七八九十]+[.、．:：]\s*/, ''); // 序号由画面自动编，稿子里写了就去掉
        if (!beat.show) errors.push(`第 ${lineNo} 行：@步骤 后面要写这一步的内容`);
      } else if (name === '对比') {
        const parts = rest.join(' ').split(/\s*[|｜]\s*/).map((s) => s.trim());
        if (parts.length !== 2 || !parts[0] || !parts[1]) errors.push(`第 ${lineNo} 行：@对比 要写成"@对比 旧说法 | 新说法"，中间用一条竖线隔开`);
        else { beat.left = parts[0]; beat.right = parts[1]; beat.show = `${parts[0]}→${parts[1]}`; }
      } else beat.args = rest.join(' ');
      cur.beats.push(beat);
      return;
    }
    if (!cur.line) cur.line = lineNo;
    const cs = [...t];
    const put = (ch, i) => { cur.chars.push(ch); cur.pos.push([lineNo, i]); };
    cs.forEach((ch, i) => {
      if (ch === '【') { inBig = cur.chars.length; return; }
      if (ch === '】') {
        if (inBig != null) cur.beats.push({ kind: '大字', offset: inBig, show: cur.chars.slice(inBig).join(''), line: lineNo });
        inBig = null; return;
      }
      if (ch === '*') {
        if (inKw == null) inKw = cur.chars.length;
        else { const kw = cur.chars.slice(inKw).join(''); if (kw) cur.keywords.push(kw); inKw = null; }
        return;
      }
      if (SPLIT.has(ch)) {
        if ((ch === '.' || ch === ',') && isDigit(cs[i - 1]) && isDigit(cs[i + 1])) { put(ch, i); return; } // 3.5
        if (inBig != null) return; // 【大字】里面不切句
        if (inKw != null) {
          // *金字* 跨了标点：这一条字幕里的那截先算关键词，下一条接着算
          const kw = cur.chars.slice(inKw).join(''), before = pieces.length;
          if (kw) cur.keywords.push(kw);
          close(false);
          if (pieces.length > before) inKw = 0; else if (kw) cur.keywords.pop();
          return;
        }
        close(false);
        return;
      }
      if (/\s/.test(ch)) { if (isAsciiWord(cs[i - 1]) && isAsciiWord(cs[i + 1])) put(' ', i); return; }
      if (isPunct(ch)) return; // 引号、括号等：不显示
      put(ch, i);
    });
    if (inBig != null) { errors.push(`第 ${lineNo} 行：【 没有配对的 】`); inBig = null; }
    if (inKw != null) { errors.push(`第 ${lineNo} 行：* 没有成对`); inKw = null; }
  });
  close(true);
  if (cur.beats.length) errors.push(`第 ${cur.beats[0].line} 行：记号后面没有口播文字，不知道该在什么时候出现`);
  if (cur.scene) warnings.push(`最后一个小标题「${cur.scene}」后面没有口播文字，已忽略`);

  const segments = [], scenes = [], positions = {};
  pieces.forEach((p, i) => {
    const id = 'c' + String(i + 1).padStart(3, '0');
    const text = p.chars.join('');
    let say = text;
    for (const [a, b] of sayMap) say = say.split(a).join(b);
    positions[id] = p.pos;
    // 行号取这句第一个字所在的行（一行里有几句时，后面几句原来拿不到行号）
    segments.push({ id, text, ...(say !== text ? { say } : {}), ...(p.keywords.length ? { keywords: p.keywords } : {}), para: p.para, line: p.pos[0]?.[0] ?? p.line });
    if (p.scene !== undefined || !scenes.length) {
      scenes.push({ id: 's' + (scenes.length + 1), type: '要点清单', heading: p.scene ?? '', from: id, beats: [] });
    }
    for (const b of [...p.beats].sort((x, y) => x.offset - y.offset)) {
      scenes.at(-1).beats.push({
        on: b.offset === 0 ? id : { seg: id, offset: b.offset },
        kind: b.kind, ...(b.show != null ? { show: b.show } : {}), ...(b.args != null ? { args: b.args } : {}), ...(b.tone ? { tone: b.tone } : {}),
        ...(b.left != null ? { left: b.left, right: b.right } : {}), line: b.line,
      });
    }
  });

  return {
    errors, warnings, meta, positions,
    storyboard: {
      version: 0, title: meta.title ?? '', brand: meta.brand ?? '', ...(meta.accent ? { accent: meta.accent } : {}),
      canvas: { width: 1080, height: 1920, fps: 30 },
      caption: { max_chars_per_line: 15, max_lines: 2 },
      audio: { file: meta.audio || 'voice.wav', timing: meta.timing || 'timing.json' },
      segments, scenes,
    },
  };
}
