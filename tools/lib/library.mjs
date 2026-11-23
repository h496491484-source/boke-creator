// 配乐曲库：技能自带的一组可以免费商用的曲子（目前都是 CC0），按情绪分好类，编排时按这期的内容挑。
//
//   template/配乐/曲库.json   每首一条：id、文件、曲名、作者、来源页、授权、核对授权的日期、sha256、大小、下载地址、
//                             类（情绪）、种类、适合什么内容
//   曲子文件：默认的 Aurora 随技能包带着（template/配乐/aurora_cc0.mp3，没有 url）；
//             其余放在魔搭，下载到 models/music/（不进 git、轻量包不带；setup 默认不下，--music 才全下），按 sha256 核对。
//             剪辑用到某首而本地没有：当场下载那一首；下不下来就退回 Aurora（build.mjs）。
//
// 种类："曲子"（能铺片头、截过渡、铺片尾。不循环：曲子不到 43 秒时片尾用它最后 13 秒，比要铺的还短就放完淡出，plan 会提醒）；"过渡音"（只用在板块之间，从头放、最多约 4 秒，更长的截断淡出，见 build.mjs）。
// 在编排方案.json 或节目档案里写"库:<id>"引用一首。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.mjs';
import { cmd } from './podcast.mjs';
import { sha256File } from './download.mjs';

export const LIB_DIR = path.join(ROOT, 'template', '配乐');
export const LIB_FILE = path.join(LIB_DIR, '曲库.json');
export const MUSIC_DIR = path.join(ROOT, 'models', 'music');
export const DEFAULT_MUSIC = path.join(LIB_DIR, 'aurora_cc0.mp3');
export const PARTS = ['片头', '过渡', '片尾'];

let cache = null;
// 没有曲库文件：当作空曲库（只有默认配乐）。文件在、但读不出来（比如手改时多了个逗号）：报错，不悄悄当成空的
export function loadLibrary() {
  if (cache) return cache;
  if (!fs.existsSync(LIB_FILE)) return (cache = []);
  let j;
  try { j = JSON.parse(fs.readFileSync(LIB_FILE, 'utf8')); } catch (err) { throw new Error(`曲库文件 ${LIB_FILE} 读不出来（${err.message}）。改回能读的 JSON，或者重新解压技能包。`); }
  if (!Array.isArray(j.tracks)) throw new Error(`曲库文件 ${LIB_FILE} 里没有 tracks 列表。`);
  cache = j.tracks.map((t) => ({ ...t, path: path.join(t.url ? MUSIC_DIR : LIB_DIR, t.file) }));
  return cache;
}

// 本地有没有、大小对不对（只看大小，快：列表、setup 的"装好没有"用它）
export const trackReady = (t) => { try { const n = fs.statSync(t.path).size; return t.bytes ? n === t.bytes : n > 0; } catch { return false; } };

// 真要用这首（plan、build、补下载）时再核对内容：大小对了按 sha256 算一次，结果按"大小 + 修改时间"记在
// models/music/.verified.json，文件没动过就不再算（每首约 3 MB，第一次几十毫秒）。
// 大小对、内容坏了（v0.7 审查 69 实测：中间一段被写成 0，只能解出 27 秒）返回 false，getMusic 会删掉重下
const VERIFIED = path.join(MUSIC_DIR, '.verified.json');
export async function trackGood(t) {
  if (!trackReady(t)) return false;
  if (!t.url || !t.sha256) return true; // 随包带的 Aurora 没法重下，只看在不在
  const st = fs.statSync(t.path), key = path.basename(t.path);
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(VERIFIED, 'utf8')); } catch {}
  const v = seen[key];
  if (v && v.size === st.size && v.mtimeMs === st.mtimeMs) return v.ok;
  const ok = (await sha256File(t.path)) === t.sha256;
  seen[key] = { size: st.size, mtimeMs: st.mtimeMs, ok };
  try { fs.writeFileSync(VERIFIED, JSON.stringify(seen)); } catch {}
  return ok;
}

export const isLibRef = (v) => typeof v === 'string' && /^(曲库|库)\s*[:：]/.test(v.trim());
export const refId = (v) => v.trim().replace(/^(曲库|库)\s*[:：]\s*/, '');

// "库:xxx" → 曲库里的那一首；编号不存在就报错，不悄悄换成别的。
// 本地还没下载不算错（build 用到时会下载）；随包带的那首（没有 url）文件不在才报错
export function libTrack(v) {
  const id = refId(v);
  const lib = loadLibrary();
  const t = lib.find((x) => x.id === id);
  if (!t) throw new Error(`曲库里没有"${id}"。可以选的：${lib.map((x) => x.id).join('、') || '（曲库是空的）'}。看全部：${cmd('music.mjs')}`);
  if (!t.url && !fs.existsSync(t.path)) throw new Error(`曲库里的"${id}"文件不在：${t.path}。重新解压技能包。`);
  return t;
}

export const trackByPath = (p) => (p ? loadLibrary().find((t) => path.resolve(t.path) === path.resolve(p)) ?? null : null);

// 写进简介的署名。CC0 不要求署名，还是写一句来源，方便听众找到。
// CC BY 要写全：曲名、作者、来源页链接、授权名和授权链接（曲库.json 的 licenseUrl），并说明改动过（剪辑、调音量都算改编）（v0.7 审查 71）
export const needsFullCredit = (t) => /^CC[ -]?BY/i.test(t?.license ?? '');
export function credit(t) {
  if (needsFullCredit(t)) return `${t.title} by ${t.author}，来源 ${t.source ?? '（缺来源页）'}，授权 ${t.license}${t.licenseUrl ? `（${t.licenseUrl}）` : '（缺授权链接）'}，本节目截取了片段、调整了音量`;
  const host = (() => { try { return new URL(t.source).host.replace(/^www\./, ''); } catch { return ''; } })();
  return `${t.title} by ${t.author}（${t.license}${host ? `，来自 ${host}` : ''}）`;
}
// 和曲库里 aurora 那一条走 credit() 写出来的一样（以前两处写法不同）
export const DEFAULT_CREDIT = 'Aurora by Trex0n (Cal McEachern)（CC0 1.0，来自 opengameart.org）';

const OFF = /^(无|没有|不要|不加)$/;
const entry = (file, from) => (file ? { file, from, track: trackByPath(file) } : null);
export const defaultEntry = () => entry(fs.existsSync(DEFAULT_MUSIC) ? DEFAULT_MUSIC : null, '默认');

// 这一期三处各用哪首。plan.mjs 和 build.mjs 都用它，规则只有这一份：
//   编排方案.json 的 music：false 三处都不要；"库:<id>" / "默认" / 文件名 三处都用它；
//   { "片头": …, "过渡": …, "片尾": … } 分开写（每处可以写 false），没写的那处照节目档案的"配乐"。
//   节目档案只在真有一处要用它时才去读（档案里写的文件不在了，而这期三处都自己指定了，不受影响）。
// 返回 { 片头, 过渡, 片尾 }，每处是 { file, from: '方案'|'档案'|'默认', track } 或 null。
// showMusic：() => 档案"配乐"解析出的值（'default' / null / 路径），由调用方传进来（show.mjs 依赖本文件，不反过来引用）。
export function resolveMusic(plan, { work, assets, showMusic }) {
  const m = plan?.music;
  let given;
  if (m === undefined || m === null) given = {};
  else if (m === false || typeof m === 'string') given = Object.fromEntries(PARTS.map((k) => [k, m]));
  else if (typeof m === 'object' && !Array.isArray(m)) {
    const bad = Object.keys(m).filter((k) => !PARTS.includes(k));
    if (bad.length) throw new Error(`music 里的"${bad.join('、')}"不认识，只能写 片头、过渡、片尾（三处都一样就直接写 "music": "库:<编号>"）`);
    given = m;
  } else throw new Error('music 写法不对：写 false、"库:<编号>"，或者分开写 {"片头": "库:…", "过渡": "库:…", "片尾": "库:…"}');

  const pick = (v, k) => {
    const where = `music${typeof m === 'object' && m ? `.${k}` : ''}`;
    if (v === false || (typeof v === 'string' && OFF.test(v.trim()))) return null;
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${where} 写的是 ${JSON.stringify(v)}：要写 false、"库:<编号>"、"默认"或者音频文件名`);
    if (/^(默认|自带)$/.test(v.trim())) return entry(fs.existsSync(DEFAULT_MUSIC) ? DEFAULT_MUSIC : null, '默认');
    if (isLibRef(v)) return entry(libTrack(v).path, '方案');
    const hit = [path.resolve(work, v), assets && path.resolve(assets, v)].filter(Boolean).find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
    if (hit) return entry(hit, '方案');
    const lib = loadLibrary().find((t) => t.id === v.trim());
    throw new Error(`${where} 写的是"${v}"：${lib ? `是不是要写"库:${lib.id}"？` : '既不是"库:<编号>"，也找不到这个文件（放在节目目录或节目档案的 素材/ 里）。'}`);
  };
  let sm; // 节目档案的配乐，用到才读
  const fromShow = () => {
    // 档案里写错的（比如"库:不存在的编号"）算档案的问题，不算编排方案的（plan 按"节目档案里"配乐""开头分开报；审查 #59 复核）
    sm ??= { v: (() => { try { return showMusic(); } catch (err) { throw /^节目档案/.test(err.message) ? err : new Error(`节目档案里"配乐"有问题：${err.message}`); } })() };
    if (sm.v === 'default') return entry(fs.existsSync(DEFAULT_MUSIC) ? DEFAULT_MUSIC : null, '默认');
    return entry(sm.v, '档案');
  };
  const out = {};
  for (const k of PARTS) {
    out[k] = k in given ? pick(given[k], k) : fromShow();
    if (out[k]?.track?.kind === '过渡音' && k !== '过渡') throw new Error(`${k}用了过渡音"${out[k].track.id}"：过渡音只放开头约 4 秒，只能用在"过渡"`);
  }
  return out;
}

// 给人看的名字
export const musicName = (x) => (!x ? '不要' : x.track ? `${x.track.title}（库:${x.track.id}${x.track.mood?.length ? `，${x.track.mood.join('/')}` : ''}${x.track.kind === '过渡音' ? '，过渡音' : ''}）` : path.basename(x.file));
