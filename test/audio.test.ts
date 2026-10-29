import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_SAMPLE_RATE, combine, correlate, envelope, ENV_RATE, findInside, peakDb, refineByAudio } from '../src/core/audioSync.ts';
import type { AudioAnchor, AudioPiece } from '../src/core/audioSync.ts';
import type { ClipMeta, Placement } from '../src/core/types.ts';
import { runSync } from '../src/core/sync.ts';
import { camera, clip, T16 } from './fixtures.ts';

const SR = AUDIO_SAMPLE_RATE;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Звук площадки: хлопки в случайные моменты. Одинаков для всех камер, у каждой свой шум и громкость.
const EVENTS: number[] = [];
{
  const r = rng(7);
  for (let t = T16 - 60; t < T16 + 3600; t += 0.4 + r() * 2) EVENTS.push(t);
}

function record(fromEpoch: number, dur: number, gain: number, noiseSeed: number, silent = false): Float32Array {
  const n = Math.round(dur * SR);
  const out = new Float32Array(n);
  if (silent) return out;
  const r = rng(noiseSeed);
  for (let i = 0; i < n; i++) out[i] = (r() * 2 - 1) * 0.02;
  for (const e of EVENTS) {
    if (e < fromEpoch - 0.1 || e > fromEpoch + dur) continue;
    const i0 = Math.round((e - fromEpoch) * SR);
    for (let k = 0; k < 400; k++) {
      const i = i0 + k;
      if (i >= 0 && i < n) out[i] += (r() * 2 - 1) * gain * Math.exp(-k / 70);
    }
  }
  return out;
}

test('Огибающая и корреляция находят сдвиг с точностью до 10 мс при разной громкости и шуме', () => {
  const ref = envelope(record(T16, 60, 0.9, 1), SR);
  const target = envelope(record(T16 + 20.37, 20, 0.3, 2), SR);
  // Ставим target так, будто он начинается на 1,5 с раньше настоящего.
  const refOffset = Math.round((20.37 - 1.5) * ENV_RATE);
  const m = correlate(target, ref, refOffset, 500)!;
  const correction = (refOffset + m.lag) / ENV_RATE - (20.37 - 1.5);
  assert.ok(Math.abs(correction - 1.5) < 0.012, `поправка ${correction}`);
  assert.ok(m.score > 0.5 && m.ratio > 2);
});

test('Поиск по всей записи находит кусок через много минут', () => {
  const ref = envelope(record(T16, 600, 0.8, 3), SR);
  const probe = envelope(record(T16 + 431.25, 20, 0.5, 4), SR);
  const m = findInside(probe, ref)!;
  assert.ok(Math.abs(m.offset / ENV_RATE - 431.25) < 0.015, `смещение ${m.offset / ENV_RATE}`);
  assert.ok(m.score > 0.5 && m.ratio > 2);
});

test('Тишина в звуке распознаётся по пику', () => {
  assert.ok(peakDb(record(T16, 5, 0, 1, true)) < -70);
  assert.ok(peakDb(record(T16, 5, 0.8, 1)) > -20);
});

const anchor = (clipId: string, at: number, correction: number, score = 0.8): AudioAnchor => ({
  cameraId: 'B', clipId, refCameraId: 'A', refClipId: 'r', at, correction, score, ratio: 4, accepted: true, role: 'weak',
});
const pl = (id: string, start: number): Placement => ({ clipId: id, cameraId: 'B', start, end: start + 10, method: 'timecode-and-clock', lane: 0 });

test('Логика по ходу съёмки: точка сверяет кадр и меняет поправку со своего клипа, предыдущие не трогает', () => {
  const placements = [pl('c1', 0), pl('c2', 100), pl('c3', 200), pl('c4', 300), pl('c5', 400)];
  const anchors = [anchor('c1', 5, 0.5), anchor('c2', 105, 0.52), anchor('c4', 305, 1.2), anchor('c5', 405, 1.21)];
  const r = combine('B', anchors, 'timecode-and-clock', placements, true, 180);
  assert.equal(r.result.model, 'per-anchor');
  assert.deepEqual(anchors.map((a) => a.role), ['start', 'confirm', 'shift', 'confirm']);
  assert.ok(Math.abs(r.corrections.c1 - 0.51) < 1e-9);
  assert.ok(Math.abs(r.corrections.c3 - 0.51) < 1e-9, 'клип до новой точки не тронут');
  assert.ok(Math.abs(r.corrections.c4 - 1.205) < 1e-9);
  assert.ok(Math.abs(r.corrections.c5 - 1.205) < 1e-9);
});

test('Одиночная ложная точка без подтверждения отбрасывается', () => {
  const placements = [pl('c1', 0), pl('c2', 100), pl('c3', 200)];
  const anchors = [anchor('c1', 5, 0.5), anchor('c2', 105, 3.0, 0.3), anchor('c3', 205, 0.5)];
  const r = combine('B', anchors, 'timecode-and-clock', placements, true, 180);
  assert.equal(anchors[1].role, 'ignored');
  assert.equal(r.result.model, 'single');
  assert.ok(Object.values(r.corrections).every((c) => Math.abs(c - 0.5) < 1e-9));
});

test('Камера только с часами: у клипа со своей точкой — своя поправка, остальным — поправка точки перед ними', () => {
  const placements = [pl('c1', 0), pl('c2', 100), pl('c3', 200)];
  const r = combine('B', [anchor('c1', 5, 3.3), anchor('c3', 205, 3.1)], 'clock', placements, true, 180);
  assert.equal(r.result.model, 'per-clip');
  assert.equal(r.corrections.c1, 3.3);
  assert.equal(r.corrections.c2, 3.3);
  assert.equal(r.corrections.c3, 3.1);
});

// Сквозная проверка: опорная камера с точным тайм-кодом и две камеры с ошибками часов.
function fakeFetch(truth: Map<string, number>, silentIds = new Set<string>()) {
  return async (c: ClipMeta, start: number, dur: number): Promise<AudioPiece | null> => {
    const real = truth.get(c.id)!;
    const samples = record(real + start, Math.min(dur, c.durationSec - start), 0.4 + (c.id.length % 3) * 0.2, c.id.length, silentIds.has(c.id));
    return { env: envelope(samples, SR), peakDb: peakDb(samples) };
  };
}

test('Сверка по звуку чинит часы камер и находит камеру со сбитым часовым поясом', async () => {
  const truth = new Map<string, number>();
  const mk = (realStart: number, dur: number, clockError: number, withTc: boolean, offsetTc = 0) => {
    const c = clip({ start: Math.floor(realStart + clockError), tcSeconds: withTc ? (((realStart + 3 * 3600 + offsetTc) % 86400) + 86400) % 86400 : undefined, durationSec: dur, recordedSec: dur });
    truth.set(c.id, realStart);
    return c;
  };
  const ref = camera('Опорная', [mk(T16, 300, 0.2, true), mk(T16 + 400, 300, 0.4, true)]);
  const gopro = camera('GoPro', [mk(T16 + 30, 60, -2.6, false), mk(T16 + 450, 60, -2.6, false)]);
  const zone = camera('Пояс', [mk(T16 + 100, 60, -7960, true, 5000), mk(T16 + 500, 60, -7960, true, 5000)]);
  const cams = [ref, gopro, zone];
  const coarse = runSync(cams);
  const audio = await refineByAudio(cams, coarse, fakeFetch(truth), { searchSec: 10, maxAnchors: 6, isEnabled: () => true });
  const final = runSync(cams, audio.corrections);
  for (const p of final.placements) {
    const err = p.start - truth.get(p.clipId)!;
    assert.ok(Math.abs(err) < 0.05, `${p.cameraId}: ошибка ${err.toFixed(3)} с`);
  }
  assert.equal(audio.cameras.find((c) => c.cameraId === 'Пояс')!.status, 'applied');
  assert.ok(audio.issues.some((i) => /часовой пояс/.test(i.details ?? '')));
});

test('Камера с тишиной в звуке: прямое предупреждение, раскладка не меняется', async () => {
  const truth = new Map<string, number>();
  const a = clip({ start: T16, tcSeconds: (T16 + 3 * 3600) % 86400, durationSec: 120, recordedSec: 120 });
  const b = clip({ start: T16 + 10, durationSec: 60, recordedSec: 60 });
  truth.set(a.id, T16);
  truth.set(b.id, T16 + 10.5);
  const cams = [camera('A', [a]), camera('B', [b])];
  const coarse = runSync(cams);
  const audio = await refineByAudio(cams, coarse, fakeFetch(truth, new Set([b.id])), { searchSec: 10, maxAnchors: 6, isEnabled: () => true });
  assert.equal(audio.cameras[1].status, 'silent');
  assert.equal(audio.corrections[b.id], undefined);
  assert.ok(audio.issues.some((i) => /тишина/.test(i.title)));
});
