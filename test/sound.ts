// Синтетический звук площадки для тестов сверки по звуку.
import type { AudioFetch } from '../src/core/audioSync.ts';
import { peakDb, SILENCE_DB } from '../src/core/audioSync.ts';
import { FEAT_SR, FINE_SR, pickChannel } from '../src/core/audioFeatures.ts';
import type { ClipMeta } from '../src/core/types.ts';
import { T16 } from './fixtures.ts';

function mix(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Звук площадки задан как функция непрерывного времени: хлопки из нескольких синусоид с затуханием.
// Так можно проверять сдвиги, не кратные сэмплу.
export interface Burst { t: number; amp: number; freqs: number[]; phases: number[] }
export const BURSTS: Burst[] = [];
{
  const r = rng(7);
  for (let t = T16 - 60; t < T16 + 3600; t += 0.4 + r() * 2) {
    BURSTS.push({ t, amp: 0.3 + r() * 0.6, freqs: Array.from({ length: 6 }, () => 300 + r() * 5500), phases: Array.from({ length: 6 }, () => r() * Math.PI * 2) });
  }
}

// rate — ход часов устройства: 1 + 40e-6 значит, что его секунда на 40 мкс длиннее настоящей (кварц отстаёт).
// muteUntil — до этого момента (настоящее время) устройство писало только шум.
// echo — отражение в зале: каждый звук приходит ещё раз через delay секунд с громкостью gain от прямого.
export function record(fromEpoch: number, dur: number, sr: number, gain: number, noiseSeed: number, opts: { silent?: boolean; noise?: number; bursts?: Burst[]; rate?: number; muteUntil?: number; echo?: { delay: number; gain: number } } = {}): Float32Array {
  const n = Math.round(dur * sr);
  const out = new Float32Array(n);
  if (opts.silent) return out;
  // Шум — хеш номера сэмпла и зерна. Простой генератор не годится: шум двух клипов может оказаться одной
  // и той же последовательностью со сдвигом, и сверка честно найдёт по нему ложное совпадение.
  const noise = opts.noise ?? 0.02;
  for (let i = 0; i < n; i++) out[i] = ((mix(noiseSeed ^ Math.imul(i + 1, 0x9e3779b1)) / 4294967296) * 2 - 1) * noise;
  const rate = opts.rate ?? 1;
  const echo = opts.echo;
  const bursts = (opts.bursts ?? BURSTS).flatMap((b) => (echo ? [b, { ...b, t: b.t + echo.delay, amp: b.amp * echo.gain }] : [b]));
  for (const b of bursts) {
    if (b.t < fromEpoch - 0.2 || b.t > fromEpoch + dur * rate || b.t < (opts.muteUntil ?? -Infinity)) continue;
    const i0 = Math.max(0, Math.floor(((b.t - fromEpoch) / rate) * sr));
    const i1 = Math.min(n, Math.ceil(((b.t + 0.12 - fromEpoch) / rate) * sr));
    for (let i = i0; i < i1; i++) {
      const tt = fromEpoch + (i / sr) * rate - b.t;
      if (tt < 0) continue;
      let v = 0;
      for (let k = 0; k < 6; k++) v += Math.sin(2 * Math.PI * b.freqs[k] * tt + b.phases[k]);
      out[i] += (v / 6) * b.amp * gain * Math.exp(-tt / 0.015);
    }
  }
  return out;
}

export function fakeAudio(truth: Map<string, number>, silentIds = new Set<string>(), bursts: Burst[] = BURSTS, rates = new Map<string, number>(), mutes = new Map<string, number>(), echoes = new Map<string, { delay: number; gain: number }>()): AudioFetch {
  // У каждой камеры свой шум и своя громкость, как у настоящих микрофонов.
  const hash = (s: string) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
  const gain = (c: ClipMeta) => 0.4 + (hash(c.id) % 3) * 0.2;
  const seed = (c: ClipMeta, start: number, salt: number) => (hash(c.id) * 7919 + Math.round(start * 1000) + salt) >>> 0;
  return {
    features: async (c, start, dur) => {
      const len = Math.min(dur, c.durationSec - start);
      const s = record(truth.get(c.id)! + start * (rates.get(c.id) ?? 1), len, FEAT_SR, gain(c), seed(c, start, 1), { silent: silentIds.has(c.id), bursts, rate: rates.get(c.id), muteUntil: mutes.get(c.id), echo: echoes.get(c.id) });
      const picked = pickChannel([s, s], FEAT_SR, peakDb, SILENCE_DB);
      return { feat: picked.feat, peakDb: picked.peakDb, channel: picked.channel };
    },
    samples: async (c, start, dur) => record(truth.get(c.id)! + start * (rates.get(c.id) ?? 1), Math.min(dur, c.durationSec - start), FINE_SR, gain(c), seed(c, start, 2), { bursts, rate: rates.get(c.id), echo: echoes.get(c.id) }),
  };
}
