#!/usr/bin/env node
// 成品一条命令：依次跑 build（剪精编版）→ check（机器检查、重点试听）→ notes（节目简介）。
//
//   node tools/podcast/finish.mjs <节目目录>
//
// 任何一步失败就停，把那一步的输出原样打出来（退出码也照搬）；都成功时只打一段简短结果：
// 精编版时长、响度、检查过没过、重点试听几处、简介还有几件事要确认。
// 三步各自照常记进 制作文件/用时.json，另外记一条"成品一条命令"的总用时。
// 不替主理人确认任何一步：编排、声音没确认（或确认之后又改过）就不跑，说清楚先让他确认哪步（lib/confirm.mjs，build 也查）。
// 同一期同时只能跑一个：开头拿"成品"锁（制作文件/成品.lock），上一次还在跑就不启动（build 自己拿"剪辑"锁）。
// 长节目 build、check 各要几十秒：每 20 秒打一行"还在……"，免得被当成卡住、又启动一次。
// 子步骤不要加 detached：现在结束 finish（超时、Ctrl+C），Windows 上它启动的 build 也跟着结束。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { episode, mustExist, readJson, loadPlan, planBadMsg, fmt, logStep, cmd, lockInfo, takeLock, recordingsChanged, recChangedMsg, readInfo, consentStopMsg, introOf } from '../lib/podcast.mjs';
import { loadShow } from '../lib/show.mjs';
import { confirmGate, outputGateMsg } from '../lib/confirm.mjs';

const T0 = Date.now();
const dir = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!dir) { console.error(`用法: ${cmd('finish.mjs')} <节目目录>`); process.exit(2); }
mustExist(dir);
const e = episode(dir);
const here = path.dirname(fileURLToPath(import.meta.url));

// 1. 上一次还在跑：不再启动（两次同时剪会互相删、互相覆盖临时文件，剪出半截的成品）
const busy = [lockInfo(e, '成品'), lockInfo(e, '剪辑')].find((l) => l?.alive);
if (busy) { console.error(`上一次出成品还在跑（进程 ${busy.pid}，已 ${busy.minutes} 分钟），不要再启动：等它跑完看它的输出。现状看 ${cmd('status.mjs', e.work)}`); process.exit(1); }
// 2. 确认门：编排、声音要本人确认过，而且确认之后没改过
{
  const { plan, bad } = loadPlan(e);
  if (bad) { console.error(`${planBadMsg(bad)}。改好再运行 ${cmd('plan.mjs', e.work)}；不用重读全文`); process.exit(1); }
  if (!plan) { console.error(`还没有 编排方案.json。现状和下一步看 ${cmd('status.mjs', e.work)}`); process.exit(1); }
  // intro 写成认不出的样子（数字、对象）：剪完、检查完才在第 3 步停下，先说（写成一个字符串照用，2026-11-24 第 3 轮 8）
  const ib = introOf(plan).bad;
  if (ib) { console.error(`${planBadMsg(ib)}。这次没剪，改好再运行 ${cmd('finish.mjs', e.work)}（只改 intro 不用重跑 plan）`); process.exit(1); }
  const why = outputGateMsg(e, confirmGate(e, { plan, show: loadShow(e) }));
  if (why) { console.error(why); process.exit(1); }
  // 录音在转写之后变了（加了补录、改了顺序、转写半路断了）：build 也会拦，这里先说，不白开一次
  const ch = recordingsChanged(e);
  if (ch && !ch.mtimeOnly) { console.error(`${recChangedMsg(e, ch)}。这次没剪。`); process.exit(1); }
}
takeLock(e, '成品');

// 跑一步：输出先收着（成功时只取要紧的，失败时原样打出来）；每 20 秒打一行"还在……"，带上它最近打的一行
function step(script, name) {
  return new Promise((resolve) => {
    const t0 = Date.now(), out = [];
    let last = '';
    const child = spawn(process.execPath, [path.join(here, script), e.work], { windowsHide: true, env: { ...process.env, BOKE_FINISH_PID: String(process.pid) } });
    const tick = setInterval(() => console.log(`  ……还在${name}，已 ${Math.round((Date.now() - t0) / 1000)} 秒${last ? `（${last.slice(0, 40)}）` : ''}`), 20000);
    child.stdout.on('data', (d) => { out.push({ err: false, d }); const l = d.toString('utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).at(-1); if (l) last = l; });
    child.stderr.on('data', (d) => out.push({ err: true, d }));
    child.on('error', (err) => out.push({ err: true, d: Buffer.from(String(err.message)) }));
    child.on('close', (code) => {
      clearInterval(tick);
      const text = (err) => Buffer.concat(out.filter((x) => err == null || x.err === err).map((x) => x.d)).toString('utf8');
      resolve({ code: code ?? 1, all: text(), stderr: text(true), seconds: Math.round((Date.now() - t0) / 1000) });
    });
  });
}
const STEPS = [['build.mjs', '剪精编版'], ['check.mjs', '机器检查'], ['notes.mjs', '出节目简介']];
const done = {}, warns = [];
for (const [i, [script, name]] of STEPS.entries()) {
  console.log(`${i + 1}/${STEPS.length} ${name}……`);
  const r = await step(script, name);
  if (r.code !== 0) {
    console.log(`\n第 ${i + 1} 步"${name}"（${script}）没过，停在这里，后面的没跑。下面是它的原样输出：\n`);
    process.stdout.write(r.all.endsWith('\n') ? r.all : `${r.all}\n`);
    process.exit(r.code);
  }
  done[script] = r.seconds;
  // 成功了但往错误输出里写了东西（比如配乐没下载下来、先用默认的）：留着，放进结果里
  for (const l of r.stderr.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) warns.push(`${name}：${l.replace(/^△\s*/, '')}`);
}

// ---- 合成一段结果：都从三步写下的文件里读，不靠解析屏幕输出 ----
const edl = readJson(path.join(e.out, '剪辑表.json'), {});
const report = readJson(path.join(e.out, '检查报告.json'), { results: [], listen: [] });
const plan = loadPlan(e).plan ?? {};
const notesMd = fs.existsSync(path.join(e.out, '节目简介.md')) ? fs.readFileSync(path.join(e.out, '节目简介.md'), 'utf8') : '';
// 简介里"发布前要确认"那一节的条目、时间轴有几个小话题
const section = (title) => { const m = notesMd.split(/^## /m).find((s) => s.startsWith(title)); return m ? m.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()) : []; };
const todo = section('发布前要确认'), topics = section('时间轴').length;
const m = edl.measured ?? {};
const hints = (report.results ?? []).filter((r) => r.status === '提示');
const secs = (s) => (s < 90 ? `${s} 秒` : `${(s / 60).toFixed(1)} 分钟`);
const total = Math.round((Date.now() - T0) / 1000);

console.log(`\n成品做好了（${STEPS.map(([s, n]) => `${n} ${secs(done[s])}`).join('、')}，共 ${secs(total)}）：`);
console.log(`  精编版：精编版/精编版.mp3，${fmt(edl.length ?? (edl.voiceEnd ?? 0) + 11)}，${(edl.items ?? []).filter((x) => x.kind === 'clip').length} 段；响度 ${m.lufs} LUFS（目标 ${edl.lufs ?? -16}），峰值 ${m.peak} dBFS，音量起伏 ${m.lra} LU`);
console.log(`  机器检查：通过${hints.length ? `，有 ${hints.length} 处提示——${hints.map((r) => `${r.name}：${r.detail}`).join('；')}` : ''}`);
if (report.listen?.length) console.log(`  重点试听：${report.listen.length} 处、约 ${fmt(report.listen.length * 10.8)}，在 精编版/重点试听.mp3（清单 重点试听.md）`);
console.log(`  节目简介：精编版/节目简介.md，时间轴 ${topics} 个小话题${introOf(plan).paras?.length ? '' : '；简介正文还没写（编排方案.json 的 intro），写好后运行 ' + cmd('notes.mjs', e.work) + '，不用重剪'}`);
console.log(todo.length ? `  发布前还有 ${todo.length} 件事要确认：\n${todo.map((x) => `    · ${x}`).join('\n')}` : '  发布前要确认的事：没有');
if (warns.length) console.log(`  另外留意：\n${warns.map((x) => `    · ${x}`).join('\n')}`);
// 嘉宾明确不同意发布：和 status 说一样的话，不请主理人去试听、确认成品（v0.7 审查 22）
const consentStop = consentStopMsg(readInfo(e));
console.log(consentStop ? `下一步：先停下，还不能交付：${consentStop}`
  : `下一步：请本人先听 精编版/重点试听.mp3（几分钟），有时间再从头听一遍 精编版.mp3。机器检查通过不等于好听；他说可以了再运行 ${cmd('status.mjs', e.work, '--confirm', '成品')}`);
logStep(e, '成品一条命令', T0);
