import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combine, correlate, ENV_RATE, findInside, peakDb, refineByAudio, SILENCE_DB, waveformPeaks } from '../src/core/audioSync.ts';
import type { AudioAnchor, AudioFetch } from '../src/core/audioSync.ts';
import { bandFeatures, FEAT_SR, FINE_SR, gccPhat, pickChannel } from '../src/core/audioFeatures.ts';
import type { ClipMeta, Placement } from '../src/core/types.ts';
import { runSync } from '../src/core/sync.ts';
import { camera, clip, T16 } from './fixtures.ts';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Звук площадки задан как функция непрерывного времени: хлопки из нескольких синусоид с затуханием.
// Так можно проверять сдвиги, не кратные сэмплу.
interface Burst { t: number; amp: number; freqs: number[]; phases: number[] }
const BURSTS: Burst[] = [];
{
  const r = rng(7);
  for (let t = T16 - 60; t < T16 + 3600; t += 0.4 + r() * 2) {
    BURSTS.push({ t, amp: 0.3 + r() * 0.6, freqs: Array.from({ length: 6 }, () => 300 + r() * 5500), phases: Array.from({ length: 6 }, () => r() * Math.PI * 2) });
  }
}

function record(fromEpoch: number, dur: number, sr: number, gain: number, noiseSeed: number, opts: { silent?: boolean; noise?: number } = {}): Float32Array {
  const n = Math.round(dur * sr);
  const out = new Float32Array(n);
  if (opts.silent) return out;
  const r = rng(noiseSeed);
  const noise = opts.noise ?? 0.02;
  for (let i = 0; i < n; i++) out[i] = (r() * 2 - 1) * noise;
  for (const b of BURSTS) {
    if (b.t < fromEpoch - 0.2 || b.t > fromEpoch + dur) continue;
    const i0 = Math.max(0, Math.floor((b.t - fromEpoch) * sr));
    const i1 = Math.min(n, Math.ceil((b.t + 0.12 - fromEpoch) * sr));
    for (let i = i0; i < i1; i++) {
      const tt = fromEpoch + i / sr - b.t;
      if (tt < 0) continue;
      let v = 0;
      for (let k = 0; k < 6; k++) v += Math.sin(2 * Math.PI * b.freqs[k] * tt + b.phases[k]);
      out[i] += (v / 6) * b.amp * gain * Math.exp(-tt / 0.015);
    }
  }
  return out;
}

const feat = (fromEpoch: number, dur: number, gain: number, seed: number) => bandFeatures(record(fromEpoch, dur, FEAT_SR, gain, seed), FEAT_SR).feat;

test('Многополосный отпечаток находит сдвиг с точностью до 10 мс при разной громкости и шуме', () => {
  const ref = feat(T16, 60, 0.9, 1);
  const target = feat(T16 + 20.37, 20, 0.3, 2);
  const refOffset = Math.round((20.37 - 1.5) * ENV_RATE);
  const m = correlate(target, ref, refOffset, 500)!;
  const correction = (refOffset + m.lag) / ENV_RATE - (20.37 - 1.5);
  assert.ok(Math.abs(correction - 1.5) < 0.012, `поправка ${correction}`);
  assert.ok(m.score > 0.3 && m.ratio > 5, `совпадение ${m.score}, отрыв ${m.ratio}`);
});

test('Отпечаток выдерживает громкий ровный шум трибун', () => {
  const ref = bandFeatures(record(T16, 60, FEAT_SR, 0.9, 1, { noise: 0.1 }), FEAT_SR).feat;
  const target = bandFeatures(record(T16 + 20.37, 20, FEAT_SR, 0.5, 2, { noise: 0.1 }), FEAT_SR).feat;
  const refOffset = Math.round(20.37 * ENV_RATE);
  const m = correlate(target, ref, refOffset, 500)!;
  assert.ok(Math.abs(m.lag) / ENV_RATE < 0.012, `сдвиг ${m.lag / ENV_RATE}`);
  assert.ok(m.ratio > 2, `отрыв ${m.ratio}`);
});

test('Точная сверка GCC-PHAT находит задержку в доли миллисекунды', () => {
  for (const delay of [0.0012345, -0.0087, 0.0193]) {
    const start = T16 + 100;
    const x = record(start, 4, FINE_SR, 0.4, 3);
    // Опорный кусок начинается на 30 мс раньше, а звук в нём пришёл позже на delay.
    const y = record(start - 0.03 - delay, 4.06, FINE_SR, 0.9, 4);
    const off = Math.round(0.03 * FINE_SR);
    const g = gccPhat(x, y, FINE_SR, off, off)!;
    assert.ok(Math.abs(g.lag / FINE_SR - delay) < 0.00005, `задержка ${delay}: найдено ${g.lag / FINE_SR}`);
    assert.ok(g.confidence > 6);
  }
});

test('Канал с внешним микрофоном выбирается сам, мёртвый канал не мешает', () => {
  const clean = record(T16, 20, FEAT_SR, 0.8, 5, { noise: 0.005 });
  const noisy = record(T16, 20, FEAT_SR, 0.15, 6, { noise: 0.2 });
  assert.equal(pickChannel([noisy, clean], FEAT_SR, peakDb, SILENCE_DB).channel, 1);
  assert.equal(pickChannel([new Float32Array(clean.length), clean], FEAT_SR, peakDb, SILENCE_DB).channel, 1);
});

test('Поиск по всей записи находит кусок через много минут', () => {
  const ref = feat(T16, 600, 0.8, 3);
  const probe = feat(T16 + 431.25, 20, 0.5, 4);
  const m = findInside(probe, ref)!;
  assert.ok(Math.abs(m.offset / ENV_RATE - 431.25) < 0.015, `смещение ${m.offset / ENV_RATE}`);
  assert.ok(m.score > 0.3 && m.ratio > 4);
});

test('Волна для таймлинии: 100 точек в секунду, тихий и громкий звук видны оба', () => {
  const quiet = waveformPeaks(record(T16, 2, 8000, 0.06, 5), 8000);
  const loud = waveformPeaks(record(T16, 2, 8000, 0.9, 6), 8000);
  assert.equal(quiet.length, 200);
  const max = (a: Uint8Array) => a.reduce((m, v) => Math.max(m, v), 0);
  assert.ok(max(quiet) > 100, `тихий пик ${max(quiet)}`);
  assert.ok(max(loud) > max(quiet));
  assert.equal(max(waveformPeaks(new Float32Array(8000), 8000)), 0);
});

test('Тишина в звуке распознаётся по пику', () => {
  assert.ok(peakDb(record(T16, 5, 8000, 0, 1, { silent: true })) < -70);
  assert.ok(peakDb(record(T16, 5, 8000, 0.8, 1)) > -20);
});

const anchor = (clipId: string, at: number, correction: number, score = 0.8): AudioAnchor => ({
  cameraId: 'B', clipId, refCameraId: 'A', refClipId: 'r', at, correction, score, ratio: 4, accepted: true, role: 'weak', fine: false, fineConfidence: 0,
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

// Сквозная проверка: звук каждого клипа берётся из общего звука площадки с его настоящим временем.
function fakeAudio(truth: Map<string, number>, silentIds = new Set<string>()): AudioFetch {
  // У каждой камеры свой шум и своя громкость, как у настоящих микрофонов.
  const hash = (s: string) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
  const gain = (c: ClipMeta) => 0.4 + (hash(c.id) % 3) * 0.2;
  const seed = (c: ClipMeta, start: number, salt: number) => (hash(c.id) * 7919 + Math.round(start * 1000) + salt) >>> 0;
  return {
    features: async (c, start, dur) => {
      const len = Math.min(dur, c.durationSec - start);
      const s = record(truth.get(c.id)! + start, len, FEAT_SR, gain(c), seed(c, start, 1), { silent: silentIds.has(c.id) });
      const picked = pickChannel([s, s], FEAT_SR, peakDb, SILENCE_DB);
      return { feat: picked.feat, peakDb: picked.peakDb, channel: picked.channel };
    },
    samples: async (c, start, dur) => record(truth.get(c.id)! + start, Math.min(dur, c.durationSec - start), FINE_SR, gain(c), seed(c, start, 2)),
  };
}

test('Сверка по звуку: камеры встают с точностью до долей миллисекунды, камера со сбитым поясом находится', async () => {
  const truth = new Map<string, number>();
  const mk = (realStart: number, dur: number, clockError: number, withTc: boolean, offsetTc = 0) => {
    const c = clip({ start: Math.floor(realStart + clockError), tcSeconds: withTc ? (((realStart + 3 * 3600 + offsetTc) % 86400) + 86400) % 86400 : undefined, durationSec: dur, recordedSec: dur });
    truth.set(c.id, realStart);
    return c;
  };
  const ref = camera('Опорная', [mk(T16, 300, 0.2, true), mk(T16 + 400, 300, 0.4, true)]);
  const tc = camera('Тайм-код', [mk(T16 + 20.0137, 200, 0.6, true, 1234.5), mk(T16 + 420.0137, 200, 0.6, true, 1234.5)]);
  const gopro = camera('GoPro', [mk(T16 + 30.0071, 60, -2.6, false), mk(T16 + 450.0213, 60, -2.6, false)]);
  const zone = camera('Пояс', [mk(T16 + 100.0049, 60, -7960, true, 5000), mk(T16 + 500.0049, 60, -7960, true, 5000)]);
  const cams = [ref, tc, gopro, zone];
  const coarse = runSync(cams);
  const audio = await refineByAudio(cams, coarse, fakeAudio(truth), { searchSec: 10, maxAnchors: 6, isEnabled: () => true });
  const final = runSync(cams, audio.corrections);
  const refErr = final.placements.find((p) => p.cameraId === 'Опорная')!.start - truth.get(final.placements.find((p) => p.cameraId === 'Опорная')!.clipId)!;
  for (const p of final.placements) {
    const err = p.start - truth.get(p.clipId)! - refErr;
    assert.ok(Math.abs(err) < 0.001, `${p.cameraId}: ошибка относительно опорной ${(err * 1000).toFixed(3)} мс`);
  }
  assert.ok(audio.cameras.filter((c) => c.status === 'applied' || c.status === 'confirmed').every((c) => c.anchors.some((a) => a.fine)));
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
  const audio = await refineByAudio(cams, coarse, fakeAudio(truth, new Set([b.id])), { searchSec: 10, maxAnchors: 6, isEnabled: () => true });
  assert.equal(audio.cameras[1].status, 'silent');
  assert.equal(audio.corrections[b.id], undefined);
  assert.ok(audio.issues.some((i) => /тишина/.test(i.title)));
});

// Рекордер: длинная запись на своём кварце. Точки вдоль записи расходятся на десятые доли секунды за час — это штатно.
const recAnchor = (clipId: string, at: number, correction: number, score = 0.8): AudioAnchor => ({ ...anchor(clipId, at, correction, score), drift: true });

test('Рекордер: ход часов за длинную запись — в пределах погрешности, точки не отбрасываются', () => {
  const placements = [{ ...pl('rec', 0), end: 3600 }];
  // За час часы рекордера ушли на 0,15 с.
  const anchors = [recAnchor('rec', 300, 1.0), recAnchor('rec', 1200, 1.04), recAnchor('rec', 2100, 1.09), recAnchor('rec', 3000, 1.15)];
  const r = combine('B', anchors, 'timecode-and-clock', placements, true, 180, true);
  assert.equal(r.result.model, 'per-clip');
  assert.ok(anchors.every((a) => a.role === 'confirm'), anchors.map((a) => a.role).join());
  // Запись встаёт по середине расхождения.
  assert.ok(r.corrections.rec > 1.0 && r.corrections.rec < 1.15, `поправка ${r.corrections.rec}`);
  assert.ok(!r.issues.some((i) => i.severity !== 'info'), 'никаких ошибок и предупреждений');
  assert.ok(!r.issues.some((i) => /отброшены|менялась/.test(i.title)));
  assert.ok(r.issues.some((i) => /в пределах погрешности/.test(i.title)));
});

test('Рекордер: настоящий скачок (ложное совпадение) допуском не прикрывается', () => {
  const placements = [{ ...pl('rec', 0), end: 3600 }];
  const anchors = [recAnchor('rec', 300, 1.0), recAnchor('rec', 1200, 1.02), recAnchor('rec', 2100, 2.3, 0.5), recAnchor('rec', 3000, 1.05)];
  const r = combine('B', anchors, 'timecode-and-clock', placements, true, 180, true);
  assert.equal(anchors[2].role, 'ignored');
  assert.ok(Math.abs(r.corrections.rec - 1.02) < 0.03, `поправка ${r.corrections.rec}`);
});

test('Камера, сверенная по рекордеру: ход его часов не считается сменой поправки', () => {
  const placements = [pl('c1', 0), pl('c2', 1200), pl('c3', 2400), pl('c4', 3500)];
  const anchors = [recAnchor('c1', 5, 0.5), recAnchor('c2', 1205, 0.56), recAnchor('c3', 2405, 0.62), recAnchor('c4', 3505, 0.67)];
  const r = combine('B', anchors, 'timecode-and-clock', placements, true, 180);
  assert.equal(r.result.model, 'single');
  assert.ok(!r.issues.length, r.issues.map((i) => i.title).join('; '));
  // Без рекордера такой же уход — уже смена поправки: так и было.
  const video = [anchor('c1', 5, 0.5), anchor('c2', 1205, 0.56), anchor('c3', 2405, 0.72), anchor('c4', 3505, 0.73)];
  assert.equal(combine('B', video, 'timecode-and-clock', placements, true, 180).result.model, 'per-anchor');
});

test('Рекордер: часовая запись с уходом часов и тишиной в начале — сверка идёт дальше и цепляется', async () => {
  const truth = new Map<string, number>();
  const ref = clip({ start: T16, tcSeconds: (T16 + 3 * 3600) % 86400, durationSec: 3500, recordedSec: 3500 });
  truth.set(ref.id, T16);
  // Рекордер включили на 5 с позже, часы сбиты на 1,3 с, кварц спешит на 40 мкс в секунду.
  const rec = clip({ start: Math.floor(T16 + 5 + 1.3), durationSec: 3400, recordedSec: 3400, hasVideo: false, rate: null, width: 0, height: 0, codecLabel: 'WAV 24-bit' });
  truth.set(rec.id, T16 + 5);
  const RATE = 1 + 40e-6;
  const MUTE = 200; // первые 200 секунд рекордер писал тишину
  const base = fakeAudio(truth);
  const real = (c: ClipMeta, local: number) => (c.id === rec.id ? local * RATE : local);
  const audio: AudioFetch = {
    features: async (c, start, dur) => {
      if (c.id === rec.id && start + dur <= MUTE) return { feat: bandFeatures(new Float32Array(Math.round(dur * FEAT_SR)), FEAT_SR).feat, peakDb: -200, channel: 0 };
      return base.features(c, real(c, start), dur);
    },
    samples: (c, start, dur, ch) => base.samples(c, real(c, start), dur, ch),
  };
  const cams = [camera('A', [ref]), camera('Рекордер', [rec])];
  const coarse = runSync(cams);
  let calls = 0;
  const result = await refineByAudio(cams, coarse, audio, { searchSec: 10, maxAnchors: 6, isEnabled: () => true, onProgress: (d) => { calls = d; } });
  const cam = result.cameras[1];
  const ok = cam.anchors.filter((x) => x.accepted);
  // Четыре отрезка — четыре точки, в первом сверка прошла мимо тишины и зацепилась дальше.
  assert.equal(ok.length, 4, `точек ${ok.length}`);
  assert.ok(ok[0].at > T16 + MUTE, `первая точка на ${ok[0].at - T16} с`);
  assert.ok(calls <= 4 * 3, `проверок ${calls}`);
  assert.ok(ok.every((x) => x.role === 'confirm' && x.fine));
  assert.equal(cam.status, 'applied');
  // Запись встала по середине расхождения: ошибка меньше 0,1 с, ни ошибок, ни предупреждений по рекордеру.
  const final = runSync(cams, result.corrections);
  const err = final.placements.find((p) => p.clipId === rec.id)!.start - (T16 + 5) - (final.placements.find((p) => p.clipId === ref.id)!.start - T16);
  assert.ok(Math.abs(err) < 0.1, `ошибка ${err}`);
  assert.ok(!result.issues.some((i) => i.cameraId === cam.cameraId && i.severity !== 'info'), result.issues.map((i) => i.title).join('; '));
  if (process.env.DEBUG_AUDIO) console.log({ calls, err, at: ok.map((x) => Math.round(x.at - T16)), corr: ok.map((x) => x.correction.toFixed(4)), issues: result.issues.map((i) => i.title) });
});

test('Рекордеру хватает одного видеофайла с хорошим совпадением', async () => {
  const truth = new Map<string, number>();
  // Видео — один клип на 50 с посреди получасовой записи рекордера. Часы рекордера сбиты на 2,4 с.
  const video = clip({ start: T16 + 600, tcSeconds: (T16 + 600 + 3 * 3600) % 86400, durationSec: 50, recordedSec: 50 });
  truth.set(video.id, T16 + 600);
  const rec = clip({ start: Math.floor(T16 + 2.4), durationSec: 1800, recordedSec: 1800, hasVideo: false, rate: null, width: 0, height: 0, codecLabel: 'WAV 24-bit' });
  truth.set(rec.id, T16);
  const cams = [camera('A', [video]), camera('Рекордер', [rec])];
  const coarse = runSync(cams);
  const result = await refineByAudio(cams, coarse, fakeAudio(truth), { searchSec: 10, maxAnchors: 6, isEnabled: () => true });
  assert.equal(result.cameras[1].status, 'applied');
  assert.equal(result.cameras[1].anchors.filter((a) => a.accepted).length, 1);
  const final = runSync(cams, result.corrections);
  const err = final.placements.find((p) => p.clipId === rec.id)!.start - T16 - (final.placements.find((p) => p.clipId === video.id)!.start - (T16 + 600));
  assert.ok(Math.abs(err) < 0.001, `ошибка ${err}`);
  assert.ok(!result.issues.some((i) => i.severity !== 'info'), result.issues.map((i) => i.title).join('; '));
});

test('Ведомая камера: сверяется по остальным, но опорой не становится и других не двигает', async () => {
  const truth = new Map<string, number>();
  const mk = (realStart: number, dur: number, clockError: number, opts: Partial<ClipMeta> = {}) => {
    const c = clip({ start: Math.floor(realStart + clockError), durationSec: dur, recordedSec: dur, ...opts });
    truth.set(c.id, realStart);
    return c;
  };
  // Без тайм-кода у всех; больше всего общего звука у рекордера, но он ведомый.
  const a = camera('A', [mk(T16 + 10, 120, 0.3), mk(T16 + 400, 120, 0.3)]);
  const b = camera('B', [mk(T16 + 40, 120, -1.7), mk(T16 + 430, 120, -1.7)]);
  const rec = camera('Рекордер', [mk(T16, 700, 1.2, { hasVideo: false, rate: null, width: 0, height: 0 })], { follower: true });
  const cams = [a, b, rec];
  const coarse = runSync(cams);
  const result = await refineByAudio(cams, coarse, fakeAudio(truth), { searchSec: 10, maxAnchors: 6, isEnabled: () => true, followers: new Set(['Рекордер']) });
  const byId = new Map(result.cameras.map((c) => [c.cameraId, c]));
  assert.notEqual(byId.get('Рекордер')!.status, 'reference');
  // Ни одна камера не сверялась по ведомой.
  assert.ok(result.cameras.filter((c) => c.cameraId !== 'Рекордер').every((c) => c.anchors.every((x) => x.refCameraId !== 'Рекордер')));
  // А сама ведомая встала по остальным.
  const final = runSync(cams, result.corrections);
  const off = (camId: string) => final.placements.filter((p) => p.cameraId === camId).map((p) => p.start - truth.get(p.clipId)!);
  const refOff = off(byId.get('A')!.status === 'reference' ? 'A' : 'B')[0];
  for (const camId of ['A', 'B', 'Рекордер']) for (const e of off(camId)) assert.ok(Math.abs(e - refOff) < 0.002, `${camId}: ${e - refOff}`);
});
