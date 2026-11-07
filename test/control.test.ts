import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignByAudio } from '../src/core/align.ts';
import { runSync } from '../src/core/sync.ts';
import { camera, clip, T16 } from './fixtures.ts';
import { fakeAudio } from './sound.ts';

const tcOf = (epoch: number, offset = 0) => (((epoch + 3 * 3600 + offset) % 86400) + 86400) % 86400;
const opts = { searchSec: 30, maxAnchors: 8, isEnabled: () => true };

// Две камеры с тайм-кодом от своих часов (секунды мимо) и экраном синхронизации. Экран поставил B на 40 мс мимо:
// телефон показывает код с задержкой экрана. Звук у них общий.
function scene(qrError: number) {
  const truth = new Map<string, number>();
  const a = clip({ start: T16, tcSeconds: tcOf(T16, 2.3), durationSec: 300, recordedSec: 300 });
  const b = clip({ start: T16 + 31, tcSeconds: tcOf(T16 + 20, -1.7), durationSec: 240, recordedSec: 240 });
  truth.set(a.id, T16);
  truth.set(b.id, T16 + 20);
  const cams = [camera('A', [a]), camera('B', [b])];
  const coarse = runSync(cams);
  const at = (id: string) => coarse.placements.find((p) => p.clipId === id)!.start;
  // Поправки по экрану: A — точно, B — с ошибкой экрана.
  const pre = { [a.id]: T16 - at(a.id), [b.id]: T16 + 20 + qrError - at(b.id) };
  return { truth, cams, coarse, pre, a, b, fixed: new Set(['A', 'B']), controlClips: new Set([a.id, b.id]) };
}

test('Экран синхронизации ошибся на 40 мс — звук уточняет место камеры, общее время держит экран', async () => {
  const s = scene(0.04);
  const r = await alignByAudio(s.cams, s.coarse, fakeAudio(s.truth), { ...opts, pre: s.pre, fixed: s.fixed, controlClips: s.controlClips });
  const final = runSync(s.cams, r.corrections, s.fixed);
  const pa = final.placements.find((p) => p.clipId === s.a.id)!.start;
  const pb = final.placements.find((p) => p.clipId === s.b.id)!.start;
  // Взаимное место — по звуку, до миллисекунды.
  assert.ok(Math.abs(pb - pa - 20) < 0.002, `${((pb - pa - 20) * 1000).toFixed(1)} мс`);
  // Общее время — по экрану: середина двух камер не уехала дальше погрешности экрана.
  assert.ok(Math.abs((pa + pb) / 2 - (T16 + 10 + 0.02)) < 0.03, `${(((pa + pb) / 2 - T16 - 10) * 1000).toFixed(1)} мс`);
  assert.ok(r.issues.some((i) => /звук уточнил место по экрану/.test(i.title)), r.issues.map((i) => i.title).join('; '));
});

test('Экран и звук расходятся на полсекунды — камера встаёт по звуку, но с предупреждением', async () => {
  const s = scene(0.5);
  const r = await alignByAudio(s.cams, s.coarse, fakeAudio(s.truth), { ...opts, pre: s.pre, fixed: s.fixed, controlClips: s.controlClips });
  const final = runSync(s.cams, r.corrections, s.fixed);
  const pa = final.placements.find((p) => p.clipId === s.a.id)!.start;
  const pb = final.placements.find((p) => p.clipId === s.b.id)!.start;
  assert.ok(Math.abs(pb - pa - 20) < 0.002, `${((pb - pa - 20) * 1000).toFixed(1)} мс`);
  assert.ok(r.issues.some((i) => i.severity === 'warning' && /экран синхронизации и звук расходятся/.test(i.title)), r.issues.map((i) => i.title).join('; '));
});

test('Камера с экраном и выключенной сверкой по звуку стоит по экрану, звук её не двигает', async () => {
  const s = scene(0.04);
  const r = await alignByAudio(s.cams, s.coarse, fakeAudio(s.truth), { ...opts, isEnabled: (id: string) => id !== 'B', pre: s.pre, fixed: s.fixed, controlClips: s.controlClips });
  const final = runSync(s.cams, r.corrections, s.fixed);
  const pb = final.placements.find((p) => p.clipId === s.b.id)!.start;
  assert.ok(Math.abs(pb - (T16 + 20.04)) < 0.001, `${((pb - T16 - 20.04) * 1000).toFixed(1)} мс`);
});
