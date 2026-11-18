#!/usr/bin/env node
// 播客精编：看一期节目走到哪一步；记下本人（主理人）确认过的步骤。Agent 每次开工先跑它，不靠聊天记忆。
//
//   node tools/podcast/status.mjs <节目目录>                     现状和下一步
//   node tools/podcast/status.mjs <节目目录> --confirm <步骤>     本人明确确认之后才记
//   node tools/podcast/status.mjs <节目目录> --unconfirm <步骤>
//   node tools/podcast/status.mjs <节目目录> --skip 认人          不给说话人对名字
//   node tools/podcast/status.mjs <节目目录> --json
//
// 步骤：素材、认人、编排、声音、成品。确认时记下当时文件的指纹，文件后来改了确认自动失效。
// "认人"不挡后面的步骤（可以边编排边等主理人认人），但简介里提到具体的人之前要认完。

import fs from 'node:fs';
import path from 'node:path';
import { episode, readJson, writeJson, readInfo, infoBlank, recordings, fileSha, fmt } from '../lib/podcast.mjs';

const STEPS = ['素材', '认人', '编排', '声音', '成品'];
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const dir = args.find((a, i) => !a.startsWith('--') && !['--confirm', '--unconfirm', '--skip'].includes(args[i - 1]));
if (!dir) { console.error('用法: node tools/podcast/status.mjs <节目目录> [--confirm 步骤 | --unconfirm 步骤 | --skip 认人] [--json]'); process.exit(2); }
const e = episode(dir);
if (!fs.existsSync(e.work)) { console.error(`没有这个目录：${e.work}。新节目先运行 node tools/podcast/new.mjs <节目目录> <录音文件>`); process.exit(1); }

const plan = readJson(e.plan, null);
const mp3 = path.join(e.out, '精编版.mp3');
const fingerprint = {
  素材: () => fileSha(e.info),
  认人: () => fileSha(e.names),
  编排: () => fileSha(e.plan),
  声音: () => (plan ? `voice:${plan.voice === 'raw' ? 'raw' : 'processed'}` : null),
  成品: () => fileSha(mp3),
};
const state = readJson(e.state, { kind: 'podcast', confirmed: {} });
state.confirmed ??= {};

const info = readInfo(e);
const KEY = ['节目名', '主持人', '录音是否完整', '目标时长'];
const infoMissing = KEY.filter((k) => infoBlank(info[k]));
const recs = fs.existsSync(e.work) ? recordings(e) : [];
const has = (f) => fs.existsSync(f);
const comparesReady = has(e.compare) && fs.readdirSync(e.compare).some((n) => n.endsWith('.mp3'));

const one = opt('--confirm') ?? opt('--unconfirm') ?? opt('--skip');
if (one) {
  if (!STEPS.includes(one)) { console.error(`不认识的步骤「${one}」。可用：${STEPS.join('、')}`); process.exit(2); }
  if (opt('--skip')) {
    if (one !== '认人') { console.error('只有「认人」可以跳过。'); process.exit(2); }
    state.confirmed[one] = { at: new Date().toISOString(), skipped: true };
  } else if (opt('--confirm')) {
    const block = {
      素材: !recs.length ? '还没有录音文件' : infoMissing.length ? `节目信息.md 还没填：${infoMissing.join('、')}（不知道就写"不确定"）` : null,
      认人: !has(e.names) ? '还没有 说话人.md（先跑 speakers.mjs）' : null,
      编排: !plan ? '还没有 编排方案.json' : !has(e.planMd) || fs.statSync(e.planMd).mtimeMs < fs.statSync(e.plan).mtimeMs ? '编排方案改过还没检查（plan.mjs）' : null,
      声音: !comparesReady ? '还没出处理前后对比（build.mjs --compare）' : null,
      成品: !has(mp3) ? '还没有精编版' : null,
    }[one];
    if (block) { console.error(`「${one}」还不能确认：${block}`); process.exit(1); }
    state.confirmed[one] = { at: new Date().toISOString(), sha: fingerprint[one]() };
  } else delete state.confirmed[one];
  writeJson(e.state, state, 2);
  console.log(opt('--skip') ? '已记下：不给说话人对名字。' : opt('--confirm') ? `已记下：本人确认了「${one}」。` : `已撤回「${one}」的确认。`);
}

const ok = (s) => { const c = state.confirmed[s]; return !!c && (c.skipped || c.sha === fingerprint[s]()); };
const stale = (s) => state.confirmed[s] && !ok(s);
const edl = readJson(path.join(e.out, '剪辑表.json'), null);
const report = readJson(path.join(e.out, '检查报告.json'), null);
const buildFresh = edl && edl.plan === fileSha(e.plan) && edl.processed === (plan?.voice !== 'raw');
const reportFresh = report && report.mp3 === fileSha(mp3);
const reportPassed = reportFresh && !report.results.some((r) => r.status === '未通过');

let next;
if (!recs.length) next = '把原始录音放进节目目录（或 new.mjs <节目目录> <录音文件>）';
else if (!has(e.full)) next = '第 1 步：运行 transcribe.mjs 转写（同时和主理人填 节目信息.md）';
else if (!ok('素材')) next = infoMissing.length ? `第 1 步：和主理人填 节目信息.md（还缺：${infoMissing.join('、')}），念给他确认后 --confirm 素材` : '第 1 步：把 节目信息.md 念给主理人确认，确认后 --confirm 素材';
else if (!has(e.diar) && !ok('认人')) next = /^(1|一|1 ?人|一个人|单人|一人)$/.test((info['嘉宾'] ?? '').trim()) || /单人|一个人|独白/.test(info['嘉宾'] ?? '')
  ? '第 2 步：单人节目不用分说话人，运行 --skip 认人，然后读全文写编排方案'
  : '第 2 步：后台运行 speakers.mjs 分说话人（同时可以开始读全文、想编排）；单人节目直接 --skip 认人';
else if (!plan) next = '第 3 步：读 全文.txt，按 references/播客_编排原则.md 写 编排方案.json';
else if (!has(e.planMd) || fs.statSync(e.planMd).mtimeMs < fs.statSync(e.plan).mtimeMs) next = '第 3 步：运行 plan.mjs 检查编排方案、出 编排方案.md';
else if (!ok('编排')) next = '第 3 步：把 编排方案.md（板块、删减清单和原因）给主理人过目，同意后 --confirm 编排。在这之前不动音频';
else if (!comparesReady) next = '第 4 步：运行 build.mjs --compare 出处理前后对比';
else if (!ok('声音')) next = '第 4 步：请本人听 处理前后对比/ 里的"先A后B"，选处理或不处理（写进编排方案的 voice），确认后 --confirm 声音';
else if (!buildFresh) next = '第 5 步：运行 build.mjs 剪精编版';
else if (!reportFresh) next = '第 5 步：运行 check.mjs 做机器检查';
else if (!reportPassed) next = '第 5 步：机器检查没过，看 精编版/检查报告.json 处理后重剪';
else if (!has(path.join(e.out, '节目简介.md'))) next = '第 5 步：在编排方案里写好 intro（简介正文），运行 notes.mjs 出节目简介';
else if (!ok('成品')) next = '第 5 步：请本人从头到尾听一遍 精编版.mp3，对照 编排方案.md 确认，确认后 --confirm 成品';
else next = '已完成。发布由本人做；要改就改 编排方案.json，重新 plan → build → check → notes';

const out = {
  work: e.work, recordings: recs.map((f) => path.basename(f)),
  files: { 全文: has(e.full), 说话人: has(e.diar), 编排方案: !!plan, 处理前后对比: comparesReady, 精编版: has(mp3), 检查: reportFresh ? (reportPassed ? '通过' : '未通过') : '无', 简介: has(path.join(e.out, '节目简介.md')) },
  confirmed: Object.fromEntries(STEPS.map((s) => [s, ok(s) ? (state.confirmed[s].skipped ? '跳过' : '已确认') : stale(s) ? '确认后文件改过，要重新确认' : '未确认'])),
  next,
};
if (args.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
const yn = (b) => (b === true ? '有' : b === false ? '无' : b);
console.log(`节目：${path.basename(e.work)}${info['节目名'] && !infoBlank(info['节目名']) ? `（${info['节目名']}）` : ''}　录音：${out.recordings.join('、') || '无'}`);
console.log(`文件：${Object.entries(out.files).map(([k, v]) => `${k} ${yn(v)}`).join('　')}`);
if (edl) console.log(`精编版：${fmt(edl.voiceEnd + 11)}${buildFresh ? '' : '（方案或人声处理选择改过，不是最新）'}`);
console.log(`确认：${STEPS.map((s) => `${s} ${out.confirmed[s]}`).join('　')}`);
if (has(e.diar) && !ok('认人')) console.log('待办：请主理人听 声音点名.mp3、在 说话人.md 填称呼（不挡编排；简介里提到具体的人之前要认完）');
console.log(`下一步：${next}`);
