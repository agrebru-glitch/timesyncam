// Выровненные копии звука — в отдельном потоке: растяжение длинной записи занимает десятки секунд,
// окно программы в это время не должно замирать.
import { parentPort, workerData } from 'node:worker_threads';
import { mkdir } from 'node:fs/promises';
import type { DriftJob } from '../core/driftExport.ts';
import { renderDriftCopies } from './drift.ts';
import { useToolPaths } from './ffmpeg.ts';

useToolPaths(workerData.tools);

parentPort!.on('message', async ({ outDir, jobs }: { outDir: string; jobs: DriftJob[] }) => {
  try {
    await mkdir(outDir, { recursive: true });
    const results = await renderDriftCopies(jobs, outDir, (done) => parentPort!.postMessage({ type: 'progress', done, total: jobs.length }));
    parentPort!.postMessage({ type: 'done', results });
  } catch (e) {
    parentPort!.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
});
