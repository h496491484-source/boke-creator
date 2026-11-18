// 配乐曲库：技能自带的一组可以免费商用的曲子（目前都是 CC0），按情绪分好类，编排时按这期的内容挑。
//
//   template/配乐/曲库.json   每首一条：id、文件、曲名、作者、来源页、授权、sha256、类（情绪）、种类、适合什么内容
//   template/配乐/曲库/        曲子文件（自带的 Aurora 还在 template/配乐/aurora_cc0.mp3）
//
// 种类："曲子"（能铺片头、截过渡、铺片尾，最好 45 秒以上）；"过渡音"（几秒的短音，只用在板块之间，整段放）。
// 在编排方案.json 或节目档案里写"库:<id>"引用一首。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.mjs';

export const LIB_DIR = path.join(ROOT, 'template', '配乐');
export const LIB_FILE = path.join(LIB_DIR, '曲库.json');

let cache = null;
export function loadLibrary() {
  if (cache) return cache;
  let j = { tracks: [] };
  try { j = JSON.parse(fs.readFileSync(LIB_FILE, 'utf8')); } catch { /* 没有曲库：只有默认配乐 */ }
  cache = (j.tracks ?? []).map((t) => ({ ...t, path: path.join(LIB_DIR, t.file) }));
  return cache;
}

export const isLibRef = (v) => typeof v === 'string' && /^(曲库|库)\s*[:：]/.test(v.trim());
export const refId = (v) => v.trim().replace(/^(曲库|库)\s*[:：]\s*/, '');

// "库:xxx" → 曲库里的那一首；找不到、文件不在都报错，不悄悄换成别的
export function libTrack(v) {
  const id = refId(v);
  const lib = loadLibrary();
  const t = lib.find((x) => x.id === id);
  if (!t) throw new Error(`曲库里没有"${id}"。可以选的：${lib.map((x) => x.id).join('、') || '（曲库是空的）'}。看全部：node tools/podcast/music.mjs`);
  if (!fs.existsSync(t.path)) throw new Error(`曲库里的"${id}"文件不在：${t.path}。重新解压技能包。`);
  return t;
}

export const trackByPath = (p) => (p ? loadLibrary().find((t) => path.resolve(t.path) === path.resolve(p)) ?? null : null);

// 写进简介的署名。CC0 不要求署名，还是写一句来源，方便听众找到
export function credit(t) {
  const host = (() => { try { return new URL(t.source).host.replace(/^www\./, ''); } catch { return ''; } })();
  return `${t.title} by ${t.author}（${t.license}${host ? `，来自 ${host}` : ''}）`;
}
