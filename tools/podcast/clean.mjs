#!/usr/bin/env node
// 成品确认后，清理 制作文件/ 里的大文件，腾硬盘。只在主理人（或 AI 替他）运行这条命令时清，从不自动清。
//
//   node tools/podcast/clean.mjs <节目目录> [--force]
//
// 删：制作文件/ 里能重新生成的大文件——转好的录音（原始_44k.wav、16k.wav、多轨每条轨的 16k）、
//     剪辑和对比时没删干净的临时文件（.raw、.part.wav）、旧版留下的整条降噪副本和对比临时成品（mp3）。
// 留：所有 json（识别、分说话人分段、段响度、接缝缓存、用时……）、日志，以及节目目录里别的一切（方案原文.json 在节目目录第一层）
//     （原始录音、全文、编排方案、处理前后对比、精编版）。
// 以后要重剪（改编排、重出精编版、出对比、重新分说话人、记声纹）时，脚本会先自动重新转换录音（几十秒），
// 识别、分说话人、全文都不动（见 lib/podcast.mjs 的 ensureWavs、transcribe.mjs 的 BOKE_REWAV）；录音变了就停下说清楚，不悄悄重新识别。
// 不清的时候（lib/confirm.mjs 的 cleanBlock）：成品还没确认、确认后又重剪了、确认后编排/声音/节目档案又改了（马上要重剪），
// 或者当初转写用的录音不在了（清了就没法重剪）、录音在转写之后变了或转写没做完（马上要重新转写、重剪）。确定要清加 --force。转写、分说话人、剪辑、出对比、检查在跑时一律不清。
// 录音只是修改时间变了（名字、大小没变）：先重新转换一次核对内容，一样才清（原位置改过的话，转好的那份是唯一对得上全文的）

import fs from 'node:fs';
import path from 'node:path';
import { episode, mustExist, lockInfo, cleanable, sizeText, logStep, cmd, loadPlan, recordings, recName, ensureWavs, recordingsChanged, recChangedMsg } from '../lib/podcast.mjs';
import { cleanBlock } from '../lib/confirm.mjs';
import { loadShow } from '../lib/show.mjs';

const T0 = Date.now();
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) { console.error(`用法: ${cmd('clean.mjs')} <节目目录> [--force]`); process.exit(2); }
mustExist(dir);
const e = episode(dir);
const force = args.includes('--force');

// 1. 后台还在转写、分说话人、出成品、出对比、检查：它们正用着这些文件
for (const [name, what] of [['转写', '转写'], ['分说话人', '分说话人'], ['成品', '出成品（finish）'], ['剪辑', '剪精编版（build）'], ['对比', '出处理前后对比（build --compare）'], ['检查', '机器检查（check）']]) {
  const l = lockInfo(e, name);
  if (l?.alive) { console.error(`${what}还在跑（进程 ${l.pid}，已 ${l.minutes} 分钟），它正用着这些文件。等它跑完再清理。`); process.exit(1); }
}
// 2. 成品确认过、确认的就是现在这版精编版、之后编排/声音/节目档案没改过；3. 当初转写用的录音都还在（lib/confirm.mjs 的 cleanBlock，status 用同一个）
const { plan } = loadPlan(e);
let show = null; try { show = loadShow(e); } catch {}
let { why, lost, rec, recheck } = cleanBlock(e, { plan, show });
// 只差录音的修改时间变了：先重新转换一次核对内容（和剪辑前一样，lib/podcast.mjs 的 ensureWavs）。一样就接着清；
// 不一样就停下，transcribe 会记下"录音在原位置改过"，status、确认门之后都按录音变了算（2026-11-24 复核）
if (why && recheck && !force) {
  try { ensureWavs(e, { recheck: true }); } catch {
    const ch = recordingsChanged(e);
    console.error(`${ch?.edited ? recChangedMsg(e, ch) : '核对录音没做完（上面是原因）'}。先不清理：转好的录音是现在唯一对得上全文的一份，清了就得整期重新识别、重新编排。`);
    process.exit(1);
  }
  ({ why, lost, rec, recheck } = cleanBlock(e, { plan, show }));
}
if (why && !force) {
  console.error(lost.length && /原始录音不在/.test(why)
    ? `${why}，所以先不清。找回来再清；确定以后不会再剪：加 --force。`
    : rec ? `${why}，先不清理：这些文件马上又要用。重新转写、重剪、主理人听过新的精编版重新确认成品之后再运行这条命令（现状和下一步看 ${cmd('status.mjs', e.work)}）。`
      + `确定现在就要清：加 --force（清了也能重剪，只是要先花几十秒重新转换录音）。`
    : `${why}，先不清理：这时候还可能要改编排、重剪，这些文件马上又要用。主理人确认成品（确认过、之后又改过的，重新确认）之后再运行这条命令（现状看 ${cmd('status.mjs', e.work)}）。`
      + `确定现在就要清：加 --force（${lost.length ? '注意：转写用的录音现在不全，清了就没法重剪' : '清了也能重剪，只是要先花几十秒重新转换录音'}）。`);
  process.exit(1);
}

const files = cleanable(e);
if (!files.length) { console.log('制作文件/ 里没有可以清的大文件（已经清过了，或者还没转写）。'); process.exit(0); }
let freed = 0;
const failed = [], names = [];
for (const f of files) {
  try { fs.rmSync(f.file, { force: true }); freed += f.bytes; names.push(path.relative(e.mid, f.file)); } catch (err) { failed.push(`${path.relative(e.work, f.file)}（${err.code ?? err.message}）`); }
}
// 删空了的子文件夹（旧版的对比临时目录之类）顺手删掉；里面还有 json 的留着
for (const d of fs.readdirSync(e.mid, { withFileTypes: true })) {
  if (d.isDirectory()) { const p = path.join(e.mid, d.name); try { if (!fs.readdirSync(p).length) fs.rmdirSync(p); } catch {} }
}
console.log(`清理完了：删掉 制作文件/ 里 ${names.length} 个文件，腾出 ${sizeText(freed)}。`);
console.log(`  删掉的：${names.length > 8 ? `${names.slice(0, 8).join('、')} 等` : names.join('、')}`);
console.log(`  留着的：识别、分说话人、段响度这些 json，${lost.length ? '' : '原始录音、'}全文、编排方案和方案原文、处理前后对比、精编版都没动。`);
if (failed.length) console.log(`  没删掉的（可能被别的程序占着，关掉再运行一次就行）：${failed.join('、')}`);
logStep(e, '清理中间文件', T0, { freedMB: Math.round(freed / 1024 ** 2) }); // status 的"节目目录现在多大"跟着更新
if (lost.length) console.log(`注意：转写用的录音${lost.map((n) => `「${n}」`).join('、')}现在不在，找回来（放回原处、名字不变）之前没法重剪、出对比、重新分说话人。`);
else {
  // 录音是怎么来的说法要对：登记在别的位置的、同一个盘硬链接的、完整复制的（--copy）或者自己放进来的（v0.7 审查 27）
  const recs = recordings(e), ext = recs.filter((f) => path.dirname(path.resolve(f)) !== e.work);
  const linked = recs.some((f) => { try { return path.dirname(path.resolve(f)) === e.work && fs.statSync(f).nlink > 1; } catch { return false; } });
  const keep = ext.length ? `原始录音${ext.map((f) => `「${recName(e, f)}」`).join('、')}没拷进节目目录，这期直接读它原来的位置（${ext.map((f) => path.dirname(f)).filter((x, i, a) => a.indexOf(x) === i).join('、')}）：别挪、别删、别改`
    : linked ? '原始录音别删、别改（同一个盘是硬链接，在原位置改了原文件，这期的录音也跟着变'
      : '节目目录里的原始录音别删、别改（这是单独的一份，原位置的文件改了不影响它';
  console.log('以后要重剪（改编排后重出精编版、出处理前后对比、重新分说话人）照常运行原来的命令：会先自动重新转换录音（几十秒），识别、分说话人、全文都不动。'
    + `${keep}${ext.length ? '（' : '；'}录音变了，重剪前会停下说清楚）。`);
}
