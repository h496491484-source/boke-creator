#!/usr/bin/env node
// 自检。每一项都真的执行一次，不只看文件在不在。
//
//   node tools/doctor.mjs
//
// 全部通过退出码 0；有必需项没过退出码 1。缺东西时运行 node tools/setup.mjs，它会把能装的都装上。
// 检查项在 lib/podcast.mjs 的 envChecks（podcast/start.mjs 开工时用它的轻量版）。

import fs from 'node:fs';
import { CONFIG_FILE } from './lib/env.mjs';
import { envChecks, cmd } from './lib/podcast.mjs';

const rows = await envChecks({ save: !process.argv.includes('--no-save') }); // --no-save：不把找到的 ffmpeg 位置写进本机配置（setup --check 用）

// ---- 输出 ----
const w = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((k, ch) => k + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));
for (const r of rows) {
  console.log(`${w(r.status, 8)}${w(r.name, 12)}${r.detail}`);
  if (r.fix) console.log(`${' '.repeat(20)}→ ${r.fix}`);
}
const failed = rows.filter((r) => r.status === '未通过');
console.log(failed.length
  ? `\n有 ${failed.length} 项没过：${failed.map((r) => r.name).join('、')}。按箭头后面的办法处理，再跑一次自检。`
  : `\n自检通过，可以剪播客：新的一期 ${cmd('new.mjs', '<节目目录>', '<录音文件>')}；已有的一期 ${cmd('start.mjs', '<节目目录>')}`);
if (fs.existsSync(CONFIG_FILE)) console.log(`本机路径记在 ${CONFIG_FILE}`);
process.exit(failed.length ? 1 : 0);
