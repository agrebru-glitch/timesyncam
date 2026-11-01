// Сверка по звуку — в отдельном потоке, чтобы окно программы не замирало, пока она считает.
// Поток сам читает звук через ffmpeg и держит прочитанное в памяти до закрытия программы:
// повторная синхронизация не читает файлы заново. Остановить сверку — значит завершить поток.
import { parentPort, workerData } from 'node:worker_threads';
import { alignByAudio } from '../core/align.ts';
import type { AudioJob } from '../core/audioSync.ts';
import { audioFeatures, audioSamples, audioWholeFeatures } from './audio.ts';
import { useToolPaths } from './ffmpeg.ts';

useToolPaths(workerData.tools);

parentPort!.on('message', async (job: AudioJob) => {
  try {
    const enabled = new Set(job.enabled);
    // Сверка всех дорожек со всеми: каждая пара — по всей длине записи, с проверкой по всей общей части.
    const result = await alignByAudio(job.cameras, job.coarse, {
      features: (clip, start, dur) => audioFeatures(clip.path, start, dur),
      samples: (clip, start, dur, ch) => audioSamples(clip.path, start, dur, ch),
      whole: (clip) => audioWholeFeatures(clip.path, clip.durationSec),
    }, {
      searchSec: job.searchSec,
      maxAnchors: job.maxAnchors,
      isEnabled: (id) => enabled.has(id),
      followers: new Set(job.followers),
      pre: job.pre,
      fixed: new Set(job.fixed),
      controlClips: new Set(job.controlClips),
      onProgress: (done, total) => parentPort!.postMessage({ type: 'progress', done, total }),
    });
    parentPort!.postMessage({ type: 'done', result });
  } catch (e) {
    parentPort!.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
});
