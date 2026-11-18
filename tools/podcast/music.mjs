#!/usr/bin/env node
// 看配乐曲库：每首的编号、类（情绪）、种类、长度、适合什么内容。编排时按这期的内容挑，写进 编排方案.json 的 music。
//
//   node tools/podcast/music.mjs                 列出全部
//   node tools/podcast/music.mjs 温暖            只看某一类（或种类"过渡音"）
//   node tools/podcast/music.mjs --check         核对每首的文件和校验值（维护者用）

import fs from 'node:fs';
import crypto from 'node:crypto';
import { loadLibrary, LIB_FILE } from '../lib/library.mjs';
import { duration, fmt } from '../lib/podcast.mjs';

const args = process.argv.slice(2);
let lib;
try { lib = loadLibrary(); } catch (err) { console.error(err.message); process.exit(1); }
if (!lib.length) {
  if (args.includes('--check')) { console.error(`没有曲库文件 ${LIB_FILE}，或者里面一首都没有。`); process.exit(1); }
  console.log('曲库是空的，只有默认配乐（Aurora）。'); process.exit(0);
}

if (args.includes('--check')) {
  let bad = 0;
  for (const t of lib) {
    const ok = fs.existsSync(t.path) && (!t.sha256 || crypto.createHash('sha256').update(fs.readFileSync(t.path)).digest('hex') === t.sha256);
    if (!ok) { bad++; console.log(`✗ ${t.id}：${fs.existsSync(t.path) ? '校验值不对' : '文件不在'}（${t.file}）`); }
  }
  console.log(bad ? `${bad} 首有问题` : `${lib.length} 首全部核对通过`);
  process.exit(bad ? 1 : 0);
}

const want = args.find((a) => !a.startsWith('--'));
const rows = lib.filter((t) => !want || t.mood?.includes(want) || t.kind === want);
console.log(`曲库 ${lib.length} 首${want ? `，"${want}" ${rows.length} 首` : ''}。在 编排方案.json 里写 "music": "库:<编号>"，或分开写 {"片头": "库:…", "过渡": "库:…", "片尾": "库:…"}。\n`);
for (const t of rows) {
  const len = t.seconds ?? (fs.existsSync(t.path) ? duration(t.path) : 0);
  console.log(`库:${t.id}  [${(t.mood ?? []).join('/')}]  ${t.kind ?? '曲子'}  ${fmt(len)}  ${t.title} — ${t.author}`);
  if (t.fits) console.log(`    适合：${t.fits}`);
}
