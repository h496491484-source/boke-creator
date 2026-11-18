// 找本地识别程序和识别模型。setup、doctor 和播客脚本共用。只用 CPU，不要 Python，不联网。
//
// 用的是 sherpa-onnx（npm 包 sherpa-onnx-node）和 SenseVoice 模型。位置的查找顺序：
//   程序：环境变量 SHERPA_ONNX_DIR → boke-creator.local.json 的 sherpaDir → 技能目录（npm install 装的）
//   模型：环境变量 ASR_MODEL_DIR  → boke-creator.local.json 的 asrModelDir → 技能目录 models/sense-voice

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig } from './lib/env.mjs';

export function findSherpa(cfg = loadConfig()) {
  const dirs = [process.env.SHERPA_ONNX_DIR, cfg.sherpaDir, ROOT].filter(Boolean);
  for (const d of dirs) {
    const pkg = path.join(d, 'node_modules', 'sherpa-onnx-node');
    if (fs.existsSync(path.join(pkg, 'package.json'))) return { ok: true, dir: d, pkg };
  }
  return { ok: false };
}
export function findModel(cfg = loadConfig()) {
  const dirs = [process.env.ASR_MODEL_DIR, cfg.asrModelDir, path.join(ROOT, 'models', 'sense-voice')].filter(Boolean);
  for (const d of dirs) {
    if (!fs.existsSync(path.join(d, 'tokens.txt'))) continue;
    const model = ['model.int8.onnx', 'model.onnx'].map((f) => path.join(d, f)).find((f) => fs.existsSync(f));
    if (model) return { ok: true, dir: d, model, tokens: path.join(d, 'tokens.txt') };
  }
  return { ok: false };
}
