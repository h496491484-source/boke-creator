#!/usr/bin/env node
// 节目档案：一档节目设置一次，每期自动用上（主播、常错词、片头片尾、配乐、响度、剪辑偏好、简介风格、常驻主播的声纹）。
//
//   node tools/podcast/show.mjs --new <节目文件夹> [--name 节目名]   建档案：<节目文件夹>/节目档案/（档案.md + 素材/）
//   node tools/podcast/show.mjs <节目目录或节目文件夹>               看这期用的是哪份档案、里面有什么
//   node tools/podcast/show.mjs --learn <节目目录> [--all]           把这期认好的主持人、常驻嘉宾的声纹记进档案（--all：说话人.md 里填了称呼的都记）
//   node tools/podcast/show.mjs --forget <节目目录或节目文件夹> <称呼>  从档案里删掉一个人的声纹
//
// 档案放在节目文件夹里、和各期并排，新的一期建在同一个节目文件夹下就会自动找到。细节见 references/播客_节目档案.md。

import fs from 'node:fs';
import path from 'node:path';
import { relaunchOnMac, episode } from '../lib/podcast.mjs';
import { SHOW_DIR, SHOW_FIELDS, showTemplate, readShow, loadShow, showAsset, targetLufs, loadVoices, saveVoices, unit } from '../lib/show.mjs';
import { readNames } from './fulltext.mjs';

relaunchOnMac();
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const pos = args.filter((a, i) => !a.startsWith('--') && !['--name'].includes(args[i - 1]));
const usage = () => { console.error('用法: show.mjs --new <节目文件夹> [--name 节目名] | show.mjs <节目目录> | show.mjs --learn <节目目录> [--all] | show.mjs --forget <节目目录> <称呼>'); process.exit(2); };

// 给一个目录，找它用的档案：它自己就是节目文件夹（下面有 节目档案/），或者是一期节目
function showFor(dir) {
  const own = path.join(path.resolve(dir), SHOW_DIR);
  if (fs.existsSync(path.join(own, '档案.md'))) return readShow(own);
  if (path.basename(path.resolve(dir)) === SHOW_DIR && fs.existsSync(path.join(dir, '档案.md'))) return readShow(path.resolve(dir));
  return loadShow(episode(dir));
}
const noShow = (dir) => { console.error(`${dir} 没有找到节目档案。先建一份：node tools/podcast/show.mjs --new <节目文件夹>，再把这期节目放进那个节目文件夹（或在 节目信息.md 写"节目档案：路径"）。`); process.exit(1); };

try {
  if (flag('--new')) {
    const root = pos[0];
    if (!root) usage();
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
    const e = episode(dir);
    const show = loadShow(e);
    if (!show) noShow(dir);
    if (!fs.existsSync(e.diar)) throw new Error('这期还没分说话人（speakers.mjs），没有声纹可记。');
    const names = readNames(e);
    if (!Object.keys(names).length) throw new Error('说话人.md 里还没填称呼。主理人认完人再记。');
    const split = (v) => (v || '').split(/[、,，;；\s]+/).map((x) => x.replace(/[（(].*?[)）]/g, '').trim()).filter((x) => x && !/^(无|没有)$/.test(x));
    const regulars = new Set([...split(show.get('主持人')), ...split(show.get('常驻嘉宾'))]);
    if (!regulars.size && !flag('--all')) throw new Error('档案里"主持人""常驻嘉宾"都没填，不知道该记谁。先填上；或者加 --all，把这期填了称呼的人都记下。');
    const { labelEmbeddings } = await import('./voices.mjs');
    const labels = labelEmbeddings(e);
    // 同一个称呼可能对着几个编号（机器把一个人拆开了）：合起来，按秒数加权
    const byName = {};
    for (const [lab, name] of Object.entries(names)) {
      if (/不确定|不认识|不知道|[?？]/.test(name) || !labels[lab]) continue;
      if (!flag('--all') && !regulars.has(name)) continue;
      (byName[name] ??= []).push(labels[lab]);
    }
    if (!Object.keys(byName).length) throw new Error(`这期没有可记的人。说话人.md 里填的称呼要和档案里的主持人、常驻嘉宾写法一样（档案里：${[...regulars].join('、') || '空'}）。`);
    const data = loadVoices(show);
    data.people ??= {};
    const ep = path.basename(e.work);
    const done = [];
    for (const [name, list] of Object.entries(byName)) {
      const old = data.people[name];
      if (old?.episodes?.includes(ep)) { done.push(`${name}（这期记过了，跳过）`); continue; }
      // 旧的最多按 5 分钟算权重：声音会随设备、环境变，新的几期要有分量
      const parts = [...list.map((x) => ({ v: x.v, w: x.sec })), ...(old ? [{ v: old.v, w: Math.min(old.sec, 300) }] : [])];
      const acc = new Float64Array(parts[0].v.length);
      for (const p of parts) for (let i = 0; i < acc.length; i++) acc[i] += p.v[i] * p.w;
      const sec = list.reduce((s, x) => s + x.sec, 0);
      data.people[name] = { v: unit(acc), sec: +((old?.sec ?? 0) + sec).toFixed(1), episodes: [...(old?.episodes ?? []), ep], updated: new Date().toISOString().slice(0, 10) };
      done.push(`${name}（${old ? '更新' : '新记'}，用了 ${sec.toFixed(0)} 秒）`);
    }
    saveVoices(show, data);
    console.log(`记进档案的声纹：${done.join('、')}。档案里现在有 ${Object.keys(data.people).length} 个人：${Object.keys(data.people).join('、')}。`);
    console.log('下一期分说话人时会自动认出他们（说话人.md 里预填称呼，主理人还是要听一下核对）。声纹只存在本机的 节目档案/声纹.json。');
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
  const filled = Object.keys(SHOW_FIELDS).filter((k) => show.get(k));
  const blank = Object.keys(SHOW_FIELDS).filter((k) => !show.get(k));
  for (const k of filled) console.log(`  ${k}：${show.get(k)}`);
  if (blank.length) console.log(`  没填：${blank.join('、')}`);
  const asset = (k) => { try { const p = showAsset(show, k); return p === 'default' ? '技能自带（CC0）' : p ? `${path.basename(p)}（找到了）` : '无'; } catch (err) { return `有问题：${err.message}`; } };
  console.log(`  片头 ${asset('片头')}；片尾 ${asset('片尾')}；配乐 ${asset('配乐')}；响度 ${(() => { try { return targetLufs(show); } catch (err) { return err.message; } })()} LUFS`);
  console.log(`  常错词 ${show.fixes.length} 条${show.fixes.length ? `：${show.fixes.slice(0, 6).map((f) => `${f.from}→${f.to}`).join('、')}${show.fixes.length > 6 ? '……' : ''}` : ''}`);
  const people = Object.entries(loadVoices(show).people ?? {});
  console.log(`  记住的声纹 ${people.length} 人${people.length ? `：${people.map(([n, p]) => `${n}（${p.episodes.length} 期）`).join('、')}` : '（认人确认后运行 show.mjs --learn <节目目录> 记下）'}`);
} catch (err) { console.error(err.message); process.exit(1); }
