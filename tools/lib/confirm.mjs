// 五步确认门：status 显示和记确认、finish / build 出成品之前查、status --confirm 成品 查前面几步，都用这一份。
//
// 确认时记下当时的指纹，之后文件改了确认自动失效：
//   素材：节目信息各栏的值（fields）和栏以外文字的指纹（rest，见 lib/podcast.mjs 的 infoSnapshot）。
//         只是把原来空着的栏补上（模板提示、空的；写着"待确认"的不算空）仍算确认过；改了确认过的栏、栏下面另写的内容变了，要重新确认
//   认人：说话人.md 的指纹        编排：planSha(plan, 'edit')（板块、句子范围、小话题名 label、删减、配乐；写简介、改标题不算）
//   声音：这期实际用的人声处理（节目档案记过、这期没另写 voice 的，自动算过）        成品：精编版.mp3 的指纹
// 旧版状态照样认：编排记的是整个方案文件的指纹、素材只记了整个 节目信息.md 的指纹（文件没动过就补记成新写法）

import fs from 'node:fs';
import path from 'node:path';
import { readJson, readJsonResult, userError, writeJson, fileSha, planSha, infoSnapshot, infoBlank, infoPending, cmd, sourceMissing, sourceMissingMsg, recordingsChanged, planCheck, fullSha } from './podcast.mjs';
import { showVoice, effectiveVoice } from './show.mjs';
const warned = new Set();

export const STEPS = ['素材', '认人', '编排', '声音', '成品'];

// 确认时是空着的：没写，或者整段是模板里的括号提示。AI 预填的"（开场原话：……，待确认）"不算空：之后改了要重新确认
const wasBlank = (v) => infoBlank(v) && !infoPending(v) && !/开场原话/.test(v ?? '');

export function confirmGate(e, { plan, show }) {
  const voiceNow = effectiveVoice(plan, show);
  const mp3 = path.join(e.out, '精编版.mp3');
  const snap = infoSnapshot(e);
  const fingerprint = {
    素材: () => fileSha(e.info),
    认人: () => fileSha(e.names),
    编排: () => planSha(plan, 'edit'),
    声音: () => `voice:${voiceNow}`,
    成品: () => fileSha(mp3),
  };
  // 状态.json 坏了（写到一半被打断）：以前悄悄当成全没确认，下次 --confirm 就把原来的确认记录盖掉了。
  // 现在先另存一份、说出来；读不了（被占着、没权限）的直接停下说清楚（2026-11-22 审查 77）
  const sr = readJsonResult(e.state);
  if (sr.damaged) {
    try { fs.copyFileSync(e.state, path.join(e.work, '状态.坏了.json')); } catch {}
    if (!warned.has(e.state)) console.error(`注意：状态.json 坏了（多半是上次写到一半被打断），读不出确认记录，已另存成 状态.坏了.json。下面各步都按"未确认"算：请主理人把要确认的步骤重新确认一遍，不要替他确认。`);
    warned.add(e.state);
  } else if (sr.bad) throw userError(sr.bad);
  const state = sr.value ?? { kind: 'podcast', confirmed: {} };
  state.confirmed ??= {};
  const save = () => writeJson(e.state, state, 2);

  // 旧版记法升级（文件没动过才升级，动过的照旧算失效）
  const cm = state.confirmed['素材'];
  if (cm?.sha && cm.sha === fileSha(e.info) && (!cm.fields || cm.rest === undefined)) { cm.fields = snap.fields; cm.rest = snap.rest; save(); }
  const cp = state.confirmed['编排'];
  if (plan && cp?.sha && cp.sha === fileSha(e.plan) && cp.sha !== planSha(plan, 'edit')) { cp.sha = planSha(plan, 'edit'); save(); }

  // 素材：和确认时比，哪些确认过的栏改了（changed）、哪些原来空着的栏补上了（filled）、栏以外的文字变了没有（rest）
  const diffInfo = (c = state.confirmed['素材']) => {
    if (!c?.fields) return { changed: [], filled: [], rest: false };
    const now = snap.fields;
    const changed = Object.keys(c.fields).filter((k) => !wasBlank(c.fields[k]) && (now[k] ?? '') !== c.fields[k]);
    const filled = Object.keys(now).filter((k) => !infoBlank(now[k]) && wasBlank(c.fields[k]));
    return { changed, filled, rest: c.rest !== undefined && c.rest !== snap.rest };
  };
  const ok = (s) => {
    const c = state.confirmed[s];
    if (s === '声音' && !plan?.voice && showVoice(show)) return true;
    if (!c) return false;
    if (c.skipped || c.sha === fingerprint[s]()) return true;
    if (s === '编排') return c.sha === fileSha(e.plan);
    if (s === '素材' && c.fields) { const d = diffInfo(c); return !d.changed.length && !d.rest; }
    return false;
  };
  const stale = (s) => !!state.confirmed[s] && !ok(s);
  const soundByShow = !plan?.voice && !!showVoice(show);
  return { state, save, ok, stale, fingerprint, snap, diffInfo, voiceNow, mp3, soundByShow, plan };
}

// 现在的精编版是不是按现在的方案（板块、句子范围、配乐、人声处理）和节目档案剪的。status 和 clean 共用
// 还要是按现在的录音和全文剪的：重新转写（--force、加了补录）以后句子的时间变了，方案文件没动也不算最新（v0.7 发布前复核：
// 以前重新转写后 --confirm 成品 能确认旧录音剪的精编版，clean 也照清）。剪辑表记了 wav16（录音.json 的 wav16sha）和 full（全文的编号指纹）；
// 旧版剪辑表没记的，看识别结果是不是比剪辑表新（只有重新识别才会重写 识别.json）
export function cutFromCurrent(e) {
  const f = path.join(e.out, '剪辑表.json');
  const edl = readJson(f, null);
  if (!edl) return false;
  const wav = readJson(path.join(e.mid, '录音.json'), {})?.wav16sha ?? null;
  if (edl.wav16 && wav && edl.wav16 !== wav) return false;
  if (edl.full) return edl.full === fullSha(readJson(e.full, null));
  try { return fs.statSync(e.asr).mtimeMs <= fs.statSync(f).mtimeMs + 1000; } catch { return true; }
}
export function buildFresh(e, { plan, show, voiceNow }) {
  const edl = readJson(path.join(e.out, '剪辑表.json'), null);
  return !!edl && (edl.plan === planSha(plan, 'audio') || edl.plan === fileSha(e.plan)) && edl.processed === (voiceNow !== 'raw') && (edl.showSha ?? null) === (show ? fileSha(show.file) : null) && cutFromCurrent(e);
}
// 精编版的机器检查：'none' 没查过（或查的不是现在这个 mp3）、'fail' 有未通过、'pass' 通过（提示不算没过）
export function reportState(e) {
  const r = readJson(path.join(e.out, '检查报告.json'), null);
  if (!r || r.mp3 !== fileSha(path.join(e.out, '精编版.mp3'))) return 'none';
  return (r.results ?? []).some((x) => x.status === '未通过') ? 'fail' : 'pass';
}
// 成品能不能确认、能不能清理都要先过的三件事：方案按现在的全文检查过、精编版按现在的录音和全文剪、机器检查通过。
// 返回给人看的原因（null 是都过了）。--confirm 成品 和 cleanBlock 共用
// strict：和 status 的下一步一样，编排确认过以后只看决定声音的部分（写 intro、改标题不用重跑 plan；2026-11-24 复核：
// 以前一律按整个文件比，写了 intro 以后 --confirm 成品、clean 都被拦下，还叫人重跑 plan 和 finish）
export function outputReadyMsg(e, { plan, strict = true }) {
  const pc = plan ? planCheck(e, plan, { strict }) : null;
  if (pc) return `${pc}：先运行 ${cmd('plan.mjs', e.work)} 按现在的全文重新检查方案（编号变了要改），再运行 ${cmd('finish.mjs', e.work)} 重出精编版`;
  if (!cutFromCurrent(e)) return `现在的精编版是重新转写之前剪的（录音或全文后来变了），先运行 ${cmd('finish.mjs', e.work)} 按现在的录音重出，请主理人听过新的再确认`;
  const rs = reportState(e);
  if (rs === 'none') return `现在的精编版还没做机器检查（或者检查的是之前那版），先运行 ${cmd('check.mjs', e.work)}`;
  if (rs === 'fail') return `机器检查没通过（看 精编版/检查报告.json），处理好重出、检查通过再确认`;
  return null;
}

// 能不能清理中间文件（clean.mjs 清不清、status 提不提示）：成品确认过、确认的就是现在这版、之后编排/声音/节目档案都没改过
// （改过就马上要重剪，清了又得重新转换）、当初转写用的录音都还在（不在的话清了就再也没法重剪）。
// 返回 { why, lost, rec, recheck }：why 是不能清的原因（加 --force 可以照样清），lost 是不在的录音名（2026-11-20 审查 F3），
// recheck：别的都过了，只差录音的修改时间变了、要先核对内容（clean 核对过就清，status 照样提示可以清理）
export function cleanBlock(e, { plan, show }) {
  const g = confirmGate(e, { plan, show });
  const c = g.state.confirmed['成品'];
  const lost = sourceMissing(e);
  let why = null, rec = false, recheck = false;
  // 转写还在跑、半路断了、录音换过：精编版是旧录音剪的，马上要重新转写、重剪（rec：clean 换一种说法，这时成品可能早就确认过）
  const ch = recordingsChanged(e);
  if (ch && !ch.mtimeOnly) { rec = true; why = ch.unfinished ? `${ch.why}，要重新转写、重剪` : `录音在转写之后变了（${ch.why}），马上要重新转写、重剪`; }
  else if (!fs.existsSync(g.mp3)) why = '还没有精编版';
  else if (!c?.sha) why = '成品还没确认';
  else if (!g.ok('成品')) why = '成品确认之后精编版又重剪过，还没重新确认';
  else if (!cutFromCurrent(e)) { rec = true; why = '确认的精编版是重新转写之前剪的（录音或全文后来变了），马上要重剪'; }
  // 只有"全文重新识别过"才算要重新转写那种（rec）；只是改了方案还没跑 plan，用普通的说法（2026-11-24 第 3 轮 10：以前一律 rec，clean 叫人"重新转写"）
  else if (plan && planCheck(e, plan, { strict: !g.ok('编排') })) { const pc = planCheck(e, plan, { strict: !g.ok('编排') }); rec = /重新识别/.test(pc); why = rec ? `${pc}，方案要按现在的全文重新检查，可能要重剪` : `${pc}（先运行 ${cmd('plan.mjs', e.work)} 检查、给主理人看过，再重剪）`; }
  else if (!g.ok('编排') || !g.ok('声音') || !buildFresh(e, { plan, show, voiceNow: g.voiceNow })) why = '编排方案（或人声处理、节目档案）在成品确认之后改过，马上要重剪';
  else if (reportState(e) !== 'pass') why = reportState(e) === 'fail' ? '精编版的机器检查没通过，还要处理、重剪' : '精编版还没做机器检查';
  else if (lost.length) why = `${sourceMissingMsg(e, lost)}。原始录音不在，清掉转好的录音以后就没法重剪了`;
  // 录音文件只是修改时间变了（可能被碰了一下，也可能在原位置改过、大小没变）：清掉转好的录音前先核对内容（clean.mjs 先重新转换一次比，
  // 几十秒）。不核对就清，原位置改过的话转好的那份是唯一对得上全文的，清了就得整期重新识别、重新编排（2026-11-24 复核）
  else if (ch?.mtimeOnly) { recheck = true; why = '录音文件的修改时间在转写之后变了（可能在原位置改过），清理前要先核对内容'; }
  return { why, lost, rec, recheck };
}

// 出成品（finish、build）之前：编排、声音都要本人确认过，而且确认之后没改过。没过返回一段话（说哪步、怎么办），过了返回 null
export const comparesReady = (e) => { try { return fs.readdirSync(e.compare).some((n) => n.endsWith('.mp3')); } catch { return false; } };
export function outputGateMsg(e, g) {
  const C = (...a) => cmd('status.mjs', e.work, ...a);
  const why = [];
  // 方案改过还没重新检查（编排方案.md 还是旧的）：先说跑 plan，不能叫人拿旧的 编排方案.md 去给主理人看（和 status 的下一步一致，v0.7 审查 21）
  const unchecked = !g.ok('编排') && g.plan ? planCheck(e, g.plan, { strict: true }) : null;
  if (unchecked) why.push(`「编排」${g.stale('编排') ? '确认之后方案又改过' : '还没确认'}，而且${unchecked}：先运行 ${cmd('plan.mjs', e.work)} 重新检查、重出 编排方案.md，把新的 编排方案.md 给主理人看，他同意后运行 ${C('--confirm', '编排')}`);
  else if (!g.ok('编排')) why.push(g.stale('编排')
    ? `「编排」确认之后方案又改过（板块、句子范围、小话题名、删减或配乐）：把改过的 编排方案.md 给主理人看，他同意后运行 ${C('--confirm', '编排')}`
    : `「编排」还没确认：把 编排方案.md（板块、删减清单和原因）给主理人看，他同意后运行 ${C('--confirm', '编排')}`);
  if (!g.ok('声音')) why.push(`「声音」${g.stale('声音') ? '确认之后人声处理的选择改过' : '还没确认'}：${comparesReady(e) ? '' : `先运行 ${cmd('build.mjs', e.work, '--compare')} 出处理前后对比，`}请他听 处理前后对比/ 选处理或不处理，确认后运行 ${C('--confirm', '声音')}`);
  if (!why.length) return null;
  return `还不能出成品，主理人还没同意：\n${why.map((x) => `  · ${x}`).join('\n')}\n不要替他确认。确认之后再运行这条命令；现状和下一步看 ${C()}`;
}
