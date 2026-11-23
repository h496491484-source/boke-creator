#!/usr/bin/env node
// 节目档案：一档节目设置一次，每期自动用上（主播、常错词、片头片尾、配乐、响度、剪辑偏好、简介风格、常驻主播的声纹）。
//
//   node tools/podcast/show.mjs --new <节目文件夹> [--name 节目名]   建档案：<节目文件夹>/节目档案/（档案.md + 素材/）
//   node tools/podcast/show.mjs <节目目录或节目文件夹>               看这期用的是哪份档案、里面有什么
//   node tools/podcast/show.mjs --learn <节目目录> [--all] [--force]  把这期认好的主持人、常驻嘉宾的声纹记进档案（--all：说话人.md 里填了称呼的都记）
//                                                                    要先确认认人；称呼改过再跑一次，会把这期记的换掉。声音和档案里记的对不上会停下（--force 照记）
//   node tools/podcast/show.mjs --forget <节目目录或节目文件夹> <称呼>  从档案里删掉一个人的声纹
//
// 档案放在节目文件夹里、和各期并排，新的一期建在同一个节目文件夹下就会自动找到。细节见 references/播客_节目档案.md。

import fs from 'node:fs';
import path from 'node:path';
import { relaunchOnMac, episode, cmd, mustExist, readInfo, isSolo, loadPlan, fileSha } from '../lib/podcast.mjs';
import { SHOW_DIR, SHOW_FIELDS, showTemplate, readShow, loadShow, showRef, showUp, showKids, noShowHint, showAsset, targetLufs, showVoiceBad, showVoiceBadMsg, loadVoices, saveVoices, unit, cosine, VOICE, isShowFolder, regularsOf, learnWant, episodeKey, findPart, copyPart, legacyHas, learnSig, foldVoice, oldVoice, oldVoiceHint } from '../lib/show.mjs';
import { confirmGate } from '../lib/confirm.mjs';
import { readNames } from './fulltext.mjs';

relaunchOnMac();
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const pos = args.filter((a, i) => !a.startsWith('--') && !['--name'].includes(args[i - 1]));
const usage = () => { console.error(`用法: ${cmd('show.mjs')} --new <节目文件夹> [--name 节目名] | ${cmd('show.mjs')} <节目目录> | ${cmd('show.mjs')} --learn <节目目录> [--all] | ${cmd('show.mjs')} --forget <节目目录> <称呼>`); process.exit(2); };

// 给一个目录，找它用的档案：它自己就是节目文件夹（下面有 节目档案/），或者是一期节目
function showFor(dir) {
  const own = path.join(path.resolve(dir), SHOW_DIR);
  if (fs.existsSync(path.join(own, '档案.md'))) return readShow(own);
  if (path.basename(path.resolve(dir)) === SHOW_DIR && fs.existsSync(path.join(dir, '档案.md'))) return readShow(path.resolve(dir));
  return loadShow(episode(dir));
}
const noShow = (dir) => {
  // 给的是一期节目：和 status、new 给一样的建议（上面更远处有档案就指过去，上一层放着别的节目就别在那里建）
  if (fs.existsSync(path.join(path.resolve(dir), '节目信息.md'))) { const e = episode(dir); const ref = showRef(e); console.error(`${dir} 没有找到节目档案。${ref.note ? `${ref.note}。` : ''}${noShowHint(e)}。`); process.exit(1); }
  console.error(`${dir} 没有找到节目档案。先建一份：${cmd('show.mjs', '--new', '<节目文件夹>')}，再把这期节目放进那个节目文件夹（或在 节目信息.md 写"节目档案：路径"）。`); process.exit(1);
};

try {
  if (flag('--new')) {
    const root = pos[0];
    if (!root) usage();
    // 建错地方的两种情况：给的是一期节目的目录；或者下面某个文件夹已经是有档案的节目文件夹（同一档节目会有两份档案，各期用哪份就乱了）
    const r = path.resolve(root);
    if (fs.existsSync(path.join(r, '节目信息.md'))) { console.error(`${r} 是一期节目的目录，不是节目文件夹。档案建在它的上一层：${cmd('show.mjs', '--new', path.dirname(r))}`); process.exit(1); }
    if (!fs.existsSync(path.join(r, SHOW_DIR, '档案.md'))) {
      // 上面三层里已经有档案：这个文件夹在别的节目文件夹里面，再建一份，下面的各期就不知道用哪份了
      const up = showUp(path.dirname(r), 3);
      if (up && !flag('--force')) { const p = path.dirname(up); console.error(`上面的 ${p} 已经有节目档案（${path.join(up, '档案.md')}），${r} 在它里面。同一档节目不用再建：一期节目离档案超过三层、没自动用上的话，在那期的 节目信息.md 写"节目档案：<档案的路径>"（新的一期也可以 ${cmd('new.mjs', '<节目目录>', '<录音文件>', '--show', p)}）。确实是另一档节目，最好给它一个不在 ${p} 里面的文件夹，或者加 --force 照建。`); process.exit(1); }
      const { shows: kids, eps } = showKids(r);
      if (kids.length) { console.error(`${r} 下面的「${kids.join('」「')}」已经是节目文件夹（有 节目档案/档案.md）。同一档节目别再建一份：新的一期建在那个文件夹下面（${cmd('new.mjs', path.join(r, kids[0], '<日期_期号>'), '<录音文件>')}）。确实是另一档节目，给它单独建一个文件夹再建档案。`); process.exit(1); }
      // 下面（三层以内，这些都会往上找到这份档案）放着几档不同的节目（节目名不一样）：在这里建，它们都会用上这一份档案（2026-11-22 审查 #28；11-23 复核：子文件夹里的也算）
      const names = [...new Set(eps.map((x) => x.name).filter(Boolean))];
      if (names.length > 1 && !flag('--force')) { console.error(`${r} 下面放着几档不同的节目（${eps.filter((x) => x.name).map((x) => `「${x.dir}」是${x.name}`).join('、')}）。在这里建档案，它们都会用上这一份（常错词、片头片尾、人声处理、响度都会套上去）。给每档节目单独建一个文件夹、把各期挪进去，再分别建档案；确定是同一档（只是节目名写法不同），加 --force 照建。`); process.exit(1); }
    }
    const dir = path.join(path.resolve(root), SHOW_DIR);
    fs.mkdirSync(path.join(dir, '素材'), { recursive: true });
    const file = path.join(dir, '档案.md');
    if (fs.existsSync(file)) console.log(`已经有档案了，没动它：${file}`);
    else { fs.writeFileSync(file, showTemplate(opt('--name') ?? ''), 'utf8'); console.log(`建好了：${file}`); }
    console.log(`片头、片尾、自己的配乐、以前的简介放进 ${path.join(dir, '素材')}，在 档案.md 里写文件名。`);
    console.log(`以后每期建在 ${path.resolve(root)} 下面（比如 ${path.join(path.resolve(root), '2026-11-20_第12期')}），会自动用这份档案。`);
    process.exit(0);
  }

  if (flag('--learn')) {
    const dir = pos[0];
    if (!dir) usage();
    // 给的不是某一期（节目文件夹、节目档案/、不存在的目录）：说清楚，不要说"没有档案"或"还没分说话人"（2026-11-22 审查 #61）
    mustExist(dir);
    const r = path.resolve(dir);
    const root = isShowFolder(r) ? r : path.basename(r) === SHOW_DIR && fs.existsSync(path.join(r, '档案.md')) ? path.dirname(r) : null;
    if (root) { const eps = showKids(root).eps.map((x) => x.dir).sort(); console.error(`${r} 是节目文件夹${root === r ? '' : '里的 节目档案/'}，不是某一期节目。--learn 要对某一期运行，比如 ${cmd('show.mjs', '--learn', path.join(root, eps.at(-1) ?? '<那一期>'))}${eps.length ? `（已有的几期：${eps.join('、')}）` : ''}`); process.exit(1); }
    if (!fs.existsSync(path.join(r, '节目信息.md'))) { console.error(`${r} 不是一期节目的目录（里面没有 节目信息.md）。--learn 要对某一期节目的目录运行。`); process.exit(1); }
    const e = episode(dir);
    const show = loadShow(e);
    if (!show) noShow(dir);
    const all = flag('--all'), force = flag('--force');
    if (!fs.existsSync(e.diar)) {
      if (isSolo(readInfo(e))) throw new Error(`这期是单人节目，转写时没分说话人，没有声纹可记。单人节目一般不用记（只有一个人，不用认）。以后会有嘉宾、想让程序认出主持人的话：运行 ${cmd('speakers.mjs', e.work)}，在 说话人.md 填主持人的称呼，运行 ${cmd('status.mjs', e.work, '--confirm', '认人')}，再运行 ${cmd('show.mjs', '--learn', e.work)}。`);
      throw new Error(`这期还没分说话人，没有声纹可记。先运行 ${cmd('speakers.mjs', e.work)}，请主理人在 说话人.md 填称呼、确认认人，再记。`);
    }
    // 认人要先确认：说话人.md 里可能是机器预填、主理人还没核对的称呼，记错了会弄脏档案（2026-11-22 审查 #54）
    const g = confirmGate(e, { plan: loadPlan(e).plan, show });
    const skipped = !!g.state.confirmed['认人']?.skipped;
    if (!force && (!g.ok('认人') || skipped)) throw new Error(`${skipped ? '这期跳过了认人（--skip 认人）' : g.stale('认人') ? '认人确认之后 说话人.md 改过，要重新确认' : '认人还没确认'}。说话人.md 里的称呼要主理人核对过才记（记错了会弄脏档案）：请他核对后运行 ${cmd('status.mjs', e.work, '--confirm', '认人')}，再记。一定要现在记，加 --force。`);
    const names = readNames(e);
    if (!Object.keys(names).length) throw new Error('说话人.md 里还没填称呼。主理人认完人再记。');
    const regulars = regularsOf(show);
    if (!regulars.size && !all) throw new Error('档案里"主持人""常驻嘉宾"都没填，不知道该记谁。先填上；或者加 --all，把这期填了称呼的人都记下。');
    const { labelEmbeddings } = await import('./voices.mjs');
    const labels = labelEmbeddings(e);
    const want = learnWant(names, regulars, { all, hasEmb: (lab) => !!labels[lab] });
    const data = loadVoices(show);
    data.people ??= {};
    const key = episodeKey(e, show), diarSha = fileSha(e.diar);
    const today = new Date().toISOString().slice(0, 10);
    // 这期以前记过、现在 说话人.md 里已经没有这个称呼的（称呼改了）：去掉这期记的那份
    const gone = Object.keys(data.people).filter((n) => findPart(data.people[n], key, show) && !Object.values(names).includes(n));
    if (!Object.keys(want).length && !gone.length) {
      console.log(`这期没有要记的人：说话人.md 里填的称呼，没有档案里的主持人、常驻嘉宾（档案里：${[...regulars].join('、') || '空'}）。他们这期都没出现的话，不用记，status 也不会再提；写法不一样的话，把 说话人.md 或档案改成一样再记。`);
      process.exit(0);
    }
    // 先全部检查一遍，有问题一条都不记
    const plans = [], problems = [], notes = [], alerts = [];
    for (const [name, labs] of Object.entries(want)) {
      // 同一个称呼对着几个编号（机器把一个人拆开了）：合起来，按秒数加权；这几个编号的声音要像
      for (let i = 0; i < labs.length; i++) for (let j = i + 1; j < labs.length; j++) {
        const s = cosine(labels[labs[i]].v, labels[labs[j]].v);
        if (s < VOICE.maybe) problems.push(`${name}：这期 ${labs[i]}、${labs[j]} 都填了 ${name}，可是这两个编号的声音不像（相似度 ${s.toFixed(2)}），多半有一个填错了`);
      }
      const acc = new Float64Array(labels[labs[0]].v.length);
      let sec = 0;
      for (const l of labs) { const x = labels[l]; for (let i = 0; i < acc.length; i++) acc[i] += x.v[i] * x.sec; sec += x.sec; }
      const part = { ep: key.ep, wav: key.wav, sig: learnSig(diarSha, labs), v: unit(acc), sec: +sec.toFixed(1), at: today };
      const person = data.people[name];
      // 同一份录音的另一期（拷贝出来的、目录还在）记过了，不重复记；按录音指纹找到、原来的目录不在了，是这期改过名
      const copy = copyPart(person, key, show);
      if (copy) { notes.push(`${name}（这期的录音和 ${copy.ep} 是同一份，那期记过了，跳过）`); continue; }
      const mine = findPart(person, key, show);
      // 档案里这个人是旧版（0.7 以前）记的：旧的扔掉，用这期（加上 0.7 以后记的几期）重建，不叠在旧的上面（2026-11-23）。
      // 旧版算法算出的声纹和新算的比会偏，叠上去提醒永远消不掉，认人也照样不准
      const old = oldVoice(person);
      if (old) {
        const keep = (person.parts ?? []).filter((p) => p !== mine);
        // 和档案里同名的比（旧版的那份，加上 0.7 以后记的几期）：太不像多半是这期称呼填错了，和新版档案一样停下、一个都不记，
        // 要 --force 才记（2026-11-24 复核：以前只打一行"注意"、退出码 0，把嘉宾的声音当成主持人记进去，扔掉原来对的那份）。
        // 同一个人新旧算法实测相似度 0.76–1.0，低于"有点像"（VOICE.maybe）不是算偏能解释的
        const s = cosine(part.v, person.v);
        const later = keep.length ? foldVoice({ parts: keep }) : null;
        const s2 = later ? cosine(part.v, later.v) : null;
        if (s < VOICE.maybe || (s2 != null && s2 < VOICE.maybe)) problems.push(`${name}：这期的声音和档案里记的 ${name} 不像（${s < VOICE.maybe ? `和旧版记的相似度 ${s.toFixed(2)}` : ''}${s < VOICE.maybe && s2 != null && s2 < VOICE.maybe ? '，' : ''}${s2 != null && s2 < VOICE.maybe ? `和 0.7 以后记的 ${keep.length} 期相似度 ${s2.toFixed(2)}` : ''}；同一个人新旧算法一般也在 0.75 以上），多半填错了称呼`);
        // 以前这句后面跟着"档案里的旧版声纹先不动"：不加 --force 时上面"没有记（一个都没动）"已经说了；加了 --force 时旧版的已经扔掉、
        // 按这期重记，再这么说就和"已扔掉"那行自相矛盾（2026-11-24 第 3 轮 18）
        plans.push({ name, person, mine, part, old: keep, note: `${name}（档案里是旧版（0.7 以前）记的，已扔掉，用这期${keep.length ? `和 0.7 以后记的 ${keep.length} 期` : ''}重新记，用了 ${sec.toFixed(0)} 秒）` });
        continue;
      }
      if (mine && mine.sig === part.sig) {
        if (mine.ep !== key.ep) { mine.ep = key.ep; plans.push({ name, person, note: `${name}（这期的目录改过名，记录跟着改了）` }); }
        else notes.push(`${name}（这期记过了，称呼没变，跳过）`);
        continue;
      }
      if (!mine && person && legacyHas(person, e)) { notes.push(`${name}（这期是旧版记的，跳过。记错了的话：${cmd('show.mjs', '--forget', e.work, name)} 删掉这个人，再对各期重新 --learn）`); continue; }
      // 和档案里这个人以前的声音比（不算这期以前记的那份）：太不像多半是填错了称呼
      const before = person ? foldVoice({ ...person, base: person.parts ? person.base : { v: person.v, sec: person.sec, episodes: person.episodes ?? [] }, parts: (person.parts ?? []).filter((p) => p !== mine) }) : null;
      if (before) { const s = cosine(part.v, before.v); if (s < VOICE.maybe) problems.push(`${name}：这期的声音和档案里记的 ${name} 不像（相似度 ${s.toFixed(2)}），多半填错了称呼`); }
      // 新记的称呼和档案里别的人声音几乎一样：可能是同一个人记了两个称呼
      if (!person) for (const [other, q] of Object.entries(data.people)) { const s = q?.v ? cosine(part.v, q.v) : 0; if (s >= VOICE.same) alerts.push(`注意：${name} 的声音和档案里的 ${other} 几乎一样（相似度 ${s.toFixed(2)}），可能是同一个人记了两个称呼。是的话运行 ${cmd('show.mjs', '--forget', e.work, name)} 删掉一个，以后 说话人.md 里统一写 ${other}`); }
      plans.push({ name, person, mine, part, note: `${name}（${mine ? '称呼改过，换掉这期记的' : person ? '更新' : '新记'}，用了 ${sec.toFixed(0)} 秒）` });
    }
    if (problems.length && !force) throw new Error(`没有记（一个都没动）：\n${problems.map((x) => '  · ' + x).join('\n')}\n请主理人听 声音点名.mp3 核对 说话人.md，改好、重新确认认人再记。确定没填错，加 --force 照记。`);
    const done = [...notes];
    for (const p of plans) {
      if (p.old) {
        const parts = [...p.old, p.part];
        const f = foldVoice({ parts });
        data.people[p.name] = { v: f.v, sec: f.sec, episodes: f.episodes, updated: today, parts };
      } else if (p.part) {
        const person = p.person ?? {};
        // 旧版记的（没有按期分开存）：原来的声纹当成底子，不动它
        const base = person.parts ? person.base : person.v ? { v: person.v, sec: person.sec, episodes: person.episodes ?? [] } : undefined;
        const parts = [...(person.parts ?? []).filter((x) => x !== p.mine), p.part];
        const f = foldVoice({ base, parts });
        data.people[p.name] = { v: f.v, sec: f.sec, episodes: f.episodes, updated: today, ...(base ? { base } : {}), parts };
      } else if (p.person) p.person.episodes = foldVoice(p.person).episodes;
      done.push(p.note);
    }
    for (const n of gone) {
      const person = data.people[n];
      const parts = person.parts.filter((x) => x !== findPart(person, key, show));
      const f = foldVoice({ base: person.base, parts });
      if (f) data.people[n] = { ...person, v: f.v, sec: f.sec, episodes: f.episodes, updated: today, parts };
      else delete data.people[n];
      done.push(`${n}（这期的 说话人.md 里已经没有这个称呼，去掉这期记的${f ? '' : '；他没有别的期了，整个删掉'}）`);
    }
    if (problems.length) alerts.push(`照记了（加了 --force）：${problems.join('；')}`);
    saveVoices(show, data);
    console.log(`记进档案的声纹：${done.join('、')}。档案里现在有 ${Object.keys(data.people).length} 个人：${Object.keys(data.people).join('、') || '无'}。`);
    for (const a of alerts) console.log(a);
    console.log('下一期分说话人时会自动认出他们（说话人.md 里预填称呼，主理人还是要听一下核对）。称呼记错了：改好 说话人.md、重新确认认人，再运行一次 --learn，会把这期记的换掉。声纹只存在本机的 节目档案/声纹.json。');
    process.exit(0);
  }

  if (flag('--forget')) {
    const [dir, name] = pos;
    if (!dir || !name) usage();
    const show = showFor(dir) ?? noShow(dir);
    const data = loadVoices(show);
    if (!data.people?.[name]) throw new Error(`档案里没有"${name}"的声纹。现有：${Object.keys(data.people ?? {}).join('、') || '无'}`);
    delete data.people[name];
    saveVoices(show, data);
    console.log(`已从档案里删掉"${name}"的声纹。`);
    process.exit(0);
  }

  const dir = pos[0];
  if (!dir) usage();
  const show = showFor(dir) ?? noShow(dir);
  console.log(`节目档案：${show.file}`);
  // 给的是一期节目、节目信息.md 里写的档案路径失效了（节目目录挪过）：说出来
  const ref = fs.existsSync(path.join(path.resolve(dir), '节目信息.md')) ? showRef(episode(dir)) : null;
  // start.mjs 先跑了 status、它已经说过的几条"注意"，这里不再重复（审查 #55 复核）
  const quiet = flag('--after-status');
  if (ref?.note && !quiet) console.log(`  注意：${ref.note}`);
  const filled = Object.keys(SHOW_FIELDS).filter((k) => show.get(k));
  const blank = Object.keys(SHOW_FIELDS).filter((k) => !show.get(k));
  for (const k of filled) console.log(`  ${k}：${show.get(k)}`);
  if (blank.length) console.log(`  没填：${blank.join('、')}`);
  if (showVoiceBad(show) && !quiet) console.log(`  注意：${showVoiceBadMsg(showVoiceBad(show))}`);
  const asset = (k) => { try { const p = showAsset(show, k); return p === 'default' ? '技能自带（CC0）' : p ? `${path.basename(p)}（找到了）` : '无'; } catch (err) { return `有问题：${err.message}`; } };
  console.log(`  片头 ${asset('片头')}；片尾 ${asset('片尾')}；配乐 ${asset('配乐')}；响度 ${(() => { try { return `${targetLufs(show)} LUFS`; } catch (err) { return `有问题：${err.message}`; } })()}`);
  console.log(`  常错词 ${show.fixes.length} 条${show.fixes.length ? `：${show.fixes.slice(0, 6).map((f) => `${f.from}→${f.to}`).join('、')}${show.fixes.length > 6 ? '……' : ''}` : ''}`);
  const people = Object.entries(loadVoices(show).people ?? {});
  // 给的是一期节目（不是节目文件夹）就直接带上它的路径，命令能直接复制运行
  const isEp = path.resolve(show.dir) !== path.resolve(dir) && path.resolve(show.dir) !== path.join(path.resolve(dir), SHOW_DIR);
  console.log(`  记住的声纹 ${people.length} 人${people.length ? `：${people.map(([n, p]) => `${n}（${p.episodes?.length ?? 0} 期）`).join('、')}` : `（多人节目认人确认后运行 ${cmd('show.mjs', '--learn', isEp ? path.resolve(dir) : '<节目目录>')} 记下；单人节目不用记）`}`);
  const olds = people.filter(([, p]) => oldVoice(p)).map(([n]) => n);
  if (olds.length && !quiet) console.log(`  注意：${oldVoiceHint(olds, path.resolve(dir))}`);
} catch (err) { console.error(err.message); process.exit(1); }
