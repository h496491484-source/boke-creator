#!/usr/bin/env node
// 一键安装：把剪播客要用的东西装进技能目录，装完自动自检。可以反复运行，已经装好的会跳过。
//
//   node tools/setup.mjs                      默认先走国内源，不开代理也能装（约 300 MB；缺 ffmpeg 时再下约 30 MB；配乐曲库不下）
//   node tools/setup.mjs --official           先走官方源（GitHub、npm 官方），国外网络用
//   node tools/setup.mjs --music              顺便把配乐曲库全部下好（约 52 MB；默认不下，剪辑用到哪首当场下哪首）
//   node tools/setup.mjs --model-file <压缩包>  识别模型用现成的压缩包（.tar.bz2）
//   node tools/setup.mjs --check              只看缺什么，不安装、不清理、不写本机配置
//   （--mirror 是旧写法，现在默认就是它）
//
// 装的东西和位置（都在技能目录里，不动系统）：
//   node_modules/        sherpa-onnx 本地识别程序，来自 npmmirror
//   models/sense-voice   识别模型（约 230 MB），来自魔搭
//   models/podcast       人声检测、说话人切分、声纹三个小模型（约 45 MB），来自魔搭
//   models/music         配乐曲库的曲子（CC0），来自魔搭；setup 只确认曲库清单在，曲子用到时再下（或 --music 全下）
//   .state/ffmpeg        找不到能用的 ffmpeg 时才下载，来自 npmmirror
// 唯一要自己先装的是 Node 18 以上。
//
// 缺的几样同时装（npm 和各个下载一起跑，同时最多下 4 个文件），大文件每 8 秒打印一次"已下 / 共"。
// 下载断了再运行一次会接着下，卡住或太慢会自动换下一个来源（见 lib/download.mjs）。
// 顺手清掉旧版本（v0.3 及以前）留下的东西：.state 里 ffmpeg 以外的和旧的 ffprobe、node_modules 里不属于识别程序的依赖
// 和它们在 .bin 里的命令入口、video-deps/、覆盖安装时残留的旧版文件（字体模板、示例成品、旧脚本，清单见 lib/leftovers.mjs 的 OLD_FILES）。
// 这些 tools/pack.mjs 打包时也都不带；删之前先列出清单。
// 同一个技能目录同时只跑一个 setup（.state/setup.lock）：两个一起下同一个文件会互相把 .part 写坏。

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, findFfmpeg, cmd } from './lib/env.mjs';
import { findSherpa, findModel } from './asr.mjs';
import { getModel, getPodcastModels, getMusic, modelReady } from './get-model.mjs';
import { getFfmpegFromMirror, mirrorSupported } from './get-ffmpeg.mjs';
import { oldLeftovers, SETUP_LOCK, SHERPA_MARK } from './lib/leftovers.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const official = flag('--official'), checkOnly = flag('--check'), allMusic = flag('--music');
const NPM_MIRROR = 'https://registry.npmmirror.com';
const say = (s) => console.log(s);
const t0 = Date.now();

// ---- Node ----
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  say(`[1/6] Node\n✗ Node 版本是 v${process.versions.node}，需要 18 或更新。到 https://nodejs.org 下载安装 LTS 版，再运行一次。`);
  process.exit(1);
}

// ---- 同一个技能目录同时只跑一个 setup（--check 不装不删，不用拿锁） ----
// 锁里写进程号，每分钟刷新一次时间；那个进程没了、或者 10 分钟没刷新（卡死、进程号被别人用了），就接手
if (!checkOnly) {
  const mine = () => JSON.stringify({ pid: process.pid, at: Date.now() });
  const take = () => { fs.mkdirSync(path.dirname(SETUP_LOCK), { recursive: true }); fs.writeFileSync(SETUP_LOCK, mine(), { flag: 'wx' }); };
  const busy = () => {
    let l = null;
    try { l = JSON.parse(fs.readFileSync(SETUP_LOCK, 'utf8')); } catch {
      // 读不出来：可能另一个 setup 刚建好锁、还没写进内容。刚建的（10 秒内）当作有人在跑
      try { return Date.now() - fs.statSync(SETUP_LOCK).mtimeMs < 10000 ? { pid: '?' } : null; } catch { return null; }
    }
    if (!l?.pid || l.pid === process.pid || !(Date.now() - l.at < 10 * 60000)) return null;
    try { process.kill(l.pid, 0); return l; } catch (e) { return e.code === 'EPERM' ? l : null; }
  };
  let got = false;
  for (let i = 0; i < 2 && !got; i++) {
    try { take(); got = true; } catch (e) {
      if (e.code !== 'EEXIST') break;              // 写不了锁（只读盘之类）：不拦，照常装
      if (busy()) break;
      fs.rmSync(SETUP_LOCK, { force: true });      // 上次的 setup 已经不在了：接手
    }
  }
  const other = got ? null : busy();
  if (other) {
    say(`setup 已经在跑了（进程 ${other.pid}），不要再开一个：两个一起下同一个文件会互相干扰。等它跑完、看它的输出就行；想看现在还缺什么：${cmd('tools/setup.mjs', '--check')}`);
    process.exit(3);
  }
  if (got) {
    const beat = setInterval(() => { try { fs.writeFileSync(SETUP_LOCK, mine()); } catch { /* 刷新不了不影响安装 */ } }, 60000);
    beat.unref();
    process.on('exit', () => { try { if (JSON.parse(fs.readFileSync(SETUP_LOCK, 'utf8')).pid === process.pid) fs.rmSync(SETUP_LOCK, { force: true }); } catch { /* 已经没了 */ } });
  }
}

// npm install。优先用和当前 node 放在一起的 npm（有的电脑 PATH 里没有 npm）。
// 每个源最多等 15 分钟；npm 自己的重试调小，连不上的源尽快换下一个。输出收起来，没装成才显示最后几行。
function npm(extra, log) {
  const dir = path.dirname(process.execPath);
  const cli = [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((p) => fs.existsSync(p));
  const a = ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error', '--update-notifier=false', '--fetch-retries=1', '--fetch-timeout=120000', ...extra];
  const o = { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
  return new Promise((resolve) => {
    let out = '', done = false, late = false;
    const s0 = Date.now();
    const end = (ok, why) => { if (!done) { done = true; clearTimeout(t); clearInterval(beat); resolve({ ok, why }); } };
    const p = cli ? spawn(process.execPath, [cli, ...a], o) : spawn('npm', a, { ...o, shell: true });
    const t = setTimeout(() => { late = true; p.kill(); }, 15 * 60 * 1000);
    const beat = setInterval(() => log(`还在装（${Math.round((Date.now() - s0) / 1000)} 秒）`), 10000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => end(false, `npm 跑不起来（${e.message}）`));
    p.on('close', (code) => end(code === 0, late ? '等了 15 分钟还没装完，放弃这个源' : out.trim().split(/\r?\n/).slice(-3).join(' / ')));
  });
}

// ---- 要装的几样：ready() 看装没装好，run(log) 去装，返回 { ok, msg } ----
const { podcastModelsReady, sherpaLoads, sherpaLibEnv } = await import('./lib/podcast.mjs');
const { loadLibrary, trackReady } = await import('./lib/library.mjs');
let lib = [], libErr = null;
try { lib = loadLibrary().filter((t) => t.url); } catch (e) { libErr = e.message; }
const musicMiss = () => lib.filter((t) => !trackReady(t));
const mbs = (list) => (list.reduce((s, t) => s + (t.bytes ?? 0), 0) / 1048576).toFixed(0);
// 识别程序要真的加载得起来才算装好（和自检一样）：只看文件在不在的话，平台包缺了、dll 被杀毒软件隔离了，
// setup 说"已经装好"、自检说"加载不起来，运行 setup"，来回打转。结果记下来，别每次都起一个进程
let sherpaState = null;
const sherpaOk = (fresh) => { if (fresh || sherpaState === null) sherpaState = sherpaLoads(findSherpa({})); return sherpaState; };
const sherpaPlatName = `sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const sherpaPlatDir = path.join(ROOT, 'node_modules', sherpaPlatName);
// 上次 setup 换来源时被打断（宿主杀了后台任务）留下的 .state/<平台包>.bad：走到这里说明那个 setup 已经不在了，删掉。
// 它不算旧版残留（lib/leftovers.mjs 不列它，setup 在后台跑的时候 start、doctor 不会报"旧版残留"，2026-11-24 第 3 轮 1）
if (!checkOnly) try { fs.rmSync(path.join(ROOT, '.state', `${sherpaPlatName}.bad`), { recursive: true, force: true }); } catch { /* 删不掉：下次再删 */ }
// 加载不起来的真正原因：sherpa-onnx-node 自己只会说"Could not find sherpa-onnx-node"，所以再直接加载一次平台包里的 .node 拿报错
function sherpaLoadErr() {
  const s = findSherpa({});
  if (!s.ok) return '';
  const node = path.join(s.dir, 'node_modules', sherpaPlatName, 'sherpa-onnx.node');
  const code = `try{require(${JSON.stringify(s.pkg)})}catch(e){let m=e.message;try{require(${JSON.stringify(node)})}catch(e2){m=e2.message}console.error('LOADERR '+m);process.exit(1)}`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...sherpaLibEnv(s) } });
  const m = /LOADERR (.*)/.exec(r.stderr ?? '');
  return (m ? m[1] : String(r.stderr ?? '').trim().split(/\r?\n/).at(-1) ?? '').trim().slice(0, 200);
}
const sherpaCause = {
  win32: `多半是这台电脑缺微软的 VC++ 运行库：到 https://aka.ms/vs/17/release/vc_redist.${process.arch === 'arm64' ? 'arm64' : 'x64'}.exe 下载安装，装完再运行一次。也可能是杀毒软件把 ${sherpaPlatName} 里的 dll 隔离了：在杀毒软件里恢复，把技能目录加进信任`,
  darwin: '多半是系统拦了下载来的动态库：系统设置 → 隐私与安全性里放行，或在终端运行 xattr -dr com.apple.quarantine 技能目录/node_modules',
}[process.platform] ?? '多半是系统太旧或缺系统库（识别程序要比较新的 glibc）';
// 删掉平台包重装、npm 也装成了还是加载不起来，就不是包坏了：记下平台包当时的修改时间，平台包没动过就不再删了重装（省得每次都重下）
const platStamp = () => { try { return fs.statSync(sherpaPlatDir).mtimeMs; } catch { return null; } };
const readMark = () => { try { return JSON.parse(fs.readFileSync(SHERPA_MARK, 'utf8')); } catch { return null; } };
// Windows ARM（骁龙）：winget 装的也是 x64 版，Windows 11 能跑、Windows 10 ARM 跑不了（审查 87 复核）
const ffFix = process.platform === 'win32' ? `winget install Gyan.FFmpeg${process.arch === 'arm64' ? '（Windows 10 的 ARM 电脑跑不了这个 x64 版：自己找 ARM 版 ffmpeg，把所在文件夹写进环境变量 FFMPEG_DIR）' : ''}` :process.platform === 'darwin' ? 'brew install ffmpeg' : '用系统的包管理器安装 ffmpeg';

const items = [
  {
    tag: '识别程序', title: '识别程序（在本机把录音转成文字）', ready: sherpaOk,
    readyMsg: '✓ 已经装好',
    get missMsg() { if (!findSherpa({}).ok) return '✗ 还没装'; const err = sherpaLoadErr(); return `✗ 文件在，但加载不起来${err ? `（${err}）` : ''}`; },
    async run(log) {
      const s = findSherpa({});
      const loadFail = (why) => { const err = sherpaLoadErr(); return `✗ 识别程序装好了，但加载不起来${err ? `（${err}）` : ''}。${why ?? ''}这不是网络问题：${sherpaCause}。`; };
      // 环境变量 SHERPA_ONNX_DIR 指的那份排在技能目录前面：在技能目录里重装也没用，不用联网
      if (s.ok && s.dir !== ROOT) {
        const err = sherpaLoadErr();
        return { ok: false, msg: `✗ 环境变量 SHERPA_ONNX_DIR 指的 ${s.dir} 里的识别程序加载不起来${err ? `（${err}）` : ''}。这不是网络问题：删掉这个环境变量（改用技能目录里装的），或者改成一份能用的，重开终端再运行一次。`, todo: '识别程序（SHERPA_ONNX_DIR 指的那份加载不起来）' };
      }
      // 上次删掉重装过、npm 也装成了还是加载不起来，平台包之后也没动过：再重装也一样，直接说原因
      const mark = readMark(), stamp = platStamp();
      if (s.ok && mark && stamp !== null && mark.stamp === stamp) {
        return { ok: false, msg: loadFail('上次已经删掉重装过，还是一样，这次不再重装。') + `确实想再重装一次：删掉 ${path.relative(ROOT, sherpaPlatDir)} 再运行。`, todo: '识别程序（装好了但加载不起来，办法见上面）' };
      }
      // 文件在却加载不起来：多半是平台包坏了（缺文件、dll 被隔离）。npm 看目录在就说"已是最新"，不会补，所以先删掉它再装
      if (s.ok && fs.existsSync(sherpaPlatDir)) {
        log(`识别程序加载不起来，删掉 ${path.relative(ROOT, sherpaPlatDir)} 重新装`);
        try { fs.rmSync(sherpaPlatDir, { recursive: true, force: true }); } catch (e) { log(`删不掉（${e.code ?? e.message}），可能正被占用：关掉正在转写的窗口再试`); }
      }
      // npm 退出码 0 不等于装好了：平台包是可选依赖，下载它时网断了（或镜像缺这个包）npm 照样退出 0，只是没装上。
      // 所以每个来源装完都真的加载一次，加载不起来就换下一个来源，都不行才报错（2026-11-23 合并后修 e9031a8 的回退）
      const sources = [['国内镜像 npmmirror', [`--registry=${NPM_MIRROR}`]], ['npm 官方源', []]];
      if (official) sources.reverse();
      let noPlat = false, loadBad = false;
      const bak = path.join(ROOT, '.state', `${sherpaPlatName}.bad`);
      for (let i = 0; i < sources.length; i++) {
        const [label, extra] = sources[i], last = i === sources.length - 1;
        log(`从${label}安装……`);
        const r = await npm(extra, log);
        if (r.ok && sherpaOk(true)) { fs.rmSync(SHERPA_MARK, { force: true }); fs.rmSync(bak, { recursive: true, force: true }); return { ok: true, msg: `✓ 装好了（${label}）` }; }
        if (!r.ok) { log(`${label}没装成${r.why ? `：${r.why}` : ''}`); continue; }
        if (platStamp() === null) {
          noPlat = true;
          log(`${label}：npm 说装完了，但 ${sherpaPlatName} 没装上（多半是下载它的时候网断了）${last ? '' : '，换下一个来源'}`);
          continue;
        }
        loadBad = true;
        if (last) break;
        // 装上了还是加载不起来：先挪开（npm 看目录在就不会重下），换下一个来源再装一次；下一个来源没装上就挪回来
        log(`${label}装好了，但识别程序加载不起来，换下一个来源再试`);
        try { fs.rmSync(bak, { recursive: true, force: true }); fs.mkdirSync(path.dirname(bak), { recursive: true }); fs.renameSync(sherpaPlatDir, bak); } catch (e) { log(`挪不开 ${path.relative(ROOT, sherpaPlatDir)}（${e.code ?? e.message}），不再换来源`); break; }
      }
      if (platStamp() === null && fs.existsSync(bak)) try { fs.renameSync(bak, sherpaPlatDir); } catch { /* 挪不回来：下次 setup 重新装 */ }
      fs.rmSync(bak, { recursive: true, force: true });
      if (loadBad && platStamp() !== null) {
        try { fs.mkdirSync(path.dirname(SHERPA_MARK), { recursive: true }); fs.writeFileSync(SHERPA_MARK, JSON.stringify({ stamp: platStamp(), err: sherpaLoadErr(), at: new Date().toISOString() })); } catch { /* 记不下来：下次再重装一次而已 */ }
        return { ok: false, msg: loadFail(), todo: '识别程序（装好了但加载不起来，办法见上面）' };
      }
      if (noPlat) return { ok: false, msg: `✗ npm 装完了，但 ${sherpaPlatName}（识别程序本体）哪个来源都没装上。多半是网络问题（下载它的时候断了）：换个网络再运行一次。换了网络还是这样，可能这种电脑（${process.platform}-${process.arch}）没有现成的识别程序，把这句话发给帮你的人。`, todo: '识别程序（平台包没装上）' };
      return { ok: false, msg: '✗ 没装成。多半是网络问题：换个网络后再运行一次。', todo: '识别程序（npm install 没成功）' };
    },
  },
  {
    tag: '识别模型', title: '识别模型（约 230 MB）', ready: () => modelReady() || findModel().ok,
    readyMsg: '✓ 已经有了', missMsg: '✗ 还没下载',
    async run(log) {
      try {
        const r = await getModel({ file: opt('--model-file'), dir: opt('--model-dir'), official, log });
        return { ok: true, msg: `✓ 装好了（来源：${r.from}）` };
      } catch (e) { return { ok: false, msg: `✗ ${e.message}`, todo: '识别模型' }; }
    },
  },
  {
    tag: '播客模型', title: '播客精编用的模型（约 45 MB）', ready: podcastModelsReady,
    readyMsg: '✓ 已经有了', missMsg: '✗ 还没下载',
    async run(log) {
      try {
        await getPodcastModels({ dir: opt('--podcast-model-dir'), official, log });
        return { ok: true, msg: '✓ 装好了' };
      } catch (e) { return { ok: false, msg: `✗ ${e.message}`, todo: '播客精编用的模型' }; }
    },
  },
  {
    // 配乐曲库：魔搭上的 CC0 曲子。默认只确认曲库清单在，曲子剪辑用到哪首当场下哪首；--music 才全下。
    // 缺几首不影响剪辑（下不下来用随包带的 Aurora），不算安装失败
    tag: '配乐', title: `配乐曲库（${lib.length} 首${allMusic && musicMiss().length ? `，还要下载约 ${mbs(musicMiss())} MB` : ''}）`,
    ready: () => !allMusic || !musicMiss().length, soft: true,
    get readyMsg() {
      if (libErr) return `✗ ${libErr}`;
      if (!lib.length) return '✓ 只有随包带的默认配乐';
      const n = musicMiss().length;
      return n ? `✓ 曲库清单在；已下 ${lib.length - n} 首，其余 ${n} 首剪辑用到时当场下（想提前全下：${cmd('tools/setup.mjs', '--music')}）` : `✓ ${lib.length} 首都下好了`;
    },
    get missMsg() { return `△ 还差 ${musicMiss().length} 首（不影响剪辑，用到时会自动下载）`; },
    async run(log) {
      const r = await getMusic({ log });
      return r.failed.length
        ? { ok: true, msg: `△ 还差 ${r.failed.length} 首没下下来。不影响剪辑：用到时会再试着下载，下不下来就用默认的 Aurora。网络好的时候再运行一次 setup。` }
        : { ok: true, msg: '✓ 装好了' };
    },
  },
  {
    tag: 'ffmpeg', title: 'ffmpeg（读写音频）', ready: () => findFfmpeg().ok,
    get readyMsg() { const ff = findFfmpeg(); return `✓ ${ff.version}（${ff.from}）`; }, missMsg: '✗ 没找到',
    async run(log) {
      if (mirrorSupported()) {
        log('没找到能用的 ffmpeg，下载一份放进技能目录（不动系统）……');
        try { await getFfmpegFromMirror({ official, log }); } catch (e) { log(`没下载成功（${e.message}）`); }
      } else log(`没有这种电脑（${process.platform}-${process.arch}${process.platform === 'win32' && process.arch === 'arm64' ? '，Windows 10' : ''}）能直接下载的 ffmpeg，要自己装`);
      const ff = findFfmpeg();
      if (ff.ok) return { ok: true, msg: `✓ 装好了：${ff.version}` };
      return { ok: false, msg: `✗ 没装成。可以自己装：${ffFix}，装完重开终端再运行一次。`, todo: `ffmpeg（${ffFix}）` };
    },
  },
];

// ---- 旧版本（v0.3 及以前）留下的东西：清单和规则见 lib/leftovers.mjs（start、doctor 看到了会提示运行 setup） ----
const old = oldLeftovers();
if (old.length) {
  const total = old.reduce((s, x) => s + x.bytes, 0);
  say(`${checkOnly ? '可以清理' : '清理'}旧版本留下的东西，共 ${(total / 1048576).toFixed(0)} MB：`);
  for (const x of old) say(`  · ${path.relative(ROOT, x.p)}（${(x.bytes / 1048576).toFixed(1)} MB）`);
  if (!checkOnly) {
    const failed = [];
    for (const x of old) { try { fs.rmSync(x.p, { recursive: true, force: true }); } catch (e) { failed.push(`${path.relative(ROOT, x.p)}（${e.code ?? e.message}）`); } }
    try { fs.rmdirSync(path.join(ROOT, 'examples')); } catch { /* 不是空的或者本来就没有：不动 */ }
    say(failed.length ? `  有 ${failed.length} 项没删掉（可能正被占用，不影响使用）：${failed.join('、')}` : '  已清理');
  }
}

const todo = [];   // 没装成、需要人处理的
const head = (i) => say(`\n[${i + 2}/6] ${items[i].title}`);
const pending = items.filter((it) => !it.ready());

if (checkOnly || !pending.length) {
  say(`[1/6] Node\n✓ Node v${process.versions.node}`);
  items.forEach((it, i) => {
    head(i);
    const ok = it.ready();
    say(ok ? it.readyMsg : it.missMsg);
    if (!ok && !it.soft) todo.push(it.tag);
  });
} else {
  say(`✓ Node v${process.versions.node}`);
  say(`要装：${pending.map((it) => it.tag).join('、')}。同时装，进度如下（断了再运行一次会接着下）：`);
  // 一起开始；下载按开始的先后排队（识别模型最大，排最前）
  const results = new Map(await Promise.all(pending.map(async (it) => {
    const log = (s) => say(`  [${it.tag}] ${String(s).trim()}`);
    try { return [it, await it.run(log)]; } catch (e) { return [it, { ok: false, msg: `✗ ${e.message}`, todo: it.tag }]; }
  })));
  say(`\n—— 安装结果（用时 ${Math.round((Date.now() - t0) / 1000)} 秒）——`);
  say(`[1/6] Node\n✓ Node v${process.versions.node}`);
  items.forEach((it, i) => {
    head(i);
    const r = results.get(it);
    say(r ? r.msg : it.readyMsg);
    if (r?.todo) todo.push(r.todo);
  });
}

if (!checkOnly && sherpaOk()) fs.rmSync(SHERPA_MARK, { force: true }); // 后来能加载了（比如装了 VC++ 运行库）：记号没用了

// ---- 收尾：跑一次完整自检 ----
say('\n—— 自检 ——');
const doc = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'doctor.mjs'), ...(checkOnly ? ['--no-save'] : [])], { stdio: 'inherit', windowsHide: true }); // --check 只看，不写本机配置
if (todo.length) say(`\n还有 ${todo.length} 项要处理：\n${todo.map((t) => '  · ' + t).join('\n')}\n处理完再运行一次：${cmd('tools/setup.mjs')}`);
process.exit(doc.status === 0 && !todo.length ? 0 : 1);
