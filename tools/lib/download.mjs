// 下载文件：断点续传、卡住或太慢自动换源、几个文件同时下。get-model.mjs、get-ffmpeg.mjs 共用。
//
// 每个文件先下到 <目标>.part，下完核对大小和 sha256 再改名成目标文件，所以：
//   · 中途断了（网络断、关掉窗口、Ctrl+C），再跑一次从 .part 的末尾接着下（HTTP Range）；
//   · 换到下一个来源也接着下（同一个文件，最后按 sha256 核对；对不上就删掉从头下）。
// 换下一个来源的条件：20 秒连不上；30 秒没收到数据（卡住）；太慢（开头 30 秒不算，之后平均每秒不到 50 KB。
// 几个文件同时下时网速是大家分的，门槛按同时在下的个数摊，但不低于每秒 10 KB）。
// 熔断：站点出过整站性的问题（连不上、卡住、太慢、5xx、返回网页），这次运行里别的文件就不再试它，
// 不会在同一个坏站上每个文件都白等一遍超时。只是单个文件的问题（404、校验不对）不熔断；下到一半断了不熔断。
// 同时最多下 4 个文件（环境变量 BOKE_DL_PARALLEL 可改），先来先下。大文件每 8 秒报一次进度。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MIN_SPEED = 50 * 1024;   // 每秒字节数
const FLOOR_SPEED = 10 * 1024;
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
const CONNECT_MS = num(process.env.BOKE_DL_CONNECT_MS, 20000);
const STALL_MS = num(process.env.BOKE_DL_STALL_MS, 30000);
const GRACE_MS = num(process.env.BOKE_DL_GRACE_MS, 30000);
const MAX_PARALLEL = num(process.env.BOKE_DL_PARALLEL, 4);
const PROGRESS_MS = num(process.env.BOKE_DL_PROGRESS_MS, 8000);
const PROGRESS_OVER = 5 * 1048576; // 这么大以上的文件才报进度

export const mb = (n) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;
export const host = (u) => { try { return new URL(u).host; } catch { return String(u); } };
const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
const rm = (f) => fs.rmSync(f, { force: true });

export async function sha256File(f) {
  const h = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(f)) h.update(c);
  return h.digest('hex');
}

// ---- 同时下载的个数 ----
let busy = 0;
const waiting = [];
async function slot() {
  if (busy < MAX_PARALLEL) { busy++; return; }
  await new Promise((r) => waiting.push(r)); // 名额由 release 直接转交，busy 不变
}
function release() { const next = waiting.shift(); if (next) next(); else busy--; }
let streaming = 0; // 正在收数据的连接数，用来摊速度门槛

// ---- 站点表现：熔断的不再试；出过小问题的往后排 ----
const strikes = new Map();
const tripped = new Map(); // 站点 → 熔断原因
export function resetSources() { strikes.clear(); tripped.clear(); } // 测试用
const rank = (urls) => urls.filter((u) => !tripped.has(host(u)))
  .map((u, i) => [u, i]).sort((a, b) => ((strikes.get(host(a[0])) ?? 0) - (strikes.get(host(b[0])) ?? 0)) || a[1] - b[1]).map(([u]) => u);

function reason(e) {
  const c = e?.cause?.code ?? e?.cause?.errors?.[0]?.code ?? e?.code;
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return '找不到这个网站';
  if (c === 'ECONNREFUSED') return '连不上（被拒绝）';
  if (c === 'ECONNRESET' || c === 'UND_ERR_SOCKET' || c === 'EPIPE') return '连接中途断了';
  if (c && String(c).includes('CERT')) return `证书不对（${c}）`;
  if (c) return `连不上（${c}）`;
  return e?.cause?.message || e?.message || String(e);
}
// 中途断了：可能只是一时的，值得整轮再试一次（换源后再轮回来）；连不上、卡住、太慢：整个站点熔断
const retryable = (msg) => Object.assign(new Error(msg), { again: /断了/.test(msg), trip: !/断了/.test(msg) });
const siteErr = (msg) => Object.assign(new Error(msg), { trip: true });

// 从一个来源下一次。接着 .part 已有的部分下；出错抛异常（.part 留着，下次接着下）
async function attempt(url, part, job) {
  const { label, log } = job;
  let have = sizeOf(part);
  if (job.bytes && have > job.bytes) { rm(part); have = 0; }
  if (job.bytes && have === job.bytes) return; // 上次已经下完，等核对
  const ctl = new AbortController();
  let why = '';
  const stop = (m) => { if (!why) why = m; ctl.abort(); };
  let timer = setTimeout(() => stop(`${CONNECT_MS / 1000} 秒连不上`), CONNECT_MS);
  const kick = () => { clearTimeout(timer); timer = setTimeout(() => stop(`${STALL_MS / 1000} 秒没收到数据`), STALL_MS); };
  let ticker = null;
  const drop = (res) => { try { res.body?.cancel().catch(() => {}); } catch { /* 已经关了 */ } };
  try {
    let res;
    try { res = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: have ? { Range: `bytes=${have}-` } : {} }); }
    catch (e) { throw Object.assign(retryable(why || reason(e)), { early: true }); } // 还没连上：被重置两次也算整站的问题
    if (res.status === 416 && have && !job.bytes) { drop(res); return; } // 不知道大小的文件：已经下完
    if (!res.ok || !res.body) { drop(res); throw (res.status >= 500 || res.status === 429 ? siteErr : (m) => new Error(m))(`HTTP ${res.status}`); }
    if (/text\/html/i.test(res.headers.get('content-type') ?? '')) { drop(res); throw siteErr('返回的是网页，不是文件'); }
    let append = false, total = 0;
    if (have && res.status === 206) {
      const m = /bytes (\d+)-\d+\/(\d+|\*)/.exec(res.headers.get('content-range') ?? '');
      if (!m || Number(m[1]) !== have) { drop(res); throw new Error('续传位置对不上'); }
      append = true;
      total = m[2] === '*' ? 0 : Number(m[2]);
    } else {
      total = Number(res.headers.get('content-length')) || 0;
      if (have) log(`${label}：${host(url)} 不支持接着下，从头下`);
      have = 0;
    }
    if (job.bytes && total && total !== job.bytes) { drop(res); throw new Error(`文件大小 ${total} 和记录的 ${job.bytes} 不一样`); }
    const full = total || job.bytes || 0;
    if (append) log(`${label}：接着上次的 ${mb(have)} 下（${host(url)}）`);
    else if (full >= PROGRESS_OVER) log(`${label}：开始下载（共 ${mb(full)}，${host(url)}）`);
    let got = 0, lastLog = Date.now();
    const t0 = Date.now();
    streaming++;
    ticker = setInterval(() => {
      const now = Date.now(), ms = now - t0;
      const need = Math.max(FLOOR_SPEED, MIN_SPEED / Math.max(1, streaming));
      if (ms > GRACE_MS && (got * 1000) / ms < need) return stop(`太慢（每秒 ${((got * 1000) / ms / 1024).toFixed(0)} KB）`);
      if (full >= PROGRESS_OVER && now - lastLog >= PROGRESS_MS && have + got < full) {
        lastLog = now;
        log(`${label}：已下 ${mb(have + got)} / 共 ${mb(full)}（${Math.floor(((have + got) / full) * 100)}%，每秒 ${mb((got * 1000) / Math.max(1, ms))}）`);
      }
    }, 1000);
    kick();
    const body = Readable.fromWeb(res.body);
    body.on('data', (c) => { got += c.length; kick(); });
    try { await pipeline(body, fs.createWriteStream(part, { flags: append ? 'a' : 'w' })); }
    catch (e) { throw retryable(why || reason(e)); }
    finally { streaming--; }
  } finally { clearTimeout(timer); if (ticker) clearInterval(ticker); }
}

// 下完以后核对。没下全：.part 留着接着下；校验不对：删掉
async function verify(part, job) {
  const n = sizeOf(part);
  if (job.bytes && n > job.bytes) throw new Error(`下下来的比应有的多了 ${mb(n - job.bytes)}，可能有别的程序同时在下这个文件`);
  if (job.bytes && n !== job.bytes) throw new Error(`只下了 ${mb(n)}，没下完整`);
  if (!n) throw new Error('下下来是空的');
  if (job.sha256 && (await sha256File(part)) !== job.sha256) { rm(part); throw Object.assign(new Error('校验不对，已删掉重下'), { corrupt: true }); }
}

// 目标文件已经由别的程序放好了（给了大小的核对大小；给了 sha256 的也核对）
async function doneByOther(job) {
  if (!fs.existsSync(job.dest) || (job.bytes && sizeOf(job.dest) !== job.bytes)) return false;
  return !job.sha256 || (await sha256File(job.dest)) === job.sha256;
}

// ---- 同一个文件同时只让一个程序下 ----
// 两个程序（比如同时跑了两个 setup）一起往同一个 .part 里写，会互相写坏、白下好几遍，最后谁都没下成。
// 下之前在旁边建一个 <目标>.tmp-lock，写进程号；别人正在下就等它下完。它的进程没了、或者 .part 两分钟没长，就接手。
// 名字带 .tmp-：打包时不带。
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function lockFile(job) {
  const lock = `${job.dest}.tmp-lock`, part = `${job.dest}.part`;
  let said = false, last = -1, still = Date.now();
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return () => { try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) rm(lock); } catch { /* 已经没了 */ } };
    } catch (e) { if (e.code !== 'EEXIST') return () => {}; } // 建不了锁（只读盘之类）：不拦
    let pid = 0, age = 0;
    try { pid = Number(fs.readFileSync(lock, 'utf8')); age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; } // 刚被放掉：再抢一次
    const n = sizeOf(part);
    if (n !== last) { last = n; still = Date.now(); }
    const owner = pid > 0 ? alive(pid) : age < 10000; // 读不出进程号：可能刚建好还没写进去
    if (!owner || Date.now() - still > 120000) { rm(lock); continue; }
    if (!said) { job.log(`${job.label}：别的程序正在下这个文件，等它下完`); said = true; }
    await sleep(1000);
  }
}

// 下载一个文件。job:{ dest, urls: [来源…], bytes?, sha256?, label?, log?, force? }
// 目标文件已经在、大小对（给了 bytes 的话）就直接返回。返回 { from: 站点 }；都没成功抛错，写明每个来源的原因。
export async function fetchFile(job) {
  const { dest } = job;
  const j = { label: path.basename(dest), log: () => {}, ...job };
  const part = `${dest}.part`;
  if (j.force) { rm(dest); rm(part); }
  if (fs.existsSync(dest)) {
    if (!j.bytes || sizeOf(dest) === j.bytes) return { from: '已经在了' };
    rm(dest);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const urls = [...new Set(j.urls.filter(Boolean))];
  if (!urls.length) throw new Error(`${j.label} 没有下载地址`);
  await slot();
  const unlock = await lockFile(j);
  try {
    if (await doneByOther(j)) return { from: '已经在了' }; // 等的时候别人已经下好了
    const why = [];
    for (let round = 0; round < 3; round++) {
      let progressed = false;
      const order = rank(urls);
      for (const [i, url] of order.entries()) {
        if (tripped.has(host(url))) continue; // 别的文件刚把它熔断了
        const before = sizeOf(part);
        try {
          if (await doneByOther(j)) return { from: '已经在了' };
          await attempt(url, part, j);
          await verify(part, j);
          try { fs.renameSync(part, dest); } catch (e) {
            // 别的程序（同时跑的另一个 setup）已经下好、改好名了：目标文件对得上就算成功
            if (await doneByOther(j)) return { from: '已经在了' };
            throw e;
          }
          strikes.set(host(url), Math.max(0, (strikes.get(host(url)) ?? 0) - 1));
          return { from: host(url) };
        } catch (e) {
          // 有进展、一时断了、或续上的部分是坏的：值得再来一轮（最多三轮）
          if (sizeOf(part) > before || e.again || (e.corrupt && before > 0)) progressed = true;
          // 只是这个文件的问题（404、校验不对）不记到站点头上
          const h = host(url);
          if (e.trip || e.again) strikes.set(h, (strikes.get(h) ?? 0) + 1);
          if ((e.trip || (e.early && strikes.get(h) >= 2)) && !tripped.has(h)) { tripped.set(h, e.message); j.log(`${h} ${e.message}，这次不再从它下载`); }
          why.push(`${h}：${e.message}`);
          const next = order.slice(i + 1).find((u) => !tripped.has(host(u))) ?? (progressed && round < 2 ? rank(urls)[0] : null);
          const to = !next ? '' : host(next) === h ? '，换同一站点的另一个地址' : `，换 ${host(next)}`;
          j.log(`${j.label}：${h} 没成功（${e.message}）${to}${sizeOf(part) ? `，已下的 ${mb(sizeOf(part))} 留着，下次接着下` : ''}`);
        }
      }
      if (!progressed) break;
    }
    // 熔断跳过的来源也写进原因，免得看起来像没试
    for (const u of urls) if (tripped.has(host(u)) && !why.some((w) => w.startsWith(`${host(u)}：`))) why.push(`${host(u)}：之前${tripped.get(host(u))}，跳过`);
    throw new Error(`${j.label} 没下载下来（${[...new Set(why)].join('；')}）`);
  } finally { unlock(); release(); }
}

// 几个文件同时下（每个 job 可带 onDone，下完或失败时调用）。返回和 jobs 一一对应的 { ok, from?, error? }，不抛错
export async function fetchAll(jobs) {
  const rs = await Promise.allSettled(jobs.map((j) => fetchFile(j).finally(() => j.onDone?.())));
  return rs.map((r) => (r.status === 'fulfilled' ? { ok: true, from: r.value.from } : { ok: false, error: r.reason?.message ?? String(r.reason) }));
}

// 下到一半的文件（doctor 用）
export function partialDownloads(dirs) {
  const out = [];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) if (n.endsWith('.part')) out.push({ file: path.join(d, n), bytes: sizeOf(path.join(d, n)) });
  }
  return out;
}
