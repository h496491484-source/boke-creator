#!/usr/bin/env node
// 开一期新节目：建文件夹，把原始录音拷进来（原文件不动），写一份待填的 节目信息.md。
//
//   node tools/podcast/new.mjs <节目目录> <录音文件> [更多录音文件……]
//
// 录音有好几段（比如前后半场）就都给上，顺序以 节目信息.md 里的"录音顺序"为准。

import fs from 'node:fs';
import path from 'node:path';
import { episode, AUDIO } from '../lib/podcast.mjs';

const [dir, ...files] = process.argv.slice(2);
if (!dir) { console.error('用法: node tools/podcast/new.mjs <节目目录> <录音文件> [更多录音文件……]'); process.exit(2); }
const e = episode(dir);
fs.mkdirSync(e.mid, { recursive: true });

const copied = [];
for (const f of files) {
  if (!fs.existsSync(f)) { console.error(`找不到录音：${f}`); process.exit(1); }
  if (!AUDIO.test(f)) { console.error(`不是常见的音频格式：${f}`); process.exit(1); }
  // 文件名里的反引号、空格之类在命令行里容易出事，拷进来时换成安全的字符
  const name = path.basename(f).replace(/[`'"$&|<>^%!]/g, '_').replace(/\s+/g, '_');
  const dest = path.join(e.work, name);
  if (!fs.existsSync(dest)) fs.copyFileSync(f, dest);
  copied.push(name);
}

if (!fs.existsSync(e.info)) {
  fs.writeFileSync(e.info, `# 节目信息

开工前和主理人问清楚。拿不准的写"不确定"，不要猜。改完这个文件要重新确认"素材"这一步。

- 节目名：（比如"某某播客"）
- 本期主题：（主持人原话怎么说的，比如"穷过日子时代，你的消费观"）
- 主持人：（称呼）
- 嘉宾：（几个人、各自的称呼；记不全写"约 N 人"；只有主持人一个人就写"单人"）
- 录音是否完整：（给的是不是全部录音；不是的话还差什么）
- 录音方式：${copied.length > 1 ? '（几个文件是"前后接着"录的，还是"多轨"——每人一个话筒、各录一个文件、同时录的？二选一）' : '单个文件'}
- 录音顺序：${copied.length > 1 ? copied.join('、') : '（只有一个文件不用填；前后接着录的几个文件，按播放顺序写文件名，用顿号隔开）'}
- 音轨对应：（多轨才填：每个文件是谁，比如 ${copied.length > 1 ? copied.map((n, i) => `${n}=${i ? '嘉宾' : '主持人'}`).join('、') : 'host.wav=主持人、guest.wav=嘉宾'}）
- 音轨偏移：（多轨才填，一般不用：某条音轨比别的晚开始录，写 文件名=+秒数，比如 guest.wav=+1.2）
- 目标时长：（精编版想要多少分钟，比如 35–40）
- 固定开场白：（有没有固定的片头或开场白；有的话把音频放进来，写文件名）
- 嘉宾是否同意：（参与者知不知道会剪辑发布、会被切成短视频）
- 发布平台：（小宇宙、喜马拉雅、B 站……）
- 不想删的：（主理人点名要保留的段落或人，没有就写"无"）
`, 'utf8');
}

console.log(`节目目录：${e.work}`);
if (copied.length) console.log(`拷进来的录音：${copied.join('、')}（原文件没动）`);
console.log('下一步：和主理人一起填 节目信息.md，然后运行 node tools/podcast/transcribe.mjs <节目目录> 开始转写（转写不用等信息填完）。');
