#!/usr/bin/env node
// 看配乐曲库：每首的编号、类（情绪）、种类、长度、适合什么内容、本地下载了没有。编排时按这期的内容挑，写进 编排方案.json 的 music。
//
//   node tools/podcast/music.mjs                 列出全部
//   node tools/podcast/music.mjs 温暖            只看某一类（或种类"过渡音"）
//   node tools/podcast/music.mjs --download      把还没下载的都下载下来（setup 也会做）
//   node tools/podcast/music.mjs --check         核对本地已有的文件（大小、sha256），并报还差几首

import fs from 'node:fs';
import crypto from 'node:crypto';
import { loadLibrary, trackReady, needsFullCredit, LIB_FILE } from '../lib/library.mjs';
import { fmt, cmd } from '../lib/podcast.mjs';

const args = process.argv.slice(2);
let lib;
try { lib = loadLibrary(); } catch (err) { console.error(err.message); process.exit(1); }
if (!lib.length) {
  if (args.includes('--check')) { console.error(`没有曲库文件 ${LIB_FILE}，或者里面一首都没有。`); process.exit(1); }
  console.log('曲库是空的，只有默认配乐（Aurora）。'); process.exit(0);
}

if (args.includes('--download')) {
  const { getMusic } = await import('../get-model.mjs');
  const r = await getMusic({ log: console.log });
  if (!r.got.length && !r.failed.length) console.log('都已经下载好了。');
  process.exit(r.failed.length ? 1 : 0);
}

if (args.includes('--check')) {
  let bad = 0, miss = 0;
  for (const t of lib) {
    // CC BY 的曲子署名要带来源页和授权链接：曲库条目缺了就报出来（v0.7 审查 71）
    if (needsFullCredit(t) && (!t.source || !t.licenseUrl)) { bad++; console.log(`✗ ${t.id}：授权是 ${t.license}，要署名，曲库.json 里还缺${[!t.source && ' source（来源页）', !t.licenseUrl && ' licenseUrl（授权链接）'].filter(Boolean).join('、')}`); continue; }
    if (!fs.existsSync(t.path)) { if (t.url) { miss++; continue; } bad++; console.log(`✗ ${t.id}：随包带的文件不在（${t.path}）`); continue; }
    const buf = fs.readFileSync(t.path);
    const ok = (!t.bytes || buf.length === t.bytes) && (!t.sha256 || crypto.createHash('sha256').update(buf).digest('hex') === t.sha256);
    if (!ok) { bad++; console.log(`✗ ${t.id}：大小或校验值不对（${t.path}），删掉后运行 ${cmd('music.mjs', '--download')} 重新下载`); }
  }
  console.log(`${lib.length - miss - bad} 首核对通过${bad ? `，${bad} 首有问题` : ''}${miss ? `，${miss} 首还没下载（--download 下载）` : ''}`);
  process.exit(bad ? 1 : 0);
}

const want = args.find((a) => !a.startsWith('--'));
const rows = lib.filter((t) => !want || t.mood?.includes(want) || t.kind === want);
const missing = lib.filter((t) => !trackReady(t)).length;
console.log(`曲库 ${lib.length} 首${want ? `，"${want}" ${rows.length} 首` : ''}${missing ? `，本地还差 ${missing} 首（用到时会自动下载；或者先运行 ${cmd('music.mjs', '--download')}）` : '，都已下载'}。`);
console.log('在 编排方案.json 里写 "music": "库:<编号>"，或分开写 {"片头": "库:…", "过渡": "库:…", "片尾": "库:…"}。\n');
for (const t of rows) {
  console.log(`库:${t.id}  [${(t.mood ?? []).join('/')}]  ${t.kind ?? '曲子'}  ${fmt(t.seconds ?? 0)}  ${t.title} — ${t.author}${trackReady(t) ? '' : '  （未下载）'}`);
  if (t.fits) console.log(`    适合：${t.fits}`);
}
