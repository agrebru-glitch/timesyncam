import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agreeingClocks, alignByAudio } from '../src/core/align.ts';
import { runSync } from '../src/core/sync.ts';
import type { ClipMeta } from '../src/core/types.ts';
import { camera, clip, T16 } from './fixtures.ts';
import { record, rng } from './sound.ts';
import type { Burst } from './sound.ts';
import { peakDb, SILENCE_DB } from '../src/core/audioSync.ts';
import type { AudioFetch } from '../src/core/audioSync.ts';
import { FEAT_SR, FINE_SR, pickChannel } from '../src/core/audioFeatures.ts';

const opts = { searchSec: 30, maxAnchors: 8, isEnabled: () => true };

// Матч: длинная трансляция и короткая камера (70 с) далеко от поля — зал она слышит тихо, поверх — свой громкий шум
// (люди рядом). Её часы ушли на 8,5 минуты. Окон по 20 с в её записи всего два-три, и каждое по отдельности не ясное.
function scene(sharedGain: number, ownSound = true) {
  const burstsFrom = (seed: number, gap: [number, number], amp: [number, number]): Burst[] => {
    const r = rng(seed);
    const out: Burst[] = [];
    for (let t = T16 - 700; t < T16 + 1500; t += gap[0] + r() * (gap[1] - gap[0])) {
      out.push({ t, amp: amp[0] + r() * (amp[1] - amp[0]), freqs: Array.from({ length: 6 }, () => 300 + r() * 5500), phases: Array.from({ length: 6 }, () => r() * Math.PI * 2) });
    }
    return out;
  };
  const stadium = burstsFrom(51, [0.3, 1.6], [0.3, 0.9]);
  const crowd = burstsFrom(53, [0.1, 0.4], [0.6, 1.2]);
  const other = burstsFrom(57, [0.3, 1.6], [0.3, 0.9]); // звук совсем другого места — для контроля
  const bc = clip({ start: T16, durationSec: 1200, recordedSec: 1200 });
  const cam = clip({ start: Math.floor(T16 + 300 - 514), durationSec: 70, recordedSec: 70 });
  const truth = new Map([[bc.id, T16], [cam.id, T16 + 300.37]]);
  const gen = (c: ClipMeta, start: number, dur: number, sr: number) => {
    const len = Math.min(dur, c.durationSec - start);
    const from = truth.get(c.id)! + start;
    if (c === bc) return record(from, len, sr, 0.8, 3 + Math.round(start), { bursts: stadium });
    const a = record(from, len, sr, sharedGain, 11, { bursts: ownSound ? stadium : other, noise: 0 });
    const b = record(from, len, sr, 0.9, 13 + Math.round(start), { bursts: crowd });
    return a.map((v, i) => v + b[i]);
  };
  const audio: AudioFetch = {
    features: async (c, start, dur) => {
      const s = gen(c, start, dur, FEAT_SR);
      const picked = pickChannel([s, s], FEAT_SR, peakDb, SILENCE_DB);
      return { feat: picked.feat, peakDb: picked.peakDb, channel: picked.channel };
    },
    samples: async (c, start, dur) => gen(c, start, dur, FINE_SR),
  };
  return { cams: [camera('Трансляция', [bc]), camera('Камера', [cam])], truth, audio, bc, cam };
}

test('Короткая запись со слабым общим звуком и часами на 8,5 минуты мимо находится голосованием коротких окон', async () => {
  const s = scene(0.22);
  const r = await alignByAudio(s.cams, runSync(s.cams), s.audio, opts);
  const final = runSync(s.cams, r.corrections);
  const at = (id: string) => final.placements.find((p) => p.clipId === id)!.start;
  const err = at(s.cam.id) - at(s.bc.id) - 300.37;
  assert.ok(Math.abs(err) < 0.03, `ошибка ${(err * 1000).toFixed(0)} мс; ${(r.log ?? []).filter((l) => /поле|итог/.test(l)).join(' | ')}`);
  // Нашлась именно голосованием коротких окон: окна по 20 с её не подтвердили.
  assert.ok((r.log ?? []).some((l) => /короткие окна:/.test(l)), (r.log ?? []).filter((l) => /итог/.test(l)).join(' | '));
});

test('Короткая запись без общего звука голосованием коротких окон не «находится»', async () => {
  const s = scene(0.22, false);
  const r = await alignByAudio(s.cams, runSync(s.cams), s.audio, opts);
  assert.ok(!(r.log ?? []).some((l) => /короткие окна:/.test(l)), (r.log ?? []).filter((l) => /поле|итог/.test(l)).join(' | '));
  assert.equal(r.unsure?.[s.cam.id], 'not-found');
});

test('Время суток: камера с часами на 6–9 минут мимо не перетягивает середину близких часов', () => {
  // Как на матче: Sony 0, DJI ~120 с (два куска), трансляция 137 с, A6700 −394 с. Компания в пределах 5 минут — без A6700.
  const v = agreeingClocks([
    { device: 'Sony', v: 0, weak: false },
    { device: 'DJI', v: 119.94, weak: false },
    { device: 'DJI', v: 120.66, weak: false },
    { device: 'Трансляция', v: 136.62, weak: false },
    { device: 'A6700', v: -393.81, weak: false },
  ]);
  assert.ok(Math.abs(v - 120) < 1, `${v}`);
});
