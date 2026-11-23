#!/usr/bin/env node
// 开工一条命令：环境快速自检 + 这期走到哪一步（status）+ 节目档案摘要。Agent 每次开工（新的一期建好之后、继续上次那期）先跑它。
//
//   node tools/podcast/start.mjs <节目目录>
//
// 自检只做轻量的（东西在不在、ffmpeg 能不能跑；不加载识别程序、不下载、不安装、不写配置），一两秒。
// 有没过的项会说怎么办；完整自检用 tools/doctor.mjs。节目目录还没建的，告诉你用 new.mjs 开新的一期。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { episode, envChecks, cmd } from '../lib/podcast.mjs';
import { loadShow, isShowFolder, showFolderMsg } from '../lib/show.mjs';

const dir = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!dir) { console.error(`用法: ${cmd('start.mjs')} <节目目录>`); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const run = (script, ...a) => spawnSync(process.execPath, [path.join(here, script), ...a], { stdio: 'inherit', windowsHide: true }).status ?? 1;

// 1. 环境：全过只打一行；有没过的列出来，附上办法
const rows = await envChecks({ quick: true });
const failed = rows.filter((r) => r.status === '未通过'), hints = rows.filter((r) => r.status === '提示');
console.log('【环境】');
if (!failed.length) {
  console.log(`通过：${rows.filter((r) => r.status === '通过').map((r) => r.name).join('、')}${hints.length ? `。提示：${hints.map((r) => `${r.name} ${r.detail}`).join('；')}` : ''}`);
  for (const r of hints) if (r.act) console.log(`  ${r.name}：告诉用户后${r.fix}`);
} else {
  console.log(`有 ${failed.length} 项没过：`);
  for (const r of failed) console.log(`  ${r.name}：${r.detail}${r.fix ? ` → ${r.fix}` : ''}`);
  // 要用户知道的提示（旧版残留：setup 会顺便删掉），有没过的项时也要列出来，不然用户不知道 setup 还会删东西
  const acts = hints.filter((r) => r.act);
  for (const r of acts) console.log(`  ${r.name}（提示）：${r.detail}`);
  const also = acts.length ? `；setup 还会顺便删掉上面"旧版残留"列的旧版文件（清单先用 ${cmd('tools/setup.mjs', '--check')} 看，只看不删；自己改过旧版模板的先另存）` : '';
  console.log(`先告诉用户要下载安装（约 300 MB，都装在技能目录里；配乐曲库默认不下，用到时再下）${also}，他同意后运行 ${cmd('tools/setup.mjs')}；装完可以用 ${cmd('tools/doctor.mjs')} 做完整自检。`);
}

// 2. 这期走到哪一步
const e = episode(dir);
console.log('\n【这期】');
if (!fs.existsSync(e.work)) {
  console.log(`还没有这个节目目录：${e.work}。新的一期运行 ${cmd('new.mjs', e.work, '<录音文件>')}（"<录音文件>"换成录音的完整路径，录音有几个文件就都写上）。`);
  process.exit(failed.length ? 1 : 0);
}
// 给的是节目文件夹（下面有 节目档案/），不是某一期：说清楚，列出已有的几期，给开新一期的命令
if (isShowFolder(e.work)) { console.log(showFolderMsg(e.work)); process.exit(1); }
const st = run('status.mjs', e.work);

// 3. 节目档案：有的话把内容摘要打出来，编排、写简介都照着它
if (loadShow(e)) { console.log('\n【节目档案】'); run('show.mjs', e.work, '--after-status'); }
process.exit(failed.length || st ? 1 : 0);
