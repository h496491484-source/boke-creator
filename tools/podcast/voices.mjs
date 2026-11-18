// 一期里每个说话人编号（A、B、C……）的声纹。speakers.mjs（和档案比、认出常驻主播）和 show.mjs --learn（记进档案）共用。
// 算一次约十几秒，存在 制作文件/说话人声纹.json，分说话人结果变了自动重算。

import path from 'node:path';
import { loadSherpa, needPodcastModels, pmPath, threads, readJson, writeJson, fileSha } from '../lib/podcast.mjs';
import { voiceExtractor, embedSegments, cosine, VOICE } from '../lib/show.mjs';
import { speakerLabels, diarSource, MIN_SPEAKER_SECONDS } from './fulltext.mjs';

export function labelEmbeddings(e) {
  const cache = path.join(e.mid, '说话人声纹.json');
  const stamp = fileSha(e.diar);
  const old = readJson(cache, null);
  if (old?.stamp === stamp) return old.labels;
  needPodcastModels(['emb']);
  const sherpa = loadSherpa();
  const ex = voiceExtractor(sherpa, pmPath('emb'), threads());
  const samples = sherpa.readWave(e.wav16, false).samples;
  const { segs, label } = speakerLabels(readJson(e.diar), diarSource(e).source === 'tracks' ? 3 : MIN_SPEAKER_SECONDS);
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
