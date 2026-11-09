import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignByAudio } from '../src/core/align.ts';
import { runSync } from '../src/core/sync.ts';
import type { ClipMeta } from '../src/core/types.ts';
import { camera, clip, T16 } from './fixtures.ts';
import { record, rng } from './sound.ts';
import type { Burst } from './sound.ts';
import { peakDb, SILENCE_DB } from '../src/core/audioSync.ts';
import type { AudioFetch } from '../src/core/audioSync.ts';
import { FEAT_SR, FINE_SR, pickChannel } from '../src/core/audioFeatures.ts';

const opts = { searchSec: 30, maxAnchors: 8, isEnabled: () => true };

// Лекция: зал и сурдопереводчик в другой комнате. Общего звука почти нет — только заставка, которая звучит в обеих
// комнатах, и звучит дважды, с разницей в час. Последний клип переводчика слышит вторую заставку, и короткие окна
// находят её и в первом клипе зала — на час раньше. Часы камер верные: такая связь уводит клип зала на час от
// остальных его клипов, поверх них, — её надо отбросить.
function scene() {
  const bursts = (seed: number, from: number, to: number, gap: [number, number], amp: [number, number]): Burst[] => {
    const r = rng(seed);
    const out: Burst[] = [];
    for (let t = from; t < to; t += gap[0] + r() * (gap[1] - gap[0])) {
      out.push({ t, amp: amp[0] + r() * (amp[1] - amp[0]), freqs: Array.from({ length: 6 }, () => 300 + r() * 5500), phases: Array.from({ length: 6 }, () => r() * Math.PI * 2) });
    }
    return out;
  };
  const hall = bursts(61, T16 - 100, T16 + 5000, [0.3, 1.4], [0.3, 0.9]);
  const room = bursts(67, T16 - 100, T16 + 4000, [0.3, 1.4], [0.3, 0.9]);
  const jingle = bursts(71, T16 + 60, T16 + 90, [0.08, 0.25], [0.7, 1.0]);
  const jingles = [...jingle, ...jingle.map((b) => ({ ...b, t: b.t + 3600 }))];
  // Клипы переводчика длиннее и перекрывают по два клипа зала — так все они связаны в одну группу.
  const at = (t: number, d: number) => clip({ start: T16 + t, durationSec: d, recordedSec: d });
  // Последний клип зала снят, когда переводчик уже не писал: сверять его не с чем.
  const A = [at(0, 200), at(300, 200), at(600, 200), at(3600, 120), at(4500, 120)];
  const B = [at(0, 400), at(410, 330), at(745, 100), at(3640, 60)];
  const truth = new Map<string, number>([...A, ...B].map((c) => [c.id, c.clock!.epochSec]));
  const inHall = new Set(A.map((c) => c.id));
  const gen = (c: ClipMeta, start: number, dur: number, sr: number) => {
    const len = Math.min(dur, c.durationSec - start);
    const from = truth.get(c.id)! + start;
    const own = record(from, len, sr, 0.8, 3 + Math.round(start) + (inHall.has(c.id) ? 0 : 500), { bursts: inHall.has(c.id) ? hall : room });
    const pa = record(from, len, sr, 0.9, 7, { bursts: jingles, noise: 0 });
    // Переводчик слышит зал тихо, через дверь: этого хватает, чтобы его клипы встали рядом с клипами зала.
    const door = inHall.has(c.id) ? null : record(from, len, sr, 0.35, 9, { bursts: hall, noise: 0 });
    return own.map((v, i) => v + pa[i] + (door ? door[i] : 0));
  };
  const audio: AudioFetch = {
    features: async (c, start, dur) => {
      const s = gen(c, start, dur, FEAT_SR);
      const picked = pickChannel([s, s], FEAT_SR, peakDb, SILENCE_DB);
      return { feat: picked.feat, peakDb: picked.peakDb, channel: picked.channel };
    },
    samples: async (c, start, dur) => gen(c, start, dur, FINE_SR),
  };
  return { cams: [camera('Зал', A), camera('Сурдо', B)], A, B, audio };
}

test('Повтор звука через час: связь, уводящая клип от остальных клипов его камеры против её часов, отбрасывается', async () => {
  const s = scene();
  const r = await alignByAudio(s.cams, runSync(s.cams), s.audio, opts);
  const final = runSync(s.cams, r.corrections);
  const at = (c: ClipMeta) => final.placements.find((p) => p.clipId === c.id)!.start;
  const trace = (r.log ?? []).filter((l) => /итог: -?\d|против часов|группы/.test(l)).join('\n');
  // Клипы зала на своих местах относительно друг друга — по часам камеры, без наложений.
  for (let i = 1; i < s.A.length; i++) {
    const want = s.A[i].clock!.epochSec - s.A[0].clock!.epochSec;
    assert.ok(Math.abs(at(s.A[i]) - at(s.A[0]) - want) < 2, `клип ${i}: ${(at(s.A[i]) - at(s.A[0])).toFixed(2)} вместо ${want}\n${trace}`);
  }
  assert.ok(Math.abs(at(s.B[3]) - at(s.A[3]) - 40) < 2, `последний клип переводчика: ${(at(s.B[3]) - at(s.A[3])).toFixed(2)} вместо 40\n${trace}`);
  // Клип, рядом с которым никто не писал, — «не с чем сверить», а не «без сверки».
  assert.deepEqual(r.alone, [s.A[4].id]);
  assert.equal(r.unsure?.[s.A[4].id], undefined);
});
