import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyStart, driftJobs, withDriftCopies } from '../src/core/driftExport.ts';
import { stretch } from '../src/core/resample.ts';
import { renderDriftCopy } from '../src/main/drift.ts';
import { probe, runTool } from '../src/main/ffmpeg.ts';
import type { AudioSyncResult } from '../src/core/audioSync.ts';
import type { SyncResult } from '../src/core/types.ts';
import { camera, clip, T16 } from './fixtures.ts';

const SR = 48000;

test('Задания выравнивания: только звук устройств с надёжным ходом часов, начало копии — от места по середине', () => {
  const a = clip({ start: T16, durationSec: 1000, recordedSec: 1000 });
  const r = clip({ start: T16 + 100, durationSec: 600, recordedSec: 600, hasVideo: false, rate: null, width: null, height: null });
  const cams = [camera('A', [a]), camera('Рекордер', [r])];
  const sync = {
    placements: [
      { clipId: a.id, cameraId: 'A', start: T16, end: T16 + 1000, method: 'clock', lane: 0 },
      { clipId: r.id, cameraId: 'Рекордер', start: T16 + 100, end: T16 + 700, method: 'clock', lane: 0 },
    ],
    cameras: [], issues: [], start: T16, end: T16 + 1000, displayTzOffsetMin: 180,
  } as unknown as SyncResult;
  const audio = { cameras: [], corrections: {}, issues: [], drift: [{ cameraId: 'Рекордер', ppm: 100, sigmaPpm: 1, points: 40, longestSec: 600, edgeErrorSec: 0.03, apply: true }] } as AudioSyncResult;
  const jobs = driftJobs(cams, sync, audio);
  assert.equal(jobs.length, 1);
  const j = jobs[0];
  assert.equal(j.ratio, 1 + 100e-6);
  assert.match(j.outName, /_drift\+0\.060s\.wav$/);
  // Копия на 60 мс длиннее; запись стояла по середине — копия начинается на 30 мс раньше.
  // Время на таймлинии — секунды от 1970 года: точность сравнения — микросекунда.
  assert.ok(Math.abs(copyStart(sync.placements[1], r, j.ratio) - (T16 + 100 - 0.03)) < 1e-6);
  assert.equal(j.checks.length, 5);
  for (const c of j.checks) assert.ok(Math.abs(c.refAt - (100 - 0.03 + c.at)) < 1e-6 && c.refPath === a.path);
  const mod = withDriftCopies(cams, sync, jobs, [{ clipId: r.id, ok: true, outPath: 'D:/out/R_drift.wav', durationSec: 600.06, checked: 3, residualMs: 0.2 }]);
  const p = mod.sync.placements.find((x) => x.clipId === r.id)!;
  const k = mod.cameras[1].clips[0];
  assert.ok(Math.abs(p.start - (T16 + 99.97)) < 1e-6 && Math.abs(p.end - p.start - 600.06) < 1e-6);
  assert.equal(k.path, 'D:/out/R_drift.wav');
  assert.equal(k.name, 'R_drift.wav');
  // Без надёжного хода часов — ничего не выравнивается.
  assert.equal(driftJobs(cams, sync, { ...audio, drift: [{ ...audio.drift![0], apply: false }] }).length, 0);
});

// WAV через ffmpeg: из сырых отсчётов, с BWF-временем начала, как пишет рекордер.
async function wav(dir: string, name: string, samples: Float32Array, bwf = false): Promise<string> {
  const raw = join(dir, `${name}.f32`);
  await writeFile(raw, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  const out = join(dir, name);
  const meta = bwf ? ['-write_bext', '1', '-metadata', 'time_reference=3105216000', '-metadata', 'origination_date=2026-09-18', '-metadata', 'origination_time=17:58:12'] : [];
  const r = await runTool('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', raw, '-c:a', 'pcm_s24le', ...meta, out], 60000);
  assert.equal(r.code, 0, r.stderr);
  return out;
}

function program(sec: number): Float32Array {
  const x = new Float32Array(sec * SR);
  let s = 7;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < x.length; i++) x[i] = 0.01 * (rnd() * 2 - 1);
  for (let t = 0.2; t < sec; t += 0.25 + rnd() * 0.3) {
    const i0 = Math.round(t * SR);
    for (let k = 0; k < 2400 && i0 + k < x.length; k++) x[i0 + k] += 0.5 * Math.exp(-k / 300) * (rnd() * 2 - 1);
  }
  return x;
}

test('Выровненная копия совпадает с камерой по всей длине, время начала BWF сохраняется; неверная — удаляется', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tsc-drift-'));
  try {
    const sec = 90;
    const ref = program(sec);
    // Рекордер с часами, отстающими на 150 миллионных: его запись короче настоящего времени.
    const ppm = 150;
    const rec = stretch(ref, 1, 1 / (1 + ppm * 1e-6));
    const refPath = await wav(dir, 'cam.wav', ref);
    const recPath = await wav(dir, 'ZOOM0003.WAV', rec, true);
    const checks = [9, 27, 45, 63, 81].map((at) => ({ refPath, refChannel: 0, at, refAt: at }));
    const out = join(dir, 'out');
    await mkdir(out);
    const good = await renderDriftCopy({ clipId: 'z', path: recPath, ratio: 1 + ppm * 1e-6, ppm, outName: 'ZOOM0003_drift+0.013s.wav', checks }, out, () => {});
    assert.ok(good.ok, good.reason ?? '');
    assert.ok(good.checked >= 4, `${good.checked}`);
    assert.ok(good.residualMs! < 1, `${good.residualMs} мс`);
    assert.ok(Math.abs(good.durationSec! - sec) < 0.001, `${good.durationSec}`);
    const info = await probe(good.outPath!);
    assert.equal(info?.format?.tags?.time_reference, '3105216000');
    assert.equal(info?.format?.tags?.date, '2026-09-18');
    // Ход часов оценён вдвое неверно — копия не проходит проверку, на диске от неё ничего не остаётся.
    const bad = await renderDriftCopy({ clipId: 'z', path: recPath, ratio: 1 + 3 * ppm * 1e-6, ppm: 3 * ppm, outName: 'bad.wav', checks }, out, () => {});
    assert.ok(!bad.ok && /расходится|не удалось проверить/.test(bad.reason ?? ''), JSON.stringify(bad));
    assert.ok(!existsSync(join(out, 'bad.wav')));
    assert.deepEqual((await readdir(out)).filter((f) => f.startsWith('bad')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
