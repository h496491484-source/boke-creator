// 旧版本（v0.3 及以前）留下的东西。setup 删它们（删之前列清单）；start、doctor 的自检看到了提示运行 setup。
// 拿不准的不删：
// · .state/ 里 ffmpeg 以外的（旧版渲染依赖的更新检查记录；setup 自己的锁 setup.lock、sherpa-reinstalled.json 和换来源时挪开的 sherpa-onnx-*.bad 不算），
//   还有 .state/ffmpeg/bin 里旧版下的 ffprobe（现在用不着，pack.mjs 也不带）
// · node_modules/ 里名字不是 sherpa-onnx 开头、也不在 package-lock.json 里的包（.package-lock.json 不动）
// · node_modules/.bin 里的命令入口：留下的包都没声明这个命令的（指向的包已经删了或者这次要删）
// · 技能目录第一层的 video-deps/
// · 技能目录第一层 v0.3 的 开发说明.md、.gitignore（按内容认，git 仓库里不删）
// · 旧版（v0.3 及以前）随包带、v0.4 起删掉的文件（OLD_FILES）。旧模板自己改过的也会删：
//   setup --check 能先看清单
// tools/pack.mjs 在 git 仓库里打包时这些都不会打进分发包；不在 git 里、按白名单打时，OLD_FILES 里 tools/、references/ 下的
// 旧文件要是还在会被打进去（白名单按目录收），所以在不是 git 仓库的地方打包前先运行 setup 清掉。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.mjs';

export const OLD_FILES = [
  'examples/示例_只说一件事', 'template/黑金水墨',
  'references/口播视频流程.md', 'references/录音指南.md', 'references/画面怎么配.md', 'references/稿子写法.md', 'references/表达卡怎么聊.md',
  ...['align', 'beats', 'build', 'clean', 'demo-voice', 'make', 'new', 'qc', 'status', 'storyboard'].map((n) => `tools/${n}.mjs`),
  'tools/lib/script.mjs',
];
export const SETUP_LOCK = path.join(ROOT, '.state', 'setup.lock');
// setup 记的"识别程序重装过还是加载不起来"（下次别再删了重装），也不算旧版残留
export const SHERPA_MARK = path.join(ROOT, '.state', 'sherpa-reinstalled.json');
// setup 换来源重装识别程序时，把加载不起来的平台包先挪到 .state/sherpa-onnx-<平台>.bad（装好了就删）：不是旧版残留，
// setup 在后台跑的时候 start、doctor 不能把它报成"旧版残留"，下次 setup 也不能当旧版删（2026-11-24 第 3 轮 1）
const SHERPA_BAK = /^sherpa-onnx-.*\.bad$/;
// 内容认得出是 v0.3 的才删（按旧版 开发说明.md 里特有的句子认），.gitignore 里有 examples/*/voice.wav
const OLD_BY_CONTENT = [['开发说明.md', /一条片子是怎么出来的|口播稿\.txt/], ['.gitignore', /examples\/\*\/voice\.wav/]];

export function dirBytes(p) {
  let n = 0;
  try {
    const st = fs.lstatSync(p);
    if (!st.isDirectory()) return st.size;
    for (const e of fs.readdirSync(p)) n += dirBytes(path.join(p, e));
  } catch { /* 读不了的不算 */ }
  return n;
}

// 一个包声明的命令名（package.json 的 bin）
function binsOf(pkgDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    if (typeof j.bin === 'string') return [String(j.name ?? '').split('/').pop()];
    return Object.keys(j.bin ?? {});
  } catch { return []; }
}

// 返回 [{ p: 绝对路径, bytes }]；sizes: false 时不算大小（start 用，快）
export function oldLeftovers({ sizes = true } = {}) {
  const out = [];
  const list = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  for (const n of list(path.join(ROOT, '.state'))) if (n !== 'ffmpeg' && n !== path.basename(SETUP_LOCK) && n !== path.basename(SHERPA_MARK) && !SHERPA_BAK.test(n)) out.push(path.join(ROOT, '.state', n));
  for (const n of ['ffprobe', 'ffprobe.exe']) if (fs.existsSync(path.join(ROOT, '.state', 'ffmpeg', 'bin', n))) out.push(path.join(ROOT, '.state', 'ffmpeg', 'bin', n));
  const nm = path.join(ROOT, 'node_modules');
  let locked = null;
  try { locked = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')).packages ?? {})); } catch { /* 锁文件读不出来：依赖一个都不删 */ }
  if (locked) {
    const keep = (rel) => /^node_modules\/sherpa-onnx/.test(rel) || locked.has(rel);
    const kept = []; // 留下的包，看它们声明了哪些命令
    for (const n of list(nm)) {
      if (n.startsWith('.')) continue;
      if (n.startsWith('@')) {
        const subs = list(path.join(nm, n));
        const gone = subs.filter((s) => !keep(`node_modules/${n}/${s}`));
        subs.filter((s) => !gone.includes(s)).forEach((s) => kept.push(path.join(nm, n, s)));
        if (gone.length === subs.length) out.push(path.join(nm, n));
        else for (const s of gone) out.push(path.join(nm, n, s));
      } else if (!keep(`node_modules/${n}`)) out.push(path.join(nm, n));
      else kept.push(path.join(nm, n));
    }
    // .bin 里的命令入口（Windows 上一个命令有 xx、xx.cmd、xx.ps1 三个）：留下的包没声明这个命令的，就是旧包留下的
    const bins = new Set(kept.flatMap(binsOf));
    for (const n of list(path.join(nm, '.bin'))) if (!bins.has(n.replace(/\.(cmd|ps1)$/i, ''))) out.push(path.join(nm, '.bin', n));
  }
  if (fs.existsSync(path.join(ROOT, 'video-deps'))) out.push(path.join(ROOT, 'video-deps'));
  // 解压新版覆盖旧版时，旧版自带、新版已经没有的文件还留着（字体模板、示例成品、旧脚本和说明）：
  // 留着占地方，旧脚本和说明还可能让 AI 走错路。只删这张清单上的，别的不碰
  for (const rel of OLD_FILES) if (fs.existsSync(path.join(ROOT, rel))) out.push(path.join(ROOT, rel));
  // 新包不带 开发说明.md、.gitignore，覆盖安装盖不掉旧版的（2026-11-24 第 3 轮 15）。只删认得出是旧版的那份，
  // 而且只在不是 git 仓库的地方删：维护者的仓库里这两个文件是现在的
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    for (const [rel, old] of OLD_BY_CONTENT) {
      try { if (old.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) out.push(path.join(ROOT, rel)); } catch { /* 没有、读不了：不动 */ }
    }
  }
  return out.map((p) => ({ p, bytes: sizes ? dirBytes(p) : 0 }));
}
