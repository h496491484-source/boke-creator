#!/usr/bin/env node
// 播客精编：看一期节目走到哪一步；记下本人（主理人）确认过的步骤。Agent 每次开工先跑它，不靠聊天记忆。
//
//   node tools/podcast/status.mjs <节目目录>                     现状和下一步
//   node tools/podcast/status.mjs <节目目录> --confirm <步骤>     本人明确确认之后才记
//   node tools/podcast/status.mjs <节目目录> --unconfirm <步骤>
//   node tools/podcast/status.mjs <节目目录> --skip 认人          不给说话人对名字
//   node tools/podcast/status.mjs <节目目录> --json
//
// 步骤：素材、认人、编排、声音、成品。确认时记下当时文件的指纹，文件后来改了确认自动失效（规则在 lib/confirm.mjs）。
// 素材例外：记的是节目信息各栏的值，只是补填原来空着的栏不算改（改了确认过的栏、栏下面另写的内容才失效）。
// 补填的栏会影响简介（嘉宾是否同意、本期主题……）时，提示重出简介；嘉宾明确不同意发布时，交付前停下。
// 输出里的"下一步"都是能直接复制运行的完整命令（cmd，见 lib/env.mjs）。
// "认人"不挡后面的步骤（可以边编排边等主理人认人），但简介里提到具体的人之前要认完。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, episode, readJson, readJsonLoose, writeJson, infoBlank, infoPending, infoOneLine, isSolo, consentOf, consentStopMsg, briefInfo, updateInfoGuide, recordingsInfo, recordingMode, modeIssue, recName, recParts, badRecordings, badRecMsg, transcribeErrFile, missingMsg, sourceMissing, sourceMissingMsg, fileSha, fmt, planSha, lockInfo, loadPlan, planBadMsg, cmd, cleanable, sizeText, planCheck, planTodos, TODO_WHERE, recordingsChanged, recChangedMsg, NO_VOICE, asrEmpty, longPathMsg, streamsAskMsg, unknownMedia, unknownMediaMsg, fileMapIssue, fullBusy, fullBusyMsg, streamPickIssue, duration } from '../lib/podcast.mjs';
import { loadShow, loadVoices, showVoice, showVoiceBad, showVoiceBadMsg, showRef, targetLufs, showAsset, showClipBad, noShowHint, learnStatus, isShowFolder, showFolderMsg, oldVoice, oldVoiceHint } from '../lib/show.mjs';
import { cachedLabelEmbeddings } from './voices.mjs';
import { STEPS, confirmGate, comparesReady as comparesReadyOf, cleanBlock, buildFresh as buildFreshOf, outputReadyMsg, cutFromCurrent } from '../lib/confirm.mjs';
import { parseNames, namesIssueText, refreshNamesCmds, speakerLabels, diarSource, MIN_SPEAKER_SECONDS } from './fulltext.mjs';
const has0 = (f) => fs.existsSync(f);

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const dir = args.find((a, i) => !a.startsWith('--') && !['--confirm', '--unconfirm', '--skip'].includes(args[i - 1]));
if (!dir) { console.error(`用法: ${cmd('status.mjs')} <节目目录> [--confirm 步骤 | --unconfirm 步骤 | --skip 认人] [--json]`); process.exit(2); }
const e = episode(dir);
if (!fs.existsSync(e.work)) { console.error(`没有这个目录：${e.work}。新节目先运行 ${cmd('new.mjs', e.work, '<录音文件>')}（"<录音文件>"换成录音的完整路径）`); process.exit(1); }
// 给的是节目文件夹（下面有 节目档案/），不是某一期
if (isShowFolder(e.work)) { console.error(showFolderMsg(e.work)); process.exit(1); }

// 写坏了（planBad）要说第几行、什么原因，不能当成还没有方案；和 plan、build、check、notes 用同一个 loadPlan
const { plan, bad: planBad } = loadPlan(e);
const show = loadShow(e);
// 说话人.md 里"填完运行"那条命令写的是生成时的路径：节目目录复制、挪过，或者是旧版的半截命令，换成现在能直接运行的（表格不动，确认照样有效）
refreshNamesCmds(e);
const g = confirmGate(e, { plan, show }); // 确认门：ok(步骤)、stale(步骤)、素材的 diffInfo（lib/confirm.mjs）
const { state, ok, stale, voiceNow, mp3, soundByShow } = g;
// 旧版 节目信息.md 开头写着"改完这个文件要重新确认素材"，和现在的规则对不上：换成新的说明（只换这一行，确认不受影响）
updateInfoGuide(e);

const info = g.snap.fields;
const KEY = ['节目名', '主持人', '录音是否完整', '目标时长'];
const infoMissing = KEY.filter((k) => infoBlank(info[k]) && !infoPending(info[k]));
const infoTodo = Object.keys(info).filter((k) => infoPending(info[k])); // AI 预填的"（开场原话：……，待确认）"
const recInfo = recordingsInfo(e);
const { files: recs, orderIssue } = recInfo;
const mIssue = modeIssue(e, recInfo); // 录音方式和"音轨对应""录音顺序"对不上（多轨节目加了补录之类），transcribe 会停下
const recMissing = recs.filter((f) => !fs.existsSync(f)); // 别的盘上登记的录音被移走、删掉了
// 上次转写停在"录音文件坏了"：还坏着就说怎么修，不再叫人一遍遍重跑 transcribe（只在记过这个错时才去读录音）
const recBad = !has0(e.full) && fs.existsSync(transcribeErrFile(e)) ? badRecordings(recs) : [];
// 当初转写用的录音不在了（节目目录里的被删、挪走、改名，或者几段里少了一段）：只看节目目录里的，别的盘上的由 recMissing 说
const srcLost = has0(e.full) ? sourceMissing(e).filter((n) => !recMissing.some((f) => recName(e, f).normalize('NFC') === n.normalize('NFC'))) : [];
// 录音和上次转写时还是不是同一份（加了补录、改了录音顺序/方式、转写半路断了）：变了的话全文、方案、精编版都是旧录音的
const recCh = recordingsChanged(e);
const recStale = recCh && !recCh.mtimeOnly ? recChangedMsg(e, recCh) : null;
const has = (f) => fs.existsSync(f);
const comparesReady = comparesReadyOf(e);
const edl = readJson(path.join(e.out, '剪辑表.json'), null);
const buildFresh = buildFreshOf(e, { plan, show, voiceNow });
const solo = isSolo(info);
const consent = solo ? 'solo' : consentOf(info);

// 转写时发现录音文件不完整（文件头写的比实际能解出来的长）：transcribe 提醒过，后台跑的话可能没人看到，下面接着提醒
// 告诉过主理人、他说录音本来就这么长：提醒出来以后确认过素材，就不再打（录音换了、又出了新的提醒，照样打）
const recMeta = has(e.full) ? readJson(path.join(e.mid, '录音.json'), {}) : {};
const recWarn = recMeta.lengthWarn;
const warnAt = recWarn ? recMeta.lengthWarnAt ?? fs.statSync(path.join(e.mid, '录音.json')).mtime.toISOString() : null;

const one = opt('--confirm') ?? opt('--unconfirm') ?? opt('--skip');
if (one) {
  // 这次确认素材会让"录音可能不完整"的提醒以后不再打：确认时原样再打一次，没看过 transcribe 输出的人也知道（fix-g1 复核遗留）
  const clearsWarn = one === '素材' && opt('--confirm') && recWarn && !(state.confirmed['素材']?.at > warnAt);
  if (!STEPS.includes(one)) { console.error(`不认识的步骤「${one}」。可用：${STEPS.join('、')}`); process.exit(2); }
  if (opt('--skip')) {
    if (one !== '认人') { console.error('只有「认人」可以跳过。'); process.exit(2); }
    state.confirmed[one] = { at: new Date().toISOString(), skipped: true };
  } else if (opt('--confirm')) {
    const block = {
      素材: !recs.length ? '还没有录音文件'
        : infoTodo.length ? `节目信息.md 里还有写着"待确认"的栏：${infoTodo.join('、')}。念给主理人听，他说对了，把括号和"待确认"去掉、只留内容（他改了就照他说的写），再确认`
        : infoMissing.length ? `节目信息.md 还没填：${infoMissing.join('、')}（不知道就写"不确定"）` : null,
      认人: !has(e.names) ? `还没有 说话人.md（先在后台运行 ${cmd('speakers.mjs', e.work)}，长录音要好几分钟）` : null,
      // 主理人看的 编排方案.md 要和现在的方案一致（按 plan.mjs 记的指纹，不看修改时间）；还写着"待改"的不给确认
      编排: planBad ? planBadMsg(planBad) : !plan ? '还没有 编排方案.json' : planCheck(e, plan) ? `${planCheck(e, plan)}（先运行 ${cmd('plan.mjs', e.work)}）`
        : planTodos(plan) ? `编排方案.json 里还有 ${planTodos(plan)} 处写着"待改"（${TODO_WHERE}，机器草稿的占位）：改好、重跑 ${cmd('plan.mjs', e.work)}，给主理人看过再确认` : null,
      声音: !comparesReady && !showVoice(show) ? `还没出处理前后对比（先运行 ${cmd('build.mjs', e.work, '--compare')}）`
        // 没写 voice 就确认：以前默认按处理记下，之后补写同样的值，精编版反被判成"不是最新"（2026-11-24 第 3 轮终检）
        : !plan?.voice && !showVoice(show) ? `编排方案.json 里还没写 voice：主理人选了处理就写 "voice": "processed"，选了不处理写 "voice": "raw"，重跑 ${cmd('plan.mjs', e.work)}，再确认`
        // 写了 voice 还没重跑 plan：现在确认了，finish 照样会拦下要先跑 plan（不会让已确认的编排失效）
        : plan && planCheck(e, plan, { strict: false }) ? `${planCheck(e, plan, { strict: false })}：写好 voice 以后先运行 ${cmd('plan.mjs', e.work)}（不会让已经确认的编排失效），再确认`
        : null,
      // 成品：前面的编排、声音要是确认过的那一版，精编版要是按现在的方案剪的
      成品: !has(mp3) ? '还没有精编版'
        // 素材确认过、之后节目信息改了（比如嘉宾同意与否）：简介是按旧的写的，先重新确认素材、重跑 notes（2026-11-24 第 3 轮终检）
        : stale('素材') ? `「素材」确认之后节目信息改过，要重新确认（${cmd('status.mjs', e.work, '--confirm', '素材')}）；确认后按 status 的提示重出简介，再确认成品`
        : !ok('编排') || !ok('声音') ? `${['编排', '声音'].filter((s) => !ok(s)).map((s) => `「${s}」${stale(s) ? '确认之后改过，要重新确认' : '还没确认'}`).join('、')}。先让主理人确认这几步，再出成品、确认成品（看 ${cmd('status.mjs', e.work)}）`
        : !buildFresh && cutFromCurrent(e) ? `现在的精编版不是按现在的编排方案（或人声处理、节目档案）剪的，先运行 ${cmd('finish.mjs', e.work)} 重出，请他听过新的再确认`
        // 方案按现在的全文检查过、精编版按现在的录音剪的、机器检查通过（lib/confirm.mjs 的 outputReadyMsg，clean 用同样的判断）
        : outputReadyMsg(e, { plan, strict: !ok('编排') }),
    }[one];
    const recBlock = recStale && ['编排', '成品'].includes(one) ? recStale : null;
    if (block || recBlock) { console.error(`「${one}」还不能确认：${block ?? recBlock}`); process.exit(1); }
    state.confirmed[one] = { at: new Date().toISOString(), sha: g.fingerprint[one](), ...(one === '素材' ? { fields: g.snap.fields, rest: g.snap.rest } : {}) };
  } else delete state.confirmed[one];
  writeJson(e.state, state, 2);
  console.log(opt('--skip') ? '已记下：不给说话人对名字。' : opt('--confirm') ? `已记下：本人确认了「${one}」。` : `已撤回「${one}」的确认。`);
  if (clearsWarn) console.log(`注意：${recWarn}。（确认了素材，以后 status 不再打这条：主理人要是还不知道录音可能不完整，现在告诉他；录音确实缺了一段的话，换成完整的文件再转写）`);
}

const report = readJson(path.join(e.out, '检查报告.json'), null);
const tj = lockInfo(e, '转写'), sj = lockInfo(e, '分说话人');
const making = [lockInfo(e, '成品'), lockInfo(e, '剪辑')].find((l) => l?.alive); // finish / build 正在跑
const comparing = lockInfo(e, '对比'); // build --compare 正在出处理前后对比
// 旧版剪辑表记的是整个方案文件的指纹：还对得上就换成新写法（之后改简介、标题不算改了方案）
if (plan && edl && edl.plan === fileSha(e.plan) && edl.plan !== planSha(plan, 'audio')) { edl.plan = planSha(plan, 'audio'); writeJson(path.join(e.out, '剪辑表.json'), edl); }
const infoDiff = g.diffInfo();
const reportFresh = report && report.mp3 === fileSha(mp3);
const reportPassed = reportFresh && !report.results.some((r) => r.status === '未通过');
// 节目简介是按哪版节目信息写的：notes 在剪辑表里记着（notesInfo）；旧的没记，看修改时间（拷贝过来的时间不准，只当参考）
const brief = path.join(e.out, '节目简介.md');
const briefNow = briefInfo(info);
const briefChanged = !has(brief) ? [] : edl?.notesInfo ? Object.keys(briefNow).filter((k) => (edl.notesInfo[k] ?? '') !== briefNow[k])
  : has(e.info) && fs.statSync(e.info).mtimeMs > fs.statSync(brief).mtimeMs + 2000 ? ['节目信息'] : [];
// 嘉宾明确不同意发布：不能当成"已完成"交付
const consentText = infoOneLine(info['嘉宾是否同意']);
const consentStop = consentStopMsg(info); // finish 结尾用同一段

let next, streamsAsk, busyNow;
// 识别出 0 句（静音、底噪、放错文件）：transcribe 停下了，这里也说清楚，不再叫人原样重跑
const noVoice = asrEmpty(e);
// 全文没写完：全文.json 最后写，比 识别.json 还早，说明上次写全文时出了错（全文.txt 被占用、只读……）。分说话人在跑时它跑完会重写，不算
const mt = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const fullStale = has(e.full) && has(e.asr) && mt(e.asr) > mt(e.full) + 1000 && !sj?.alive;
// 分说话人"跑完"看 说话人.md（它最后写）：分段有了、说话人.md 没有，是半路断了。
// 说话人分段.json 不在、说话人.md 还在（重新识别后分段删了，没跳过认人）：旧的说话人.md 对不上新全文，也算没分完
// v0.7 以前做的多轨节目按音轨认人，只写了 说话人来源.json、没写 说话人分段.json（oldTracks）：全文里有说话人就是认好了，不算没分完；
// 全文里没有说话人的，跑一次 speakers 按音轨标（几秒钟，说话人.md 里填好的称呼照旧保留），待办换个说法，不说"还没分说话人"（2026-11-24 第 3 轮 11）
// v0.7 新做的多轨节目重新转写以后（transcribe 删了 说话人分段.json，说话人来源.json 留着）也是这个样子，分不出新旧
// （回归终检的旧版多轨，说话人来源.json 也比识别结果早）：下面的待办不说"旧版"，只说多轨按音轨重新标（2026-11-24 第 3 轮复核）
const oldTracks = has(e.names) && !has(e.diar) && (() => { try { return diarSource(e).source === 'tracks'; } catch { return false; } })();
const oldTracksLabeled = oldTracks && readJsonLoose(e.full, []).some?.((s) => s.speaker);
const diarPending = has(e.full) && !solo && !noVoice && ((!ok('认人') && !has(e.names)) || (has(e.names) && !has(e.diar) && !state.confirmed['认人']?.skipped && !oldTracksLabeled));
// 全文里一句都没标说话人（重新识别删掉了分段、分说话人没跑完）：认人确认过、说话人.md 在，也要说出来（v0.7 审查 24）
// 机器本来就没分出说话人（分段是空的、人声太少太短）或者认人跳过了：不算，fulltext 跑几遍也换不出说话人（2026-11-24 复核：
// 以前和"不用认人：--skip 认人"同时打，跳过以后这条还在，说成"认人确认过"）
const diarNoLabels = (() => { try { return has(e.diar) && !Object.keys(speakerLabels(readJson(e.diar, []), diarSource(e).source === 'tracks' ? 3 : MIN_SPEAKER_SECONDS, diarSource(e).source === 'tracks' ? null : recParts(e)).label).length; } catch { return false; } })();
// 认人跳过了、可分说话人的结果在（有标签）：fulltext 照样能把说话人换回全文（plan 的"谁在说"、"删光了某个人的发言"要用），照样提示；
// 跳过了、分段也不在的才不提示（2026-11-24 第 3 轮 16：719ddcd 一跳过就不提示，把能补回来的情况也藏了）
const spkSkipped = !!state.confirmed['认人']?.skipped;
const fullNoSpk = has(e.full) && !solo && !diarNoLabels && !(spkSkipped && !has(e.diar)) && !readJson(e.full, []).some((s) => s.speaker);
const multi = readJson(path.join(e.mid, '录音.json'), {}).mode === 'multitrack';
// 下一步里的命令都写成能直接复制运行的完整命令（脚本绝对路径 + 节目目录绝对路径），从哪个目录都能跑
const C = (script, ...rest) => cmd(script, e.work, ...rest);
const RULES = path.join(ROOT, 'references', '播客_编排原则.md');
// 节目目录太深（Windows 上完整路径到 260 个字）：转写、分说话人、检查都读不了 wav，原样重跑也没用，先挪目录
const longPath = recs.length && !ok('成品') ? longPathMsg(e, recordingMode(e) === 'multitrack' ? recs.length : 0) : null;
if (!recs.length && unknownMedia(e).length) next = unknownMediaMsg(e, unknownMedia(e));
else if (!recs.length) next = `运行 ${C('new.mjs', '<录音文件>')} 把原始录音放进来（"<录音文件>"换成录音的完整路径，几段录音就都写上；同一个盘用硬链接、别的盘只记位置，不复制、也不挪原文件）。不要自己复制或挪动录音`;
else if (longPath) next = `先挪目录：${longPath.replace(/再对新位置运行同一条命令.*$/, `再对新位置运行 ${cmd('status.mjs', '<新的节目目录>')} 看下一步（已经做完的不会重做）`)}`;
// 自动补转（clean 清理过中间文件，build / speakers 开工前自动重新转换录音）也拿"转写"锁：那不是第 1 步的转写，往下看在做什么
else if (tj?.alive && !tj.rewav) next = `第 1 步：转写正在后台跑（已 ${tj.minutes} 分钟），不要再启动。趁这时候和主理人填 节目信息.md`;
else if (making) next = `第 5 步：成品正在做（finish / build，进程 ${making.pid}，已 ${making.minutes} 分钟），不要再启动；等它跑完看它的输出`;
else if (comparing?.alive) next = `第 4 步：处理前后对比正在出（build --compare，进程 ${comparing.pid}），不要再启动；几秒到几十秒，等它跑完再运行 ${C('status.mjs')}`;
else if (tj?.alive) next = `转好的录音正在自动重新转换（中间文件清理过，进程 ${tj.pid}，几十秒），全文和已经确认的都不动。不要再启动；等它跑完再运行 ${C('status.mjs')}`;
else if (noVoice) next = `第 1 步：${NO_VOICE(e).replace(`再运行 ${C('transcribe.mjs')}`, `再在后台运行 ${C('transcribe.mjs')}`)}`;
else if (fullStale) next = `第 1 步：全文没写完（识别结果比 全文.json 新：上次写全文时出了错，多半是 全文.txt 或 全文提纲.md 被别的程序占着、或者是只读的）。关掉占用它们的程序、去掉只读，再在后台运行 ${C('transcribe.mjs')}（识别结果已经存好，不会重新识别）`;
else if (!has(e.full) && recMissing.length) next = `第 1 步：${missingMsg(e, recMissing)}找回来再转写`;
else if (!has(e.full) && recBad.length) next = `第 1 步：${badRecMsg(e, recBad)}。换好再在后台运行 ${C('transcribe.mjs')}`;
// 要（重新）转写，可 全文.txt、全文提纲.md 被别的程序占着、只读：transcribe 会停下，原样重跑也一样（2026-11-24 复核 #79）
else if ((recStale || !has(e.full)) && (busyNow = fullBusy(e)).length) next = `第 1 步：${fullBusyMsg(e, busyNow)}，再在后台运行 ${C('transcribe.mjs')}${has(e.full) ? ' 重新转写' : ' 转写'}`;
else if (!has(e.full) && orderIssue && recordingMode(e) !== 'multitrack') next = `第 1 步：${orderIssue}；改好后在后台运行 ${C('transcribe.mjs')} 转写`;
// 几个录音、没写录音方式：transcribe 一开工就会停下来问，先问清楚
else if (!has(e.full) && recs.length > 1 && !recordingMode(e)) next = `第 1 步：有 ${recs.length} 个录音文件，先问主理人录音方式：前后接着录的，还是多轨（每人一个文件、同时录），写进 节目信息.md 的"录音方式"（多轨再写"音轨对应"），再在后台运行 ${C('transcribe.mjs')} 转写`;
else if (!has(e.full) && mIssue) next = `第 1 步：${mIssue}。改好后在后台运行 ${C('transcribe.mjs')} 转写`;
// 一个文件里有几条音轨、没写"音轨选择"：transcribe 也会停下来问。已经按这几个录音转换过的（16k 在、录音没换）不用再问
// "音轨选择"写的超出音轨数、认不出：不管转换过没有都要先改（transcribe 照样停下；2026-11-24 复核）
else if (!has(e.full) && ((streamsAsk = streamPickIssue(e, recs)) || (!(has(e.wav16) && JSON.stringify(readJson(path.join(e.mid, '录音.json'), {}).files ?? []).normalize('NFC') === JSON.stringify(recs.map((f) => recName(e, f))).normalize('NFC'))
  && (streamsAsk = streamsAskMsg(e, recs))))) next = `第 1 步：${streamsAsk}`;
else if (!has(e.full)) next = `第 1 步：在后台运行 ${C('transcribe.mjs')} 转写，同时和主理人填 节目信息.md`;
// 录音换过、加了补录：重新转写会把每个录音重新转换一遍，新加的文件里有几条音轨、没写"音轨选择"的，transcribe 也会停下来问。
// 后台跑的话这一问容易没人看到，这里先说（新开的节目走上面 !has(e.full) 那条；2026-11-24 复核）
else if (recStale && !mIssue && !recCh.unfinished && !(orderIssue && recordingMode(e) !== 'multitrack') && (recs.length < 2 || recordingMode(e)) && (streamsAsk = streamsAskMsg(e, recs))) next = `第 1 步：录音和上次转写时不一样了（${recCh.why}），要重新转写。${streamsAsk.replace(/。?$/, '')}（内容变了会整期重新识别，句子编号会变），然后运行 ${C('plan.mjs')} 按新全文核对编排方案，改过的方案要重新给主理人确认`;
else if (recStale) next = `第 1 步：${mIssue ? `${mIssue}。改好后在后台运行 ${C('transcribe.mjs')} 重新转写，再运行 ${C('plan.mjs')} 按新全文核对编排方案，改过的方案要重新给主理人确认` : recStale}`;
else if (planBad) next = `第 3 步：${planBadMsg(planBad)}，改好再运行 ${C('plan.mjs')}。不用重读全文`;
else if (!ok('素材')) next = infoTodo.length ? `第 1 步：节目信息里「${infoTodo.join('、')}」还写着"待确认"：念给主理人听，他说对了去掉括号和"待确认"${infoMissing.length ? `，再填上还缺的 ${infoMissing.join('、')}` : ''}，然后运行 ${C('status.mjs', '--confirm', '素材')}`
  : infoMissing.length ? `第 1 步：和主理人填 节目信息.md（还缺：${infoMissing.join('、')}），念给他确认后运行 ${C('status.mjs', '--confirm', '素材')}`
  : `第 1 步：${infoDiff.changed.length ? `节目信息里确认过的「${infoDiff.changed.join('、')}」后来改了，` : infoDiff.rest ? '节目信息里各栏以外的文字（另起一段写的说明之类）确认后改过，' : ''}把 节目信息.md 念给主理人确认，确认后运行 ${C('status.mjs', '--confirm', '素材')}`;
else if (!has(e.names) && !ok('认人') && multi && !sj?.alive) next = `第 2 步：运行 ${C('speakers.mjs')}，多轨按音轨认人（几秒钟），称呼按"音轨对应"自动填`;
else if (!ok('认人') && solo) next = `第 2 步：单人节目不用认人，运行 ${C('status.mjs', '--skip', '认人')}${has(e.diar) || sj ? '（后台分出来的说话人不用管）' : ''}，然后读全文写编排方案`;
else if (!plan) next = `第 3 步：${has(e.outline) ? '先读 全文提纲.md（一块一行，几分钟扫完），再按需读 全文.txt 对应段落' : `读 全文.txt（想先看提纲：运行 ${C('fulltext.mjs')} 会生成 全文提纲.md）`}，按 ${RULES} 写 编排方案.json${has(e.draft) ? '；可以在机器草稿 编排方案.草稿.json 上改（板块按提纲块切好了，名字写着"待改"），另存为 编排方案.json' : ''}${sj?.alive ? `（分说话人还在后台跑，已 ${sj.minutes} 分钟，不用等它）` : diarPending ? `（另外在后台运行 ${C('speakers.mjs')} 分说话人，不用等它）` : ''}`;
// 检查过没有：按 plan.mjs 记的指纹。编排确认过以后只看决定声音的部分（写简介、改标题不用回第 3 步）
else if (!has(e.planMd)) next = `第 3 步：运行 ${C('plan.mjs')} 检查编排方案、出 编排方案.md`;
else if (planCheck(e, plan, { strict: !ok('编排') })) next = `第 3 步：${planCheck(e, plan, { strict: !ok('编排') })}。运行 ${C('plan.mjs')} 检查编排方案、出 编排方案.md`;
else if (!ok('编排') && planTodos(plan)) next = `第 3 步：编排方案.json 里还有 ${planTodos(plan)} 处写着"待改"（从机器草稿带来的占位：${TODO_WHERE}），按全文改好、重跑 ${C('plan.mjs')}，再给主理人看`;
else if (!ok('编排')) next = `第 3 步：把 编排方案.md（板块、删减清单和原因）给主理人过目，同意后运行 ${C('status.mjs', '--confirm', '编排')}。在这之前不剪精编版（finish、build 会拦下）${!comparesReady && !soundByShow ? `。可以先运行 ${C('build.mjs', '--compare')}（几秒钟），让他看方案的同时听处理前后对比` : ''}`;
else if (!comparesReady && !soundByShow) next = `第 4 步：运行 ${C('build.mjs', '--compare')} 出处理前后对比（几秒钟）`;
else if (!ok('声音')) next = `第 4 步：请本人听 处理前后对比/ 里的"先A后B"，选处理或不处理（写进编排方案的 voice${show ? '；问他要不要记进节目档案的"人声处理"，以后每期不用再听' : ''}），确认后运行 ${C('status.mjs', '--confirm', '声音')}`;
else if (!buildFresh) next = `第 5 步：${plan.intro?.length ? '' : '先在编排方案里写好 intro（简介正文；只写 intro、改标题不用重跑 plan），再'}运行 ${C('finish.mjs')}，一条命令剪精编版、机器检查、出简介${soundByShow ? `（人声处理按节目档案：${voiceNow === 'raw' ? '不处理' : '处理'}）` : ''}。长节目要几分钟（老电脑上 1 小时的节目约 5 分钟）：放在后台跑，跑完看输出，别中途再启动一次`;
else if (!reportFresh) next = `第 5 步：运行 ${C('check.mjs')} 做机器检查（会出 重点试听.mp3）`;
else if (!reportPassed) next = '第 5 步：机器检查没过，看 精编版/检查报告.json 处理后重剪';
else if (!has(brief)) next = `第 5 步：在编排方案里写好 intro（简介正文），运行 ${C('notes.mjs')} 出节目简介（改简介不用重剪）`;
else if (briefChanged.length) next = `第 5 步：出节目简介之后，${briefChanged[0] === '节目信息' ? '节目信息.md 改过' : `节目信息里的「${briefChanged.join('、')}」改了`}，简介和反馈表还是按旧的写的：运行 ${C('notes.mjs')} 重出（不用重剪）${consentStop ? `。另外：${consentStop}` : ''}`;
else if (!ok('成品')) next = `第 5 步：请本人先听 精编版/重点试听.mp3（几分钟，清单在 重点试听.md），有时间再从头听一遍 精编版.mp3；他说可以了再运行 ${C('status.mjs', '--confirm', '成品')}`;
else if (consentStop) next = `先停下，还不能交付：${consentStop}`;
else next = `已完成${consent === 'unsure' ? `，但节目信息里"嘉宾是否同意"还没问清楚（${infoBlank(info['嘉宾是否同意']) ? '空着' : consentText}）：发布前要和主理人确认参与者都同意` : ''}。发布由本人做；要改就改 编排方案.json，重新运行 ${C('plan.mjs')}，把改过的 编排方案.md 给主理人看、重新确认编排，再 ${C('finish.mjs')}（只改简介、标题的话，直接运行 ${C('notes.mjs')} 就行，不用重剪、不用重新确认编排）`;

// 说话人.md 填得不对的行（格式、编号、一行两个人、写了说明）：fulltext 会跳过这些行，这里提前说出来。
// 只是提醒、已经照用了的（括号里的说明去掉了），认人确认之后不再打
const namesIssues = has(e.names) ? parseNames(e, new Set(readJson(e.full, []).map((s) => s.speaker).filter(Boolean))).issues : [];
const namesShown = namesIssues.filter((x) => !x.used || !ok('认人'));
// 成品确认之后：制作文件/ 里的大文件可以清掉。只提示一次（按确认的那版精编版记），绝不自动删
// 和 clean.mjs 用同一个判断（lib/confirm.mjs 的 cleanBlock）：确认后方案又改了、转写用的录音不在了，都不提示
const cleanBytes = ok('成品') ? cleanable(e).reduce((s, x) => s + x.bytes, 0) : 0;
const cb = cleanBytes > 0 ? cleanBlock(e, { plan, show }) : null;
const cleanHint = cleanBytes > 0 && state.cleanHint !== fileSha(mp3) && (!cb.why || cb.recheck); // 只差核对录音（修改时间变了）的照样提示，clean 会先核对
const out = {
  work: e.work, recordings: recs.map((f) => recName(e, f)), recordingsMissing: recMissing, recordingsLost: srcLost, recordingOrderIssue: orderIssue, recordingModeIssue: mIssue, recordingsChanged: recCh?.why ?? null,
  files: { 全文: has(e.full), 说话人: has(e.names), 编排方案: plan ? true : planBad ? '写坏了' : false, 处理前后对比: comparesReady, 精编版: has(mp3), 检查: reportFresh ? (reportPassed ? '通过' : '未通过') : '无', 简介: has(brief) },
  // 成品确认的是这个 mp3，可之后方案、人声处理改了：不能光写"已确认"，和下面"不是最新""要重新确认"对不上（v0.7 审查 25）
  confirmed: Object.fromEntries(STEPS.map((s) => [s, ok(s) ? (s === '声音' && soundByShow ? '按节目档案' : state.confirmed[s]?.skipped ? '跳过'
    : s === '成品' && !buildFresh ? '已确认（之后方案改过或重新转写过，精编版不是最新：重剪后要重新确认）'
      : s === '成品' && (stale('编排') || stale('声音')) ? '已确认（之后编排或声音改过：先重新确认那几步）' : '已确认') : stale(s) ? '确认后文件改过，要重新确认' : '未确认'])),
  infoFilled: ok('素材') ? infoDiff.filled : [],
  consent, briefStale: briefChanged,
  namesIssues, cleanable: cleanBytes,
  musicSwapped: buildFresh ? (edl?.musicTracks ?? []).filter((x) => x.wanted) : [],
  next,
};
if (args.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
const yn = (b) => (b === true ? '有' : b === false ? '无' : b);
const extNote = (f) => (path.dirname(f) === e.work ? '' : `（在 ${path.dirname(f)}，没拷进来${recMissing.includes(f) ? '，现在找不到' : ''}）`);
// 前后接着拼的：每个文件在拼起来以后的哪一段（补录、另一期从哪儿开始）
const rp = recParts(e);
const spanNote = (f) => { const p = rp?.find((x) => x.name === recName(e, f)); return p ? `[${fmt(p.start)}–${fmt(p.start + p.dur)}]` : ''; };
console.log(`节目：${path.basename(e.work)}${info['节目名'] && !infoBlank(info['节目名']) ? `（${infoOneLine(info['节目名'])}）` : ''}　录音：${recs.map((f) => recName(e, f) + spanNote(f) + extNote(f)).join('、') || '无'}${rp ? '（[ ] 里是拼起来以后的时间）' : ''}`);
if (recMissing.length && has(e.full)) console.log(`注意：${missingMsg(e, recMissing)}不找回来的话，以后要重新转写、重剪、出对比都做不了`);
if (srcLost.length) console.log(`注意：${sourceMissingMsg(e, srcLost)}。不找回来的话，中间文件清理过以后就没法重剪、出对比、重新分说话人`);
if (recWarn && !(state.confirmed['素材']?.at > warnAt)) console.log(`注意：${recWarn}。（录音本来就这么长的话，告诉过主理人以后${ok('素材') ? '再运行一次' : '确认素材时运行'} ${C('status.mjs', '--confirm', '素材')}，之后不再提醒）`);
if (orderIssue && has(e.full) && recordingMode(e) !== 'multitrack') console.log(`注意：${orderIssue}（已经转写好的不受影响；重新转写之前要改好）`);
if (mIssue && has(e.full) && !recStale) console.log(`注意：${mIssue}（已经转写好的不受影响；重新转写之前要改好）`);
if (recCh && !tj?.alive && (has(e.full) || plan || has(mp3))) console.log(`注意：${recCh.mtimeOnly ? recChangedMsg(e, recCh) : recCh.unfinished ? `${recCh.why}：下面的编排方案、精编版、检查结果、确认都还是按上次的全文做的，见下一步` : `录音和上次转写时不一样了（${recCh.why}）：下面的全文、编排方案、精编版、确认都还是按旧录音的，见下一步`}`);
// 多轨："音轨偏移""音轨对应"写了对不上的名字（2026-11-22 审查 75）
// 还没有全文（转写停下了、还没转）：speakers 跑不了，"音轨对应"改好也是再转写（2026-11-24 第 3 轮 4）；
// 名字对不上已经写进了上面的下一步（modeIssue 先说写错的名字）就不再重复
if (recordingMode(e) === 'multitrack' && recs.length > 1) for (const [field, why] of [['音轨偏移', `再运行 ${C('transcribe.mjs')}（对不上的偏移不生效，音轨会对不齐）`], ['音轨对应', has(e.full) ? `再运行 ${C('speakers.mjs', '--force')}（对不上的称呼空着）` : `再在后台运行 ${C('transcribe.mjs')} 转写`]]) {
  const x = fileMapIssue(e, field, recs.map((f) => recName(e, f)));
  if (x && !(mIssue && mIssue.startsWith(x))) console.log(`注意：${x}，${why}`);
}
// 录音变了、转写没做完：精编版和检查结果是旧录音的，标出来，别当成现在这版通过了
const oldTag = recStale ? '（按旧录音，要重做）' : '';
console.log(`文件：${Object.entries(out.files).map(([k, v]) => `${k} ${yn(v)}${oldTag && ['精编版', '检查'].includes(k) && v && v !== '无' ? oldTag : ''}`).join('　')}`);
if (edl) console.log(`精编版：${fmt(edl.length ?? edl.voiceEnd + 11)}${recStale ? '（按旧录音剪的，重新转写后要重剪）' : buildFresh ? '' : '（方案、人声处理选择或节目档案改过，或者重新转写过，不是最新）'}`);
// 方案选的曲库曲子剪的时候没下载下来、换成了 Aurora：一直提醒到重剪，主理人确认的方案上写的是另一首（v0.7 审查 66）
for (const x of out.musicSwapped) console.log(`注意：编排方案选的配乐 ${x.wanted} 剪的时候没下载下来（${x.reason ?? '原因不明'}），精编版的${(x.swapped ?? x.parts).join('、')}用的是默认的 Aurora。告诉主理人；要用 ${x.wanted}，运行 ${cmd('music.mjs', '--download')} 补下载，再重新运行 ${C('finish.mjs')}`);
console.log(`确认：${STEPS.map((s) => `${s} ${out.confirmed[s]}`).join('　')}`);
if (consentStop) console.log(`注意：${consentStop}`);
if (out.infoFilled.length) {
  console.log(`节目信息：确认之后补填了 ${out.infoFilled.join('、')}（原来空着的栏），素材确认照样有效${out.infoFilled.includes('不想删的') && plan ? '；「不想删的」是后来补的，对一下编排方案有没有删到这些内容，删到了要改方案、重新给主理人看' : ''}${out.infoFilled.some((k) => briefChanged.includes(k)) ? '；简介用到的栏补了，要重出简介（见下一步）' : ''}`);
}
// 每个编号都填了称呼（全文里的称呼也换好了）：剩下的只是让主理人核对、确认
const spk = new Set(readJson(e.full, []).map((s) => s.speaker).filter(Boolean));
const namedAll = spk.size > 0 && has(e.names) && [...spk].every((l) => parseNames(e, spk).names[l]);
const namedInFull = namedAll && readJson(e.full, []).every((s) => !s.speaker || s.name);
if (namedAll && !ok('认人') && !solo) console.log(namedInFull
  ? `待办：说话人的称呼都填好了。请主理人核对一遍（不确定的听 声音点名.mp3），没问题就运行 ${cmd('status.mjs', e.work, '--confirm', '认人')}`
  : `待办：说话人的称呼都填好了，先运行 ${C('fulltext.mjs')} 把称呼换进全文，再请主理人核对、运行 ${cmd('status.mjs', e.work, '--confirm', '认人')}`);
else if (has(e.names) && has(e.diar) && !spk.size && !ok('认人') && !solo) console.log(`待办：机器没分出说话人（录音里的人声太少、太短），不用认人：运行 ${C('status.mjs', '--skip', '认人')}`);
else if (has(e.names) && !ok('认人') && !solo) console.log(`待办：请主理人听 声音点名.mp3、在 说话人.md 填称呼，填完运行 ${C('fulltext.mjs')} 把称呼换进全文（不挡编排；简介里提到具体的人之前要认完）`);
if (namesShown.length) console.log(namesIssueText(namesShown, C('fulltext.mjs')));
const showNote = showRef(e).note; // 节目信息.md 写的档案路径失效了（节目目录挪过）
if (show) {
  const voices = loadVoices(show), people = voices.people ?? {};
  console.log(`节目档案：${show.file}（常错词 ${show.fixes.length} 条，记住的声纹 ${Object.keys(people).length} 人）`);
  if (showNote) console.log(`注意：${showNote}`);
  if (showVoiceBad(show)) console.log(`注意：${showVoiceBadMsg(showVoiceBad(show))}`);
  // plan 之后档案又改坏了（响度写成认不出的、片头片尾配乐的文件找不到）：plan、finish 会停下，这里先说（审查 #57 复核）
  const showBad = [];
  try { targetLufs(show); } catch (err) { showBad.push(err.message); }
  // 片头片尾还要看长度（0 秒读不出来、太长）：和 plan、build 用同一个 showClipBad（2026-11-24 复核：以前只查找不找得到，finish 在 build 第 1 步才停）
  for (const k of ['片头', '片尾', '配乐']) try {
    const p = showAsset(show, k);
    if (p && k !== '配乐') { let d = 0; try { d = duration(p); } catch {} const bad = showClipBad(k, p, d); if (bad) showBad.push(bad); }
  } catch (err) { showBad.push(/^节目档案/.test(err.message) ? err.message : `"${k}"：${err.message}`); }
  if (showBad.length) console.log(`注意：节目档案有问题，plan、finish 会停下，先改 ${show.file}：${showBad.map((x) => x.replace(/。$/, '')).join('；')}。`);
  // 下一步要跑 plan / build / finish 的：先说改档案，不然照着下一步跑就停在第 1 步
  if (showBad.length && /(plan|build|finish)\.mjs/.test(next)) next = `先改节目档案（上面"节目档案有问题"那几条，改的是 ${show.file}，编排方案不用动），不然 plan、finish 会停下。改好再接着：${next}`;
  const olds = Object.entries(people).filter(([, p]) => oldVoice(p)).map(([n]) => n);
  if (olds.length) console.log(`注意：${oldVoiceHint(olds, e.work)}`);
  // 记声纹的待办：先按 --learn 同样的规则看这期有没有可记的人（主持人、常驻嘉宾这期没出现就不催）；记过的看称呼改没改（2026-11-22 审查 #28、#54）
  if (has(e.diar) && ok('认人') && !state.confirmed['认人'].skipped) {
    const embs = cachedLabelEmbeddings(e);
    const ls = learnStatus(e, show, voices, parseNames(e).names, embs ? { hasEmb: (l) => !!embs[l] } : {});
    if (!ls.regulars.size) { if (!Object.keys(people).length) console.log(`节目档案里"主持人""常驻嘉宾"都没填：想让以后各期自动认出他们，先填上，再运行 ${cmd('show.mjs', '--learn', e.work)} 记声纹`); }
    else if (ls.missing.length || ls.extra.length) console.log(`待办：认人已确认，运行 ${cmd('show.mjs', '--learn', e.work)} ${ls.changed.length || ls.extra.length ? '把这期记的声纹换成现在的称呼（记过以后称呼改过）' : `把${ls.missing.join('、')}的声纹记进档案，下一期自动认出`}`);
  }
} else console.log(`节目档案：没有（${showNote ? `${showNote}。` : ''}${noShowHint(e)}）`);
if (sj?.alive) console.log(`后台：分说话人正在跑（已 ${sj.minutes} 分钟）`);
// 全文.txt、全文提纲.md 被占着、只读：speakers 原样重跑也一样写不进去，先说这个（2026-11-24 第 3 轮 17）
else if (diarPending && (busyNow = fullBusy(e)).length) console.log(`后台：分说话人没做完：${fullBusyMsg(e, busyNow).replace('转写最后要重写', '分说话人最后要重写')}，再在后台运行 ${C('speakers.mjs')}${has(e.diar) ? '（已分好的段直接用，几秒钟）' : ''}`);
else if (diarPending && (sj || has(e.diar) || has(path.join(e.mid, '分说话人.log')))) console.log(`后台：分说话人没跑完或失败了（看 制作文件/分说话人.log 最后几行），在后台重新运行 ${C('speakers.mjs')}${has(e.diar) ? '（已分好的段直接用，几秒钟）' : ''}${sj ? `；留下的 ${path.basename(sj.file)} 可以删掉` : ''}`);
else if (diarPending && plan && oldTracks) console.log(`待办：全文里还没标说话人（多轨，按音轨认人的分段不在了）：运行 ${C('speakers.mjs')}（几秒钟，按音轨重新标，说话人.md 里填好的称呼照旧保留；不挡编排）`);
else if (diarPending && plan) console.log(`待办：还没分说话人，在后台运行 ${C('speakers.mjs')}（不挡编排）`);
else if (fullNoSpk && !diarPending && !tj?.alive && has(e.diar) && (busyNow = fullBusy(e)).length) console.log(`待办：全文里没有说话人，分说话人的结果在、还没换进全文：${fullBusyMsg(e, busyNow).replace('转写最后要重写', '换进全文要重写')}，再运行 ${C('fulltext.mjs')}`);
else if (fullNoSpk && !diarPending && !tj?.alive) console.log(`待办：全文里没有说话人${spkSkipped ? '（认人跳过了，不用填称呼，但' : ok('认人') ? '（认人确认过，但' : '（'}${has(e.diar)
  ? `分说话人的结果在，还没换进全文）：运行 ${C('fulltext.mjs')}`
  : `说话人分段.json 不在：重新转写过，或者分说话人没跑完、失败了${sj ? `；留下的 ${path.basename(sj.file)} 可以删掉` : ''}）：在后台运行 ${C('speakers.mjs')}（不挡编排；跑完看一眼 说话人.md 的称呼还对不对）`}。没有说话人，编排方案.md 的删减清单不写"谁在说"，"删光了某个人的发言"也查不出来`);
const times = readJsonLoose(path.join(e.mid, '用时.json'), []);
if (times.length) { const last = {}; for (const x of times) last[x.step] = x; console.log(`用时：${Object.values(last).map((x) => `${x.step} ${x.seconds < 90 ? `${x.seconds} 秒` : `${(x.seconds / 60).toFixed(1)} 分钟`}`).join('、')}；节目目录现在 ${times.at(-1).diskGB} GB`); }
console.log(`下一步：${next}`);
if (cleanHint) {
  console.log(`可以清理（只提示这一次，不清也行）：成品已确认，制作文件/ 里转好的录音等中间文件占 ${sizeText(cleanBytes)}，用不着了。想腾空间就运行 ${C('clean.mjs')}${cb.recheck ? '（录音文件的修改时间变了，它会先花几十秒核对内容，和转写时不一样就不清）' : ''}；识别、分说话人这些结果都留着，以后要重剪会先自动重新转换录音（几十秒）。`);
  state.cleanHint = fileSha(mp3); writeJson(e.state, state, 2);
}
