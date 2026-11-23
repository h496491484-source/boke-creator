#!/usr/bin/env node
// 出节目简介草稿：标题、简介正文（编排方案.json 的 intro，由 Agent 写）、精确到每个小话题的时间轴、配乐署名、还没确认的事。
//
//   node tools/podcast/notes.mjs <节目目录>     → 精编版/节目简介.md
//
// 时间轴按精编版里的真实位置算（每个小话题第一句在成品里的时间），可以直接贴到小宇宙等平台。

import fs from 'node:fs';
import path from 'node:path';
import { episode, mustExist, loadFull, readJson, writeJson, writeText, stuckFiles, stuckMsg, roFix, readInfo, infoBlank, infoOneLine, isSolo, consentOf, briefInfo, fmt, ff, fileSha, MUSIC, planOrExit, cmd, mp3Title, planTodos, TODO_WHERE, introOf, planBadMsg } from '../lib/podcast.mjs';
import { loadShow } from '../lib/show.mjs';
import { DEFAULT_CREDIT } from '../lib/library.mjs';

const dir = process.argv[2];
if (!dir) { console.error(`用法: ${cmd('notes.mjs')} <节目目录>`); process.exit(2); }
mustExist(dir);
const e = episode(dir);
const edl = readJson(path.join(e.out, '剪辑表.json'), null);
const plan = planOrExit(e); // 写坏了会说第几行、什么原因
if (!edl || !plan) { console.error(`先剪出精编版：${cmd('finish.mjs', e.work)}（剪精编版、机器检查、出简介一条命令做完）`); process.exit(1); }
// intro 写成认不出的样子：什么都不动（不换标题、不删旧简介）就停下，说清楚怎么写
const intro = introOf(plan);
if (intro.bad) { console.error(`${planBadMsg(intro.bad)}。精编版和简介都没动，改好再运行 ${cmd('notes.mjs', e.work)}（不用重剪、不用重跑 plan）`); process.exit(1); }
// 只改了标题不用重剪，但 mp3 里写着标题：换一下标签（直接拷贝音频，不重新编码，一两秒）
const title = mp3Title(plan), mp3 = path.join(e.out, '精编版.mp3');
const retag = edl.title !== undefined && edl.title !== title && fs.existsSync(mp3);
// 要改的文件被播放器开着、是只读的：先停下说清楚，一个都不动（2026-11-22 审查 78、80）
const stuck = stuckFiles(e.out, [...(retag ? ['精编版.mp3', '检查报告.json'] : []), '节目简介.md', '主理人反馈表.md', '剪辑表.json']);
if (stuck.length) { console.error(stuckMsg(e.work, '精编版/', stuck)); process.exit(1); }
const tmp = path.join(e.out, '精编版.retag.mp3');
fs.rmSync(tmp, { force: true }); // 旧版换标题失败时留在交付目录里的
if (retag) {
  ff(['-v', 'error', '-i', mp3, '-map', '0', '-c', 'copy', '-id3v2_version', '3', '-metadata', `title=${title}`, tmp], '换 mp3 标题');
  const was = fileSha(mp3);
  try { fs.renameSync(tmp, mp3); } catch (err) {
    fs.rmSync(tmp, { force: true }); // 不在交付目录里留下第二个 mp3
    console.error(`精编版.mp3 换不了标题：${['EPERM', 'EBUSY', 'EACCES'].includes(err.code) ? `正被别的程序（多半是播放器）打开着，或者是只读的。精编版.mp3 和简介都没动。${roFix(e.work)}，再运行 ${cmd('notes.mjs', e.work)}` : err.message}`);
    process.exit(1);
  }
  const now = fileSha(mp3);
  // 声音一个字节没动：检查报告、量过的响度、"成品"的确认都跟着换到新文件上，不用重新检查
  edl.title = title;
  if (edl.measured?.mp3 === was) edl.measured.mp3 = now;
  writeJson(path.join(e.out, '剪辑表.json'), edl);
  const repFile = path.join(e.out, '检查报告.json'), rep = readJson(repFile, null);
  if (rep?.mp3 === was) writeJson(repFile, { ...rep, mp3: now }, 2);
  const st = readJson(e.state, null);
  // "可以清理"的提示也按 mp3 指纹记着只提示一次：一起换过去，不然每改一次标题就又提示一次（v0.7 审查 25）
  if (st && (st.confirmed?.['成品']?.sha === was || st.cleanHint === was)) {
    if (st.confirmed?.['成品']?.sha === was) st.confirmed['成品'].sha = now;
    if (st.cleanHint === was) st.cleanHint = now;
    writeJson(e.state, st, 2);
  }
  console.log(`精编版.mp3 的标题换成了"${title}"（没重新编码）。`);
}
let full;
try { full = loadFull(e); } catch (err) { console.error(err.message); process.exit(1); } // 转写半路断了会没有全文：说清楚，不打英文堆栈（和 plan 一样）
const byId = new Map(full.map((s) => [s.id, s]));
const info = readInfo(e);
const clips = edl.items.filter((x) => x.kind === 'clip');

const lines = [], lostTopics = [];
const chapters = fs.readFileSync(path.join(e.out, '章节目录.txt'), 'utf8').trim().split('\n');
// 按板块在成品里的位置排：build 总把钩子放在最前面，非钩子板块写在钩子前面（补录开场单独成板块）时，
// 照 sections 的顺序写时间轴会乱（"00:25 研究说明"排在"00:00 片头"前面），和章节目录也对不上（2026-11-24 第 3 轮 12）
const ordered = plan.sections.map((sec) => ({ sec, first: clips.find((c) => c.section === sec.name) })).filter((x) => x.first).sort((a, b) => a.first.out[0] - b.first.out[0]);
for (const { sec, first } of ordered) {
  if (sec.kind === 'hook') { lines.push(`00:00 ${sec.name}`); continue; }
  const head = chapters.find((l) => l.endsWith(` ${sec.name}`))?.split(' ')[0] ?? fmt(first.out[0]);
  lines.push('', `**${head} ${sec.name}**`);
  if (sec.parts.length < 2) continue;
  for (const p of sec.parts) {
    // 从小话题的第一句往后找第一句真剪进去的：第一句只有"嗯""呃"时 build 跳过了它，不能因此把这个小话题从时间轴里丢掉（v0.7 审查 67）
    let hit = null;
    for (let id = p.from; id <= p.to && !hit; id++) {
      const s = byId.get(id);
      const c = s && clips.find((c) => c.section === sec.name && c.src[1] > s.start && c.src[0] < s.end);
      if (c) hit = { s, c };
    }
    // 板块的第一个小话题：章节时间从这个板块第一个片段的开头算（含说话前留的一小段空），小话题从说话算，取整到秒以后可能早一秒
    // （"00:24 五条做法"下面第一条是"00:25 一、……"）。离板块开头不到 2 秒的，跟板块写同一个时间（2026-11-24 复核 #70 遗留）
    const at = hit && hit.c.out[0] + Math.max(0, hit.s.start - hit.c.src[0]);
    if (hit) lines.push(`- ${p === sec.parts[0] && at - first.out[0] < 2 ? head : fmt(at)} ${p.label}`);
    else lostTopics.push(`「${sec.name}」的「${p.label ?? `${p.from}–${p.to} 句`}」`);
  }
}

const todo = [];
// 找不到位置的小话题不悄悄丢掉：写进"发布前要确认"，屏幕上也打一行
if (lostTopics.length) {
  todo.push(`时间轴里少了 ${lostTopics.join('、')}：在精编版里找不到它的位置（精编版不是按现在的方案剪的，或者这段整段没剪进去）。重新运行 ${cmd('finish.mjs', e.work)}；还缺就对照 编排方案.json 看这段的句子编号`);
  console.error(`△ 时间轴里少了 ${lostTopics.join('、')}（在精编版里找不到位置），写进了"发布前要确认"`);
}
// 机器草稿的占位一路带进了成品（标题、章节目录、时间轴里是"待改"）：列进"发布前要确认"，finish 也会带出来
const nTodo = planTodos(plan);
if (nTodo) todo.push(`编排方案里还有 ${nTodo} 处写着"待改"（${TODO_WHERE}）：标题、章节目录、时间轴里会出现占位名。改好后重新运行 ${cmd('plan.mjs', e.work)} 和 ${cmd('finish.mjs', e.work)}`);
if (infoBlank(info['录音是否完整']) || /不确定|否|不是|没|不完整|不全|部分|只有|缺/.test(info['录音是否完整'] ?? '')) todo.push(/不完整|不全|部分|只有|缺/.test(info['录音是否完整'] ?? '') ? `给的录音不完整（${info['录音是否完整']}）：简介里不要写"共录了多久"、"完整版"之类的话` : '录音是否完整还没确认：确认前不要写"共录了多久"之类的话');
if (infoBlank(info['本期主题']) || /不确定/.test(info['本期主题'] ?? '')) todo.push('本期主题的原话还没确认');
const solo = isSolo(info);
const skipped = readJson(e.state, {}).confirmed?.['认人']?.skipped;
// 明确不同意和没问清分开说：有人明确不同意发布，是"不能发"，不是"还没确认"
const consent = solo ? 'solo' : consentOf(info), consentText = infoOneLine(info['嘉宾是否同意']);
if (consent === 'no') todo.push(`有参与者明确不同意公开发布（节目信息写的是「${consentText}」）：这一版不能直接发。先和主理人商量，不发布，或者删掉这位嘉宾的内容、重新编排后再出`);
else if (consent === 'unsure') todo.push('参与者是否同意剪辑发布还没确认');
const names = [...new Set(full.map((s) => s.speaker).filter(Boolean))];
const named = new Set(full.filter((s) => s.name).map((s) => s.speaker));
if (!solo && !skipped && names.length > 1 && named.size < names.length) todo.push(`说话人还有 ${names.length - named.size} 个编号没对上人（说话人.md）：简介里提到具体的人之前先确认`);

const md = [`# 节目简介（草稿）`, '', `**标题**：${plan.title ?? '（待定）'}`, ''];
if (!infoBlank(info['节目名'])) md.push(`**节目**：${infoOneLine(info['节目名'])}`, '');
md.push(...(intro.paras.length ? intro.paras.flatMap((p) => [p, '']) :['（简介正文待写：在 编排方案.json 里加 intro，一段一个字符串）', '']));
while (lines[0] === '') lines.shift(); // 没有钩子时第一行是板块前的空行，"## 时间轴"下面已经空了一行
md.push('## 时间轴', '', ...lines, '');
const extra = [];
const show = loadShow(e);
if (edl.musicTracks?.length) {
  // 曲库里的曲子自带署名；默认那首（Aurora）用固定署名；节目档案里那首用档案的"配乐署名"；
  // 这期编排方案里直接写的别的文件，没有地方记授权，一律列进"发布前要确认"
  const credits = [], ask = [];
  for (const t of edl.musicTracks) {
    if (t.credit) credits.push(t.credit);
    else if (t.file === 'default') credits.push(DEFAULT_CREDIT);
    else if (t.from === '档案' && show?.get('配乐署名')) credits.push(show.get('配乐署名'));
    else ask.push(t);
  }
  if (credits.length) extra.push(`配乐：${[...new Set(credits)].join('；')}`);
  for (const t of ask) todo.push(t.from === '档案'
    ? `配乐用的是节目自己的 ${t.file}，节目档案里没写"配乐署名"：确认有授权，需要署名的补上`
    : `这期配乐用了 ${t.file}（编排方案里指定的，不在曲库里）：确认有授权，需要署名的写进简介`);
} else if (edl.music?.length && (edl.musicFile ?? 'default') === 'default' && fs.existsSync(MUSIC)) extra.push(`配乐：${DEFAULT_CREDIT}`);
else if (edl.music?.length) {
  const credit = show?.get('配乐署名');
  if (credit) extra.push(`配乐：${credit}`);
  else todo.push(`配乐用的是节目自己的 ${edl.musicFile}，节目档案里没写"配乐署名"：确认有授权，需要署名的补上`);
}
// 节目档案的片头、片尾（主理人自己的音频）里常垫着别人的音乐：和配乐一样要确认授权。
// 档案里写了"片头片尾署名"就写进简介（写"不用"就不写），没写就提醒一次（v0.7 审查 71）
const assetFiles = (edl.assets ?? []).map((a) => `${a.name === 'intro' ? '片头' : '片尾'} ${a.file}`);
if (assetFiles.length) {
  const ac = show?.get('片头片尾署名');
  if (!ac) todo.push(`节目片头片尾（${assetFiles.join('、')}）里如果用了别人的音乐，确认有授权，需要署名的写进简介。以后每期都这样的话，等这期交付后在节目档案里加一行"- 片头片尾署名：……"（不用署名就写"不用"），下一期起自动写进简介、不再提醒（现在改档案，这期会要求重剪）`);
  else if (!/^(不用|不需要|无|没有|否)/.test(ac)) extra.push(`片头片尾：${ac}`);
}
if (extra.length) md.push('## 其他', '', ...extra.map((x) => `- ${x}`), '');
if (todo.length) md.push('## 发布前要确认（发布时删掉这一节）', '', ...todo.map((x) => `- ${x}`), '');
writeText(path.join(e.out, '节目简介.md'), md.join('\n'));

// 给主理人的反馈表：和精编版一起发过去，收回来的意见就是改编排、改技能的依据
const len = fmt(edl.length ?? edl.voiceEnd + 11), orig = fmt(full.at(-1).end);
writeText(path.join(e.out, '主理人反馈表.md'), `# 精编版反馈表

节目：${info['节目名'] && !infoBlank(info['节目名']) ? infoOneLine(info['节目名']) : path.basename(e.work)}　标题：${plan.title ?? '（待定）'}
原始录音 ${orig}，精编版 ${len}。一起发给你的还有：节目简介.md（带时间轴）、编排方案.md（留了什么、删了什么、为什么）${fs.existsSync(e.rollcall) ? '、声音点名.mp3（每个说话人约 10 秒）' : ''}。

请听完精编版再填。说不清的地方，直接写时间点（比如"12:30 那句"）就行。

## 1. 剪辑

- 删掉的内容里，有没有想留下的？（看 编排方案.md 的删减清单，写句子编号或原位置）
- 留下的内容里，有没有该删的？（写精编版里的时间点）
- 板块怎么分、顺序、片头那几句，合不合适？

## 2. 听感

- 有没有听着别扭的剪口（吞字、突然断、语气接不上）？写时间点：
- 音量：各人大小是否差不多？有没有忽大忽小？
- 配乐：喜不喜欢？片头、过渡、片尾哪里多余或不够？

## 3. 省了多少事

- 这期如果你自己剪，大概要花多久？
- 用这个流程，你实际花了多久（回答问题、看方案、听成品）？
- 你会直接发布这一版，还是要自己再改？要改的话，主要改哪里？

## 4. 要你确认的事
${[
  infoBlank(info['本期主题']) || /不确定/.test(info['本期主题'] ?? '') ? '- 本期主题的原话是什么？' : '',
  infoBlank(info['录音是否完整']) || /不确定|否|不是|没|不完整|不全|部分|只有|缺/.test(info['录音是否完整'] ?? '') ? '- 给的录音是不是全部？有没有没给的部分？' : '',
  fs.existsSync(e.names) && !solo ? '- 声音点名里每个编号是谁？（在 说话人.md 的"是谁"一栏填，或者直接告诉我们）' : '',
  consent === 'no' ? `- 节目信息里写着有人不同意公开发布（「${consentText}」）：这期还发吗？要删掉谁的内容？` : consent === 'unsure' ? '- 参加录音的人都知道并同意剪辑发布吗？' : '',
  '- 片头用的几句原话，说话的人知道并同意吗？',
].filter(Boolean).join('\n')}

## 5. 其他想说的
`);
// 记下这份简介是按哪版节目信息写的：之后补填、改了这几栏，status 会提示重出
writeJson(path.join(e.out, '剪辑表.json'), { ...edl, notesInfo: briefInfo(info) });
console.log(`节目简介写到 精编版/节目简介.md（时间轴 ${lines.filter((l) => l.startsWith('-')).length} 个小话题）。${todo.length ? `还有 ${todo.length} 件事要确认。` : ''}`);
