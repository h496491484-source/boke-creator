// 一期里每个说话人编号（A、B、C……）的声纹。speakers.mjs（和档案比、认出常驻主播）和 show.mjs --learn（记进档案）共用。
// 算一次约十几秒，存在 制作文件/说话人声纹.json，分说话人结果变了（或算法改了）自动重算。

import path from 'node:path';
import { loadSherpa, needPodcastModels, pmPath, threads, readJson, readJsonLoose, writeJson, fileSha, ensureWavs, longPathMsg, recParts } from '../lib/podcast.mjs';
import { voiceExtractor, embedSegments, cosine, VOICE } from '../lib/show.mjs';
import { speakerLabels, diarSource, MIN_SPEAKER_SECONDS } from './fulltext.mjs';

// v2：长段切块算声纹（2026-11-22）；v3：前后接着的短补录有了自己的编号（2026-11-24），编号集合会变，旧缓存作废重算
const stampOf = (e) => `v3:${fileSha(e.diar)}`;
// 已经算好的（不重算）：status 用来判断哪些编号有声纹；没有就是 null
export const cachedLabelEmbeddings = (e) => { const old = readJson(path.join(e.mid, '说话人声纹.json'), null); return old?.stamp === stampOf(e) ? old.labels : null; };

export function labelEmbeddings(e) {
  const cache = path.join(e.mid, '说话人声纹.json');
  const stamp = stampOf(e);
  const old = readJsonLoose(cache, null); // 缓存坏了就重算
  if (old?.stamp === stamp) return old.labels;
  needPodcastModels(['emb']);
  const lp = longPathMsg(e); // 节目目录太深：识别程序读不了 16k.wav，只会报一句英文
  if (lp) throw new Error(lp);
  ensureWavs(e); // 中间文件清理过：先重新转换录音（几十秒，识别、分说话人结果留着）
  const sherpa = loadSherpa();
  const ex = voiceExtractor(sherpa, pmPath('emb'), threads());
  const samples = sherpa.readWave(e.wav16, false).samples;
  const tracksSrc = diarSource(e).source === 'tracks';
  const { segs, label } = speakerLabels(readJson(e.diar), tracksSrc ? 3 : MIN_SPEAKER_SECONDS, tracksSrc ? null : recParts(e));
  const labels = {};
  for (const [k, lab] of Object.entries(label)) labels[lab] = embedSegments(ex, samples, segs.filter((s) => String(s.speaker) === k));
  writeJson(cache, { stamp, labels }, 0);
  return labels;
}

// 同一期里声音很像的两个编号：多半是机器把一个人拆成了两个
export function similarPairs(labels) {
  const ks = Object.keys(labels).filter((k) => labels[k]);
  const out = [];
  for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
    const s = cosine(labels[ks[i]].v, labels[ks[j]].v);
    if (s >= VOICE.same) out.push({ a: ks[i], b: ks[j], sim: +s.toFixed(2) });
  }
  return out.sort((x, y) => y.sim - x.sim);
}
