import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignByAudio } from '../src/core/align.ts';
import { runSync } from '../src/core/sync.ts';
import { unsureDetails, unsureOf } from '../src/core/unsure.ts';
import { camera, clip, T16 } from './fixtures.ts';
import { fakeAudio } from './sound.ts';

const tcOf = (epoch: number, offset = 0) => (((epoch + 3 * 3600 + offset) % 86400) + 86400) % 86400;
const opts = { searchSec: 30, maxAnchors: 8, isEnabled: () => true };
const audioClip = (start: number, dur: number) => clip({ start, durationSec: dur, recordedSec: dur, hasVideo: false, rate: null, width: null, height: null });

test('Неточные клипы: без общего звука — «по соседям», найденные по звуку не помечены', async () => {
  const truth = new Map<string, number>();
  const cam = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 900, recordedSec: 900 });
  truth.set(cam.id, T16);
  const lav = [0, 1, 2].map((k) => {
    const c = audioClip(T16 + 20 + 3 + k * 300, 300);
    Object.assign(c, { clock: { ...c.clock!, source: 'filename' } });
    truth.set(c.id, T16 + 20 + k * 300);
    return c;
  });
  const cams = [camera('Камера', [cam]), camera('Петличка', lav)];
  const result = await alignByAudio(cams, runSync(cams), fakeAudio(truth, new Set([lav[1].id])), opts);
  assert.deepEqual(result.unsure, { [lav[1].id]: 'neighbours' });
  const s = unsureOf(cams[1], result);
  assert.deepEqual(s.ids, [lav[1].id]);
  assert.match(unsureDetails(s), /1 клип: нет общего звука/);
  // Убранный с таймлинии клип не считается.
  assert.deepEqual(unsureOf({ ...cams[1], excludedClipIds: [lav[1].id] }, result).ids, []);
  assert.deepEqual(unsureOf(cams[0], result).ids, []);
});

test('Неточные клипы: камера с тишиной в звуке — «нет звука», единственную камеру со звуком не помечаем', async () => {
  const truth = new Map<string, number>();
  const a = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 120, recordedSec: 120 });
  const b = clip({ start: T16 + 10, durationSec: 60, recordedSec: 60 });
  truth.set(a.id, T16);
  truth.set(b.id, T16 + 10.4);
  const cams = [camera('A', [a]), camera('B', [b])];
  const result = await alignByAudio(cams, runSync(cams), fakeAudio(truth, new Set([b.id])), opts);
  assert.deepEqual(result.unsure, { [b.id]: 'no-sound' });
});

test('Неточные клипы: камера без общего звука — «не нашлась», камеры, связанные звуком, чистые', async () => {
  const truth = new Map<string, number>();
  const a = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 300, recordedSec: 300 });
  const b = clip({ start: T16 + 20, durationSec: 200, recordedSec: 200 });
  const c = clip({ start: T16 + 40, durationSec: 120, recordedSec: 120 });
  truth.set(a.id, T16);
  truth.set(b.id, T16 + 20.3);
  // C писала звук совсем другого времени — общего звука с остальными у неё нет.
  truth.set(c.id, T16 + 2000);
  const cams = [camera('A', [a]), camera('B', [b]), camera('C', [c])];
  const result = await alignByAudio(cams, runSync(cams), fakeAudio(truth), opts);
  assert.equal(result.unsure?.[a.id], undefined);
  assert.equal(result.unsure?.[b.id], undefined);
  assert.equal(result.unsure?.[c.id], 'not-found');
});

test('Неточные клипы: камера, которой сверка по звуку отключена, не помечается', async () => {
  const truth = new Map<string, number>();
  const a = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 300, recordedSec: 300 });
  const b = clip({ start: T16 + 20, durationSec: 200, recordedSec: 200 });
  truth.set(a.id, T16);
  truth.set(b.id, T16 + 20.3);
  const cams = [camera('A', [a]), camera('B', [b])];
  const result = await alignByAudio(cams, runSync(cams), fakeAudio(truth), { ...opts, isEnabled: (id: string) => id !== 'B' });
  assert.deepEqual(result.unsure, {});
});

test('Дорожки одного дубля рекордера стоят с одним началом, хотя микрофоны слышат зал с разной задержкой', async () => {
  const truth = new Map<string, number>();
  const cam = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 300, recordedSec: 300 });
  truth.set(cam.id, T16);
  const take = (name: string, delay: number) => {
    const c = audioClip(T16 + 20, 200);
    Object.assign(c, { name, audioChannels: 1, tc: { text: '12:00:00:00', seconds: 43200, countRate: 25, drop: false, source: 'bwf' } });
    // Второй микрофон дальше от зала: звук приходит к нему позже — по звуку дорожка «встала бы» позже.
    truth.set(c.id, T16 + 20 - delay);
    return c;
  };
  const tr1 = take('ZOOM0001_Tr1.WAV', 0);
  const tr2 = take('ZOOM0001_Tr2.WAV', 0.003);
  const cams = [camera('Камера', [cam]), camera('Zoom', [tr1, tr2])];
  const result = await alignByAudio(cams, runSync(cams), fakeAudio(truth), opts);
  const final = runSync(cams, result.corrections);
  const s1 = final.placements.find((p) => p.clipId === tr1.id)!.start;
  const s2 = final.placements.find((p) => p.clipId === tr2.id)!.start;
  assert.ok(Math.abs(s1 - s2) < 0.0006, `${((s2 - s1) * 1000).toFixed(2)} мс`);
});
