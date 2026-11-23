#!/usr/bin/env node
// 开一期新节目：建文件夹，把原始录音放进来（同一个盘用硬链接、别的盘只记位置，都不复制，原文件不动），写一份待填的 节目信息.md。
//
//   node tools/podcast/new.mjs <节目目录> <录音文件> [更多录音文件……] [--show <节目档案所在的文件夹>] [--copy]
//   node tools/podcast/new.mjs <节目目录> --forget <登记的录音名>      去掉 录音位置.json 里一条登记（录音不要了、换成别的了）
//                                                                    （节目目录里的录音——同盘硬链接、--copy 的——不在登记里：要去掉就挪出节目目录，--forget 会这样提示）
//
// --copy：完整复制一份进来（和原文件互不影响；默认同一个盘用硬链接，原文件在原位置被改了，这期的录音也跟着变）。
// 录音有好几段（比如前后半场）就都给上，顺序以 节目信息.md 里的"录音顺序"为准。
// 节目目录建在节目文件夹下（和 节目档案/ 并排）就会自动用上档案；不在一起时用 --show 指定。

import fs from 'node:fs';
import path from 'node:path';
import { episode, AUDIO, AUDIO_EXTS, VIDEO, extractCmd, cmd, readJson, writeJson, extFile, INFO_GUIDE, sameName, safeName, recordingsInfo, recordingMode, streamsAskMsg, recName, readInfo, infoBlank, MT_NO_SPLICE, badRecordings, badRecMsg } from '../lib/podcast.mjs';
import { SHOW_DIR, readShow, loadShow, showRef, noShowHint, isShowFolder, showFolderMsg } from '../lib/show.mjs';

const argv = process.argv.slice(2);
const WITH_VALUE = ['--show', '--forget'];
const [dir, ...files] = argv.filter((a, i) => !a.startsWith('--') && !WITH_VALUE.includes(argv[i - 1]));
const forget = argv.flatMap((a, i) => (argv[i - 1] === '--forget' ? [a] : []));
const copyMode = argv.includes('--copy');
if (!dir) { console.error(`用法: ${cmd('new.mjs')} <节目目录> <录音文件> [更多录音文件……] [--show <节目文件夹>] [--copy] [--forget <登记的录音名>]`); process.exit(2); }
const e = episode(dir);
// 给的是节目文件夹（下面有 节目档案/）：不能把它当成一期，新的一期建在它下面
if (isShowFolder(e.work)) { console.error(showFolderMsg(e.work)); process.exit(1); }
// "<录音文件>"占位原样照抄过来的：说清楚要换成真的路径（不然只会报"找不到录音"）
const holder = files.find((f) => /^<.*>$/.test(f));
if (holder) { console.error(`"${holder}" 是占位，要换成录音文件的完整路径（有几个文件就都写上），再运行。`); process.exit(2); }
if (forget.length && !files.length && !fs.existsSync(e.work)) { console.error(`没有这个节目目录：${e.work}`); process.exit(1); }
fs.mkdirSync(e.mid, { recursive: true });

// 录音不再完整复制一份（一小时的 wav 就是几百 MB）：
//   同一个盘：硬链接放进节目目录（看着是一个文件，不多占空间；原文件删了这里照样在。但它和原文件是同一个文件：
//            在原位置改了原文件、用同名文件覆盖，这期的录音也跟着变——输出里要说清楚；要独立的一份用 --copy）
//   别的盘：不拷贝，在 录音位置.json 记下原文件在哪，转写直接读原文件；
//   同一个盘但不支持硬链接（U 盘的 exFAT/FAT32）：一样只记位置，提示说的是"这个盘不支持硬链接"，不说"在别的盘"。
//   原文件被移走、删掉，transcribe / status 会说清楚。已经登记过的同名录音再 new 一次 = 改登记的位置（录音挪了地方时用）；
//   挪走又改了名：找不到的旧登记里大小一样的（旧版没记大小的：只丢了这一个、这次也只给一个），沿用旧名字、只换位置，
//   录音没变就不用重做；对不上时用 --forget <名字> 去掉旧登记。
//   同一次给了两个同名文件（两个文件夹里都叫 rec.mp3）：后面的改名叫 rec_2.mp3，不互相顶掉（2026-11-20 审查 F3）
const copied = [], linked = [], fullCopies = [], external = [], nolink = [], replaced = [], renamed = [], sanitized = [];
const ext = readJson(extFile(e), { files: [] });
ext.files = (ext.files ?? []).filter((x) => x?.name && x?.path);
let extChanged = false;
for (const n of forget) {
  const hit = ext.files.filter((x) => sameName(n, x.name));
  // 同一个盘硬链接进来的、--copy 拷进来的录音就在节目目录里，不在登记里：说清楚怎么去掉（2026-11-22 审查）
  const here = !hit.length && fs.existsSync(e.work) ? fs.readdirSync(e.work).filter((x) => AUDIO.test(x) && !x.startsWith('.')).find((x) => x === n || sameName(n, x)) : null;
  if (here) { console.error(`「${here}」是放在节目目录里的录音（同一个盘用的硬链接，或者 --copy 拷进来的），不在 录音位置.json 里，--forget 去不掉它。不要了就把它挪出节目目录（硬链接挪走、删掉都不影响原文件）：${path.join(e.work, here)}。然后改掉 节目信息.md 的"录音顺序"（还有"音轨对应"）里的它，${fs.existsSync(e.full) ? `再重新运行 ${cmd('transcribe.mjs', e.work)}（录音变了，会整期重新识别，句子编号会变，编排方案要重新检查）` : `再运行 ${cmd('transcribe.mjs', e.work)}`}。`); process.exit(1); }
  if (!hit.length) { console.error(`录音位置.json 里没有登记「${n}」${ext.files.length ? `，登记的有：${ext.files.map((x) => x.name).join('、')}` : '（什么都没登记）'}。`); process.exit(1); }
  ext.files = ext.files.filter((x) => !hit.includes(x));
  // 记下是主动去掉的：status 不再说成"录音不见了、放回来"
  ext.forgotten = [...new Set([...(ext.forgotten ?? []), ...hit.map((x) => x.name)])];
  extChanged = true;
  console.log(`去掉了登记：${hit.map((x) => `「${x.name}」（${x.path}）`).join('、')}`);
  console.log(`注意：这期之后按剩下的录音转写。节目信息.md 的"录音顺序""录音方式"要是写了它，记得改掉；然后重新运行 ${cmd('transcribe.mjs', e.work)}（录音变了，会整期重新识别，句子编号会变，编排方案要重新检查）。`);
}
const stOf = (p) => { try { return fs.statSync(p, { bigint: true }); } catch { return null; } };
const sameFile = (a, b) => !!a && !!b && a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
const used = new Set();
const lostEntries = () => ext.files.filter((x) => !fs.existsSync(x.path));
const outside = files.filter((f) => path.dirname(path.resolve(f)) !== e.work);
for (const f of files) {
  if (!fs.existsSync(f)) { console.error(`找不到录音：${f}`); process.exit(1); }
  if (VIDEO.test(f)) { console.error(`这是视频文件，技能只剪声音：${f}。先把声音提取出来：${extractCmd(f)}，再把提取出来的文件给 new.mjs`); process.exit(1); }
  if (!AUDIO.test(f)) { console.error(`不是能用的录音格式：${f}。能用的有 ${AUDIO_EXTS}；别的格式先用别的软件转成 wav 或 mp3 再放进来`); process.exit(1); }
  const src = path.resolve(f), st = stOf(src);
  // 1. 这期已经有它了：节目目录里有同一个文件（硬链接、本来就放在这里），或者登记过同一个位置
  if (path.dirname(src) === e.work) { const n = path.basename(src); copied.push(n); used.add(n); continue; } // 本来就放在节目目录里
  const local = fs.readdirSync(e.work).filter((n) => AUDIO.test(n) && !n.startsWith('.')).find((n) => sameFile(stOf(path.join(e.work, n)), st));
  const reg = ext.files.find((x) => path.resolve(x.path) === src);
  if (local || reg) { const n = local ?? reg.name; copied.push(n); used.add(n); continue; }
  // 2. 挪走（又改了名）的录音重新登记：沿用找不到的那条旧登记的名字，只换位置
  const lost = lostEntries();
  const bySize = lost.filter((x) => x.size != null && Number(x.size) === Number(st.size));
  const old = bySize.length === 1 ? bySize[0] : !bySize.length && lost.length === 1 && lost[0].size == null && outside.length === 1 ? lost[0] : null;
  if (old) {
    replaced.push({ name: old.name, from: old.path, to: src });
    Object.assign(old, { path: src, size: Number(st.size), mtime: Math.round(Number(st.mtimeMs)) });
    extChanged = true; copied.push(old.name); used.add(old.name);
    continue;
  }
  // 3. 起名：文件名里的反引号、空格之类在命令行里容易出事，换成安全的字符；和这期已有的别的录音重名就加 _2、_3
  const base = safeName(path.basename(f));
  const { name: stem, ext: dot } = path.parse(base);
  const taken = (n) => used.has(n) || fs.existsSync(path.join(e.work, n)) || ext.files.some((x) => x.name === n && fs.existsSync(x.path));
  let name = base;
  for (let k = 2; taken(name); k++) name = `${stem}_${k}${dot}`;
  // 改了名都要说（只换了空格、& % 之类也说），主理人照原名写节目信息时心里有数（2026-11-22 审查 75）
  if (name !== base) renamed.push({ from: path.basename(f), to: name });
  else if (base !== path.basename(f)) sanitized.push({ from: path.basename(f), to: name });
  used.add(name); copied.push(name);
  const dest = path.join(e.work, name);
  const before = ext.files.length;
  ext.files = ext.files.filter((x) => x.name !== name); // 以前登记过同名、现在找不到的：按这次的来
  if (ext.files.length !== before) extChanged = true;
  if (copyMode) { fs.copyFileSync(src, dest); fullCopies.push(name); continue; }
  try { fs.linkSync(src, dest); linked.push(name); continue; } catch (err) {
    if (err.code !== 'EXDEV') nolink.push(name); // 同一个盘，但这个盘不支持硬链接（exFAT/FAT32 之类）
  }
  ext.files.push({ name, path: src, size: Number(st.size), mtime: Math.round(Number(st.mtimeMs)) });
  extChanged = true;
  external.push({ name, path: src });
}
if (extChanged || (fs.existsSync(extFile(e)) && (linked.length || fullCopies.length))) writeJson(extFile(e), { 说明: `这期的原始录音没有拷进节目目录（在别的盘上，或者这个盘不支持硬链接），转写直接读这里记的位置。剪完之前别挪、别删、别改这些文件。录音挪了地方（改了名也一样）：运行 ${cmd('new.mjs', e.work, '<录音的新位置>')} 重新登记（"<录音的新位置>"换成完整路径）`, files: ext.files, ...(ext.forgotten?.length ? { forgotten: ext.forgotten.filter((n) => !ext.files.some((x) => x.name === n)) } : {}) }, 2);

// 节目档案：从节目目录往上找（或 --show 指定）。找到了，节目名、主持人、目标时长这些直接从档案带过来
const showOpt = (() => { const i = process.argv.indexOf('--show'); return i >= 0 ? process.argv[i + 1] : null; })();
const show = showOpt ? (() => { const p = path.resolve(showOpt); const d = fs.existsSync(path.join(p, SHOW_DIR, '档案.md')) ? path.join(p, SHOW_DIR) : p; if (!fs.existsSync(path.join(d, '档案.md'))) { console.error(`--show 指的地方没有 档案.md：${p}`); process.exit(1); } return readShow(d); })() : loadShow(e);
const fromShow = (k, hint) => show?.get(k) || hint;

const infoExisted = fs.existsSync(e.info);
if (!infoExisted) {
  fs.writeFileSync(e.info, `# 节目信息

${INFO_GUIDE}
${show ? `节目名、主持人、目标时长、发布平台是从节目档案带过来的，这期不一样就直接改。片头片尾、配乐、响度、常错词、剪辑偏好在档案里。\n` : ''}
- 节目档案：${showOpt ? path.relative(e.work, show.dir) || '.' : show ? `（不用填：程序从节目目录往上自动找，现在用的是 ${path.relative(e.work, show.dir)}；这期挪进子文件夹也找得到）` : '（这档节目的 节目档案 文件夹在哪；没有就写"无"）'}
- 节目名：${fromShow('节目名', '（比如"某某播客"）')}
- 本期主题：（主持人原话怎么说的，比如"穷过日子时代，你的消费观"）
- 主持人：${fromShow('主持人', '（称呼）')}
- 嘉宾：（几个人、各自的称呼；记不全写"约 N 人"；只有主持人一个人就写"单人"）
- 录音是否完整：（给的是不是全部录音；不是的话还差什么）
- 录音方式：${copied.length > 1 ? '（几个文件是"前后接着"录的，还是"多轨"——每人一个话筒、各录一个文件、同时录的？二选一）' : '单个文件'}
- 录音顺序：${copied.length > 1 ? copied.join('、') : '（只有一个文件不用填；前后接着录的几个文件，按播放顺序写文件名，用顿号隔开）'}
- 音轨对应：（多轨才填：每个文件是谁，比如 ${copied.length > 1 ? copied.map((n, i) => `${n}=${i ? '嘉宾' : '主持人'}`).join('、') : 'host.wav=主持人、guest.wav=嘉宾'}）
- 音轨偏移：（多轨才填，一般不用：某条音轨比别的晚开始录，写 文件名=+秒数，比如 guest.wav=+1.2）
- 目标时长：${fromShow('目标时长', '（精编版想要多少分钟，比如 35–40）')}
- 嘉宾是否同意：（参与者知不知道会剪辑发布）
- 发布平台：${fromShow('发布平台', '（小宇宙、喜马拉雅、B 站……）')}
- 不想删的：（主理人点名要保留的段落或人，没有就写"无"）
`, 'utf8');
}

console.log(`节目目录：${e.work}`);
const REG = `位置记在 ${path.basename(extFile(e))}；剪完之前别挪、别删、别改它（在原位置改了、覆盖了，这期的录音也跟着变）。挪了地方（改了名也一样）再运行一次 ${cmd('new.mjs', e.work, '<录音的新位置>')} 登记新位置`;
if (sanitized.length) console.log(`文件名里有空格或 & % ' 这类符号（在命令行里容易出错），放进来时换成了 _：${sanitized.map((x) => `${x.from} → ${x.to}`).join('、')}。节目信息里"录音顺序""音轨对应""音轨偏移"写原名、新名都认`);
if (renamed.length) console.log(`重名了，改了名字：${renamed.map((x) => `${x.from} → ${x.to}`).join('、')}（这期已经有同名的另一个录音，不能互相顶掉）`);
if (linked.length) console.log(`放进来的录音：${linked.join('、')}（同一个盘，用的硬链接：不多占硬盘空间，删掉原文件这里也还在。`
  + `注意它和原文件是同一个文件：剪完之前别在原位置改原文件，也别用同名文件覆盖它（降噪后原地保存、剪掉片段、录音软件下一期沿用同一个文件名），不然这期的录音跟着变；要改就另存成新文件。想要一份互不影响的拷贝：加 --copy 重新开这期）`);
if (fullCopies.length) console.log(`拷进来的录音：${fullCopies.join('、')}（--copy：完整复制了一份，和原文件互不影响，多占同样大的硬盘）`);
const ext1 = external.filter((x) => !nolink.includes(x.name)), ext2 = external.filter((x) => nolink.includes(x.name));
if (ext1.length) console.log(`录音在别的盘，没有拷贝，直接用原文件：${ext1.map((x) => `${x.name}（${x.path}）`).join('、')}。${REG}`);
if (ext2.length) console.log(`这个盘不支持硬链接（比如 U 盘的 exFAT），没有拷贝，直接用原文件：${ext2.map((x) => `${x.name}（${x.path}）`).join('、')}。${REG}。想要一份独立的拷贝：加 --copy 重新运行`);
if (replaced.length) console.log(`重新登记了位置：${replaced.map((x) => `「${x.name}」原来在 ${x.from}（找不到了），换成 ${x.to}`).join('；')}。当成同一个录音挪了地方或改了名，名字照旧，录音没变的话已经做完的不会重做。`
  + `不是同一个录音的话：运行 ${cmd('new.mjs', e.work, '--forget', replaced[0].name)} 去掉这条，再重新登记`);
const already = copied.filter((n) => !linked.includes(n) && !fullCopies.includes(n) && !external.some((x) => x.name === n) && !replaced.some((x) => x.name === n));
if (already.length) console.log(`这期已经有的录音：${already.join('、')}（没动）`);
const stillLost = ext.files.filter((x) => !fs.existsSync(x.path));
if (stillLost.length) console.log(`注意：还有登记了但找不到的录音：${stillLost.map((x) => `「${x.name}」（${x.path}）`).join('、')}。找到了就运行 ${cmd('new.mjs', e.work, '<录音的新位置>')} 登记；这个录音不要了：运行 ${cmd('new.mjs', e.work, '--forget', stillLost[0].name)}`);
console.log(show ? `用的节目档案：${show.file}（节目名、主持人、目标时长已带进 节目信息.md；常错词 ${show.fixes.length} 条，转写后自动替换）` : `没找到节目档案。${showRef(e).note ? `${showRef(e).note}。` : ''}${noShowHint(e)}。`);
// 节目信息.md 已经有了，这次又放进了录音（补录、另一期）：不替他改节目信息，但要说清楚录音方式、录音顺序得改，转写过的要重新转写（2026-11-22 审查）
const added = [...linked, ...fullCopies, ...external.map((x) => x.name)];
let recheck = false, badFound = false;
// 放进来的录音读不读得出来（录音软件崩溃留下的半截 m4a 之类）：现在就说，不等转写报英文错
try {
  const bad = badRecordings(recordingsInfo(e).files.filter((f) => added.includes(recName(e, f))));
  if (bad.length) { console.log(`注意：${badRecMsg(e, bad)}`); badFound = true; }
} catch {} // 没装好 ffmpeg 之类：这里不管，转写时会说
if (infoExisted && added.length) {
  const all = recordingsInfo(e).files.map((f) => recName(e, f));
  const mode = recordingMode(e), order = readInfo(e)['录音顺序'];
  const q = (xs) => xs.map((n) => `「${n}」`).join('、');
  if (all.length > 1 && mode === 'multitrack') console.log(`注意：这期写的是多轨（每人一个文件、同时录）。${q(added)}要是补录的旁白、另一期的录音：${MT_NO_SPLICE}。要是漏掉的一条音轨：在 节目信息.md 的"音轨对应""录音顺序"补上它`);
  else if (all.length > 1) {
    const was = readJson(path.join(e.mid, '录音.json'), null)?.files ?? all.filter((n) => !added.includes(n));
    console.log(`注意：节目信息.md 原来就有，没有替你改。现在有 ${all.length} 个录音（${all.join('、')}）：${mode === 'sequential' ? '' : '"录音方式"要写"前后接着"（补录、两期拼成一期都是这个），'}"录音顺序"要按播放顺序写全（现在${infoBlank(order) ? '空着' : `写的是"${order}"`}），比如 录音顺序：${[...was.filter((n) => all.includes(n)), ...added].join('、')}（补录放最后的话；放最前就挪到最前）。没写全，转写会停下`);
    recheck = true;
  }
  if (fs.existsSync(e.full)) { console.log(`注意：这期已经转写过，全文、编排方案、精编版都是按原来的录音做的。改好节目信息后要重新运行 ${cmd('transcribe.mjs', e.work)}（整期重新识别，句子编号会变），再运行 ${cmd('plan.mjs', e.work)} 按新全文核对编排方案、重新给主理人确认`); recheck = true; }
}
// 几个录音、还没写录音方式：transcribe 一开工就会停下来问，先问清楚
const nRecs = recordingsInfo(e).files.length;
// 一个文件里有几条音轨、没写"音轨选择"：transcribe 也会停下来问
const streamsAskAll = streamsAskMsg(e, recordingsInfo(e).files.filter((f) => fs.existsSync(f)));
const streamsAsk = nRecs > 1 && !recordingMode(e) ? null : streamsAskAll;
// 往已有的节目里加录音（补录、另一期）：下一步是先改录音方式、录音顺序，新加的文件里有几条音轨的也先说（以前只在新开节目时说，2026-11-24 复核）
if (recheck && !badFound && streamsAskAll) console.log(`注意：${streamsAskAll.replace(/先运行 .*$/, '转写会停下来问；问主理人用哪条，在 节目信息.md 写好"音轨选择"再转写（不知道每条是什么，改好录音方式、录音顺序后先运行一次转写，它几秒钟就停下、列出每条音轨的平均音量）')}`);
console.log(badFound ? `下一步：先换掉读不出来的录音（见上面），再运行 ${cmd('transcribe.mjs', e.work)} 转写。` : recheck ? `下一步：先改好 节目信息.md 的"录音方式""录音顺序"，再运行 ${cmd('transcribe.mjs', e.work)} 转写。`
  : nRecs > 1 && !recordingMode(e) ? `下一步：有 ${nRecs} 个录音文件，先问主理人录音方式：前后接着录的，还是多轨（每人一个文件、同时录），写进 节目信息.md 的"录音方式"（多轨再写"音轨对应"），然后在后台运行 ${cmd('transcribe.mjs', e.work)} 开始转写（其他栏不用等填完）。`
  : streamsAsk ? `下一步：${streamsAsk}（节目信息.md 其他栏不用等填完）。`
  // 已经转写过、这次只是重新登记挪走的录音（或者没放进新录音）：不是新开的一期，别叫人填节目信息、重新转写（2026-11-24 第 3 轮 14）
  : fs.existsSync(e.full) && (replaced.length || !added.length) ? `下一步：运行 ${cmd('status.mjs', e.work)} 看现在到哪一步了。录音没变的话，已经做完的（转写、编排、精编版、确认）都不会重做，不要自己重新转写；录音真变了，status 会说清楚怎么办。`
  : `下一步：和主理人一起填 节目信息.md，然后运行 ${cmd('transcribe.mjs', e.work)} 开始转写（转写不用等信息填完）。`);
