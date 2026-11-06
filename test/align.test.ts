import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agreeingClocks, alignByAudio, chanceOfWindows } from '../src/core/align.ts';
import { runSync } from '../src/core/sync.ts';
import type { Camera, ClipMeta } from '../src/core/types.ts';
import { camera, clip, T16 } from './fixtures.ts';
import { fakeAudio, record, rng } from './sound.ts';
import { peakDb, SILENCE_DB } from '../src/core/audioSync.ts';
import type { AudioFetch } from '../src/core/audioSync.ts';
import { FEAT_SR, FINE_SR, pickChannel } from '../src/core/audioFeatures.ts';
import type { Burst } from './sound.ts';

const tcOf = (epoch: number, offset = 0) => (((epoch + 3 * 3600 + offset) % 86400) + 86400) % 86400;
const opts = { searchSec: 30, maxAnchors: 8, isEnabled: () => true };

// Ошибка каждого клипа относительно первой камеры: для монтажа важна стыковка между собой.
function errors(cams: Camera[], corrections: Record<string, number>, truth: Map<string, number>): Map<string, number> {
  const final = runSync(cams, corrections);
  const base = final.placements.find((p) => p.cameraId === cams[0].id)!;
  const ref = base.start - truth.get(base.clipId)!;
  return new Map(final.placements.map((p) => [p.clipId, p.start - truth.get(p.clipId)! - ref]));
}

test('Все со всеми: камеры встают до долей миллисекунды, камеры со сбитыми часами и чужим поясом находятся', async () => {
  const truth = new Map<string, number>();
  const mk = (realStart: number, dur: number, clockError: number, tcOffset: number | null) => {
    const c = clip({ start: Math.floor(realStart + clockError), tcSeconds: tcOffset === null ? undefined : tcOf(realStart, tcOffset), durationSec: dur, recordedSec: dur });
    truth.set(c.id, realStart);
    return c;
  };
  const cams = [
    camera('A', [mk(T16, 300, 0.2, 0), mk(T16 + 400, 300, 0.4, 0)]),
    // Часы на 50 с вперёд — настоящее место вне окна «по часам».
    camera('Часы +50', [mk(T16 + 20.0137, 200, 50.6, 1234.5), mk(T16 + 420.0137, 200, 50.6, 1234.5)]),
    camera('GoPro', [mk(T16 + 30.0071, 60, -2.6, null), mk(T16 + 450.0213, 60, -2.6, null)]),
    camera('Пояс', [mk(T16 + 100.0049, 60, -7960, 5000), mk(T16 + 500.0049, 60, -7960, 5000)]),
  ];
  const result = await alignByAudio(cams, runSync(cams), fakeAudio(truth), opts);
  for (const [id, e] of errors(cams, result.corrections, truth)) assert.ok(Math.abs(e) < 0.002, `${id}: ${(e * 1000).toFixed(2)} мс`);
  assert.ok(result.issues.some((i) => i.cameraId === 'Часы +50' && /найдена по звуку/.test(i.title)));
  assert.ok(result.issues.some((i) => i.cameraId === 'Пояс' && /часовой пояс/.test(i.details ?? '')));
});

test('Рекордер с датой 2010 года и тайм-кодом по ней встаёт по звуку и не сдвигает камеры', async () => {
  const truth = new Map<string, number>();
  const a = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 400, recordedSec: 400 });
  const b = clip({ start: T16 + 30, durationSec: 300, recordedSec: 300 });
  const old = T16 - 6112 * 86400;
  const rec = clip({ start: old, tcSeconds: tcOf(old), durationSec: 500, recordedSec: 500, hasVideo: false, rate: null, width: null, height: null });
  truth.set(a.id, T16);
  truth.set(b.id, T16 + 30.25);
  truth.set(rec.id, T16 - 40);
  const cams = [camera('A', [a]), camera('B', [b]), camera('Zoom', [rec])];
  const coarse = runSync(cams);
  assert.ok(coarse.cameras.find((c) => c.cameraId === 'Zoom')!.dateOutlierSec !== null);
  const result = await alignByAudio(cams, coarse, fakeAudio(truth), opts);
  for (const [id, e] of errors(cams, result.corrections, truth)) assert.ok(Math.abs(e) < 0.002, `${id}: ${(e * 1000).toFixed(2)} мс`);
  // Камера A с точным тайм-кодом не сдвинулась (уточнение по звуку двигает её меньше чем на полмиллисекунды).
  assert.ok(Math.abs(result.corrections[a.id] ?? 0) < 0.0005, `${result.corrections[a.id]}`);
  const final = runSync(cams, result.corrections);
  assert.ok(final.end - final.start < 3600);
});

test('Запись, порезанная на куски встык, сверяется целиком: кусок без общего звука встаёт вместе с остальными', async () => {
  const truth = new Map<string, number>();
  const cam = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 900, recordedSec: 900 });
  truth.set(cam.id, T16);
  // Петличка: три куска по 300 с, время только из имени файла (часы на 3 с вперёд). Средний кусок — «в другом помещении».
  const lav = [0, 1, 2].map((k) => {
    const c = clip({ start: T16 + 20 + 3 + k * 300, durationSec: 300, recordedSec: 300, hasVideo: false, rate: null, width: null, height: null });
    Object.assign(c, { clock: { ...c.clock!, source: 'filename' } });
    truth.set(c.id, T16 + 20 + k * 300);
    return c;
  });
  const cams = [camera('Камера', [cam]), camera('Петличка', lav)];
  const result = await alignByAudio(cams, runSync(cams), fakeAudio(truth, new Set([lav[1].id])), opts);
  for (const [id, e] of errors(cams, result.corrections, truth)) assert.ok(Math.abs(e) < 0.002, `${id}: ${(e * 1000).toFixed(2)} мс`);
});

test('Камера с тишиной в звуке: прямое предупреждение, раскладка не меняется', async () => {
  const truth = new Map<string, number>();
  const a = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 120, recordedSec: 120 });
  const b = clip({ start: T16 + 10, durationSec: 60, recordedSec: 60 });
  truth.set(a.id, T16);
  truth.set(b.id, T16 + 10.4);
  const cams = [camera('A', [a]), camera('B', [b])];
  const result = await alignByAudio(cams, runSync(cams), fakeAudio(truth, new Set([b.id])), opts);
  assert.equal(result.cameras[1].status, 'silent');
  assert.equal(result.corrections[b.id] ?? 0, 0);
  assert.ok(result.issues.some((i) => i.cameraId === 'B' && /тишина/.test(i.title)));
});

// Музыка: фраза из 40 звуков на 30 секунд. plan — порядок частей пьесы: A — повторяющаяся фраза, остальные
// буквы — непохожие части. Плюс редкие уникальные звуки зала.
function music(plan: string, seed: number): Burst[] {
  const r = rng(seed);
  const part = () => Array.from({ length: 40 }, () => ({ dt: r() * 30, amp: 0.3 + r() * 0.5, freqs: Array.from({ length: 6 }, () => 300 + r() * 5000), phases: Array.from({ length: 6 }, () => r() * 6.28) }));
  const parts = new Map<string, ReturnType<typeof part>>();
  const out: Burst[] = [];
  [...plan].forEach((p, k) => {
    if (!parts.has(p)) parts.set(p, part());
    for (const n of parts.get(p)!) out.push({ t: T16 - 60 + k * 30 + n.dt, amp: n.amp, freqs: n.freqs, phases: n.phases });
  });
  for (let t = T16 - 60; t < T16 - 60 + plan.length * 30; t += 25 + r() * 30) out.push({ t, amp: 0.25, freqs: Array.from({ length: 6 }, () => 300 + r() * 5000), phases: Array.from({ length: 6 }, () => r() * 6.28) });
  return out.sort((x, y) => x.t - y.t);
}

// Вторая камера с часами, ушедшими ровно на одну фразу: на коротком куске звук совпадает и там.
async function musicCase(plan: string) {
  const truth = new Map<string, number>();
  const a = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 600, recordedSec: 600 });
  const b = clip({ start: T16 + 20 + 30, tcSeconds: tcOf(T16 + 20, 777), durationSec: 500, recordedSec: 500 });
  truth.set(a.id, T16);
  truth.set(b.id, T16 + 20);
  const cams = [camera('A', [a]), camera('B', [b])];
  const result = await alignByAudio(cams, runSync(cams), fakeAudio(truth, new Set(), music(plan, 11)), opts);
  return { result, err: errors(cams, result.corrections, truth).get(b.id)! };
}

test('Музыка с репризами: фраза повторяется среди других частей — сдвиг на фразу не принимается за настоящий', async () => {
  const { err } = await musicCase('AABACAADAAEAFAAGAABAAC'.slice(0, 24));
  assert.ok(Math.abs(err) < 0.002, `${(err * 1000).toFixed(2)} мс`);
});

test('Одна фраза без конца: если звук одинаково похож на несколько мест, программа не угадывает и говорит об этом', async () => {
  const { result, err } = await musicCase('A'.repeat(40));
  // Либо нашла верно, либо честно сообщила о неоднозначности. Выбрать повтор по звуку она не должна.
  const ambiguous = result.cameras[1].status === 'no-match' && result.issues.some((i) => /несколько мест/.test(i.title));
  assert.ok(Math.abs(err) < 0.002 || ambiguous, `ошибка ${(err * 1000).toFixed(0)} мс, статус ${result.cameras[1].status}`);
});

test('Рекордер: часовая запись с уходом часов и тишиной в начале — встаёт по середине, ход часов в сообщении', async () => {
  const truth = new Map<string, number>();
  const ref = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 3500, recordedSec: 3500 });
  truth.set(ref.id, T16);
  // Рекордер включили на 5 с позже, часы сбиты на 1,3 с, кварц отстаёт на 40 мкс в секунду; первые 200 с — тишина.
  const rec = clip({ start: Math.floor(T16 + 5 + 1.3), durationSec: 3400, recordedSec: 3400, hasVideo: false, rate: null, width: null, height: null });
  truth.set(rec.id, T16 + 5);
  const RATE = 1 + 40e-6;
  const cams = [camera('A', [ref]), camera('Рекордер', [rec])];
  const audio = fakeAudio(truth, new Set(), undefined, new Map([[rec.id, RATE]]), new Map([[rec.id, T16 + 205]]));
  const result = await alignByAudio(cams, runSync(cams), audio, opts);
  const final = runSync(cams, result.corrections);
  const start = final.placements.find((p) => p.clipId === rec.id)!.start - (final.placements.find((p) => p.clipId === ref.id)!.start - T16);
  // В середине записи звук совпадает точно: начало записи стоит на половину ухода часов раньше середины.
  const midErr = start + 1700 - (T16 + 5 + 1700 * RATE);
  assert.ok(Math.abs(midErr) < 0.01, `в середине ошибка ${(midErr * 1000).toFixed(1)} мс`);
  // Ход часов измерен по звуку: 40 миллионных, запись выравнивается при экспорте.
  const drift = result.drift?.find((d) => d.cameraId === 'Рекордер');
  assert.ok(drift && Math.abs(drift.ppm - 40) < 2 && drift.apply, JSON.stringify(drift));
  assert.ok(result.issues.some((i) => /часы отстают на 40 ppm/.test(i.title)), result.issues.map((i) => i.title).join('; '));
});

test('Время суток — по самой большой компании согласных часов, а не по середине между всеми', () => {
  // Две камеры согласны в пределах секунды, петличка спешит на 3 с, ещё одна камера — на 50 с.
  const v = agreeingClocks([
    { device: 'A', v: 0.5, weak: false },
    { device: 'B', v: -0.5, weak: false },
    { device: 'Петличка', v: 3.2, weak: false },
    { device: 'C', v: 50.3, weak: false },
  ]);
  assert.ok(Math.abs(v) <= 0.5, `${v}`);
  // Камера с полусотней клипов без тайм-кода не перевешивает две согласные камеры.
  const many = Array.from({ length: 50 }, () => ({ device: 'GoPro', v: 7, weak: false }));
  assert.ok(Math.abs(agreeingClocks([...many, { device: 'A', v: 0.2, weak: false }, { device: 'B', v: -0.2, weak: false }])) <= 0.2);
});

test('Без согласных часов время суток — часы средней из близких камер, при любом порядке дорожек и без усреднения', () => {
  // Как на концерте тестера: у каждой камеры свои часы (0, −50, −82 с), рекордер с верной датой отстаёт на 10 ч.
  const votes = [
    { device: 'CAM 02', v: 0, weak: false },
    { device: 'CAM 03', v: -50, weak: false },
    { device: 'Петличка', v: -82, weak: false },
    { device: 'Zoom', v: -38000, weak: false, exact: true },
  ];
  const r = rng(5);
  for (let k = 0; k < 12; k++) {
    const order = [...votes].sort(() => r() - 0.5);
    assert.equal(agreeingClocks(order), -50);
  }
  // Двое расходятся на 3 с — берутся часы одного из них, а не середина между ними.
  assert.ok([0, 3].includes(agreeingClocks([{ device: 'A', v: 0, weak: false }, { device: 'B', v: 3, weak: false }])));
  // Тайм-код по часам точнее самих часов: в согласной компании решает он.
  assert.equal(agreeingClocks([{ device: 'A', v: 0.6, weak: false }, { device: 'B', v: 0, weak: false, exact: true }]), 0);
});

test('Тайм-код по часам самой камеры — это те же часы: две такие камеры с часами вразнобой встают по звуку', async () => {
  const truth = new Map<string, number>();
  const a = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 600, recordedSec: 600 });
  // Часы B на 3 с вперёд, тайм-код выставлен по ним же.
  const b = clip({ start: T16 + 103, tcSeconds: tcOf(T16 + 103), durationSec: 400, recordedSec: 400 });
  truth.set(a.id, T16);
  truth.set(b.id, T16 + 100);
  const cams = [camera('A', [a]), camera('B', [b])];
  const coarse = runSync(cams);
  assert.ok(coarse.cameras.every((c) => c.timeSource === 'timecode'));
  const result = await alignByAudio(cams, coarse, fakeAudio(truth), opts);
  for (const [id, e] of errors(cams, result.corrections, truth)) assert.ok(Math.abs(e) < 0.002, `${id}: ${(e * 1000).toFixed(2)} мс`);
  // Чьи часы верны, знать нельзя — но о расхождении в 3 с сказано прямо, без «камеры стояли далеко».
  assert.ok(result.issues.some((i) => /(спешат|отстают) на 3 с/.test(i.title)), result.issues.map((i) => i.title).join('; '));
  assert.ok(!result.issues.some((i) => /далеко друг от друга/.test(i.details ?? '')));
});

test('Общий тайм-код от одного генератора: звук его подтвердил — камеры стоят по тайм-коду, а не по запоздавшему звуку', async () => {
  const truth = new Map<string, number>();
  const a = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 600, recordedSec: 600 });
  const b = clip({ start: T16 + 100, tcSeconds: tcOf(T16 + 100), durationSec: 400, recordedSec: 400 });
  truth.set(a.id, T16);
  // Камера B стоит в 25 м от сцены: звук доходит до неё на 73 мс позже.
  truth.set(b.id, T16 + 100 - 0.073);
  const cams = [camera('A', [a]), camera('B', [b])];
  const result = await alignByAudio(cams, runSync(cams), fakeAudio(truth), opts);
  const final = runSync(cams, result.corrections);
  const at = (id: string) => final.placements.find((p) => p.clipId === id)!.start;
  assert.ok(Math.abs(at(b.id) - at(a.id) - 100) < 0.002, `${((at(b.id) - at(a.id) - 100) * 1000).toFixed(1)} мс`);
  assert.ok(result.issues.some((i) => i.cameraId === 'B' && /расходится/.test(i.title) && /общий/.test(i.details ?? '')));
});

test('Рекордер с верной датой, но сбитым временем суток не тянет за собой всю съёмку', async () => {
  const truth = new Map<string, number>();
  const a = clip({ start: T16, durationSec: 900, recordedSec: 900 });
  const b = clip({ start: T16 + 20 + 50, durationSec: 800, recordedSec: 800 }); // часы на 50 с вперёд
  // Тайм-код рекордера — по его часам, а они на 10,5 ч позади. Дата та же, поэтому выбросом он не считается.
  const wrong = T16 + 10 - 10.5 * 3600;
  const rec = clip({ start: wrong, tcSeconds: tcOf(wrong), durationSec: 880, recordedSec: 880, hasVideo: false, rate: null, width: null, height: null });
  truth.set(a.id, T16);
  truth.set(b.id, T16 + 20);
  truth.set(rec.id, T16 + 10);
  const cams = [camera('A', [a]), camera('B', [b]), camera('Zoom', [rec])];
  const coarse = runSync(cams);
  assert.equal(coarse.cameras.find((c) => c.cameraId === 'Zoom')!.dateOutlierSec, null);
  const result = await alignByAudio(cams, coarse, fakeAudio(truth), opts);
  for (const [id, e] of errors(cams, result.corrections, truth)) assert.ok(Math.abs(e) < 0.002, `${id}: ${(e * 1000).toFixed(2)} мс`);
  // Время съёмки — по камерам, рекордер найден на 10,5 ч позже своих часов.
  assert.ok(Math.abs(result.corrections[a.id] ?? 0) <= 60 && Math.abs(result.corrections[b.id] ?? 0) <= 60);
  assert.ok(result.issues.some((i) => i.cameraId === 'Zoom' && /на 10 ч 30 мин позже/.test(i.title)), result.issues.map((i) => i.title).join('; '));
});

test('Петличка скопирована без времени в именах: даты файлов накладываются, запись без общего звука встаёт встык и с предупреждением', async () => {
  const truth = new Map<string, number>();
  const cam = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 900, recordedSec: 900 });
  truth.set(cam.id, T16);
  // Даты файлов — время копирования, через 2 с друг за другом. Последний кусок — «в другом помещении».
  const lav = [0, 1, 2].map((k) => {
    const c = clip({ start: T16 + 5000 + k * 2, durationSec: 300, recordedSec: 300, hasVideo: false, rate: null, width: null, height: null });
    Object.assign(c, { clock: { ...c.clock!, source: 'file', precisionSec: 3 } });
    truth.set(c.id, T16 + 20 + k * 300);
    return c;
  });
  const cams = [camera('Камера', [cam]), camera('Петличка', lav)];
  const result = await alignByAudio(cams, runSync(cams), fakeAudio(truth, new Set([lav[2].id])), opts);
  for (const [id, e] of errors(cams, result.corrections, truth)) assert.ok(Math.abs(e) < 0.002, `${id}: ${(e * 1000).toFixed(2)} мс`);
  const warn = result.issues.find((i) => i.cameraId === 'Петличка' && /не нашлась по звуку/.test(i.title));
  assert.ok(warn && /встык/.test(warn.details ?? '') && warn.details!.includes(lav[2].name), result.issues.map((i) => i.title).join('; '));
});

test('Уточнение: тайм-код камеры сбился через паузу на 0,4 с — второй клип встаёт по звуку, с сообщением', async () => {
  const truth = new Map<string, number>();
  const a = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 1500, recordedSec: 1500 });
  truth.set(a.id, T16);
  // Камера B: Free Run, тайм-код на 5000 с впереди. После паузы камеру включили — тайм-код сбился на 0,4 с,
  // по часам (точным до секунды) этого не видно.
  const b1 = clip({ start: T16 + 100, tcSeconds: tcOf(T16 + 100, 5000), durationSec: 400, recordedSec: 400 });
  const b2 = clip({ start: T16 + 700, tcSeconds: tcOf(T16 + 700, 5000.4), durationSec: 400, recordedSec: 400 });
  truth.set(b1.id, T16 + 100);
  truth.set(b2.id, T16 + 700);
  const cams = [camera('A', [a]), camera('B', [b1, b2])];
  const coarse = runSync(cams);
  assert.equal(coarse.cameras.find((c) => c.cameraId === 'B')!.timecodeJumps, 0); // по часам скачка не видно
  const result = await alignByAudio(cams, coarse, fakeAudio(truth), opts);
  for (const [id, e] of errors(cams, result.corrections, truth)) assert.ok(Math.abs(e) < 0.002, `${id}: ${(e * 1000).toFixed(2)} мс`);
  assert.ok(result.issues.some((i) => i.cameraId === 'B' && /тайм-код сбивался после пауз/.test(i.title)), result.issues.map((i) => i.title).join('; '));
});

test('Уточнение: «встык» по часам оказался паузой в 2 с — клип встаёт по звуку', async () => {
  const truth = new Map<string, number>();
  const a = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 900, recordedSec: 900 });
  truth.set(a.id, T16);
  // Камера без тайм-кода: по её часам второй клип начался через секунду после конца первого, на деле — через две.
  const c1 = clip({ start: T16 + 50, durationSec: 300, recordedSec: 300 });
  const c2 = clip({ start: T16 + 50 + 300 + 1, durationSec: 300, recordedSec: 300 });
  truth.set(c1.id, T16 + 50.4);
  truth.set(c2.id, T16 + 50.4 + 300 + 2);
  const cams = [camera('A', [a]), camera('C', [c1, c2])];
  const result = await alignByAudio(cams, runSync(cams), fakeAudio(truth), opts);
  for (const [id, e] of errors(cams, result.corrections, truth)) assert.ok(Math.abs(e) < 0.002, `${id}: ${(e * 1000).toFixed(2)} мс`);
  assert.ok(result.issues.some((i) => i.cameraId === 'C' && /не одна запись/.test(i.title)), result.issues.map((i) => i.title).join('; '));
});

test('Уточнение: BWF-время рекордера — целые секунды; второй файл встаёт по звуку, а не по округлённому времени', async () => {
  const truth = new Map<string, number>();
  const a = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 1400, recordedSec: 1400 });
  truth.set(a.id, T16);
  const rec = (real: number, dur: number) => {
    const c = clip({ start: Math.floor(real), tcSeconds: tcOf(Math.floor(real)), durationSec: dur, recordedSec: dur, hasVideo: false, rate: null, width: null, height: null });
    Object.assign(c, { tc: { ...c.tc!, source: 'bwf' } });
    truth.set(c.id, real);
    return c;
  };
  const z1 = rec(T16 + 30.37, 500);
  const z2 = rec(T16 + 800.79, 400);
  const cams = [camera('A', [a]), camera('Zoom', [z1, z2])];
  const result = await alignByAudio(cams, runSync(cams), fakeAudio(truth), opts);
  for (const [id, e] of errors(cams, result.corrections, truth)) assert.ok(Math.abs(e) < 0.002, `${id}: ${(e * 1000).toFixed(2)} мс`);
  assert.ok(result.issues.some((i) => i.cameraId === 'Zoom' && /целыми секундами/.test(i.title)), result.issues.map((i) => i.title).join('; '));
});

test('Ход часов в пределах кадра не выравнивается и не тревожит сообщениями', async () => {
  const truth = new Map<string, number>();
  const a = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 2000, recordedSec: 2000 });
  const rec = clip({ start: T16 + 10, durationSec: 1800, recordedSec: 1800, hasVideo: false, rate: null, width: null, height: null });
  truth.set(a.id, T16);
  truth.set(rec.id, T16 + 10);
  const cams = [camera('A', [a]), camera('Рекордер', [rec])];
  const result = await alignByAudio(cams, runSync(cams), fakeAudio(truth, new Set(), undefined, new Map([[rec.id, 1 + 5e-6]])), opts);
  const drift = result.drift?.find((d) => d.cameraId === 'Рекордер');
  assert.ok(drift && Math.abs(drift.ppm - 5) < 2 && !drift.apply, JSON.stringify(drift));
  assert.ok(!result.issues.some((i) => /ход часов|ppm/.test(i.title)), result.issues.map((i) => i.title).join('; '));
});

test('Погрешность: у записи с сильным эхом точность честно хуже, у чистых — до миллисекунд', async () => {
  const truth = new Map<string, number>();
  const a = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 900, recordedSec: 900 });
  const b = clip({ start: T16 + 20, durationSec: 800, recordedSec: 800 });
  const r = clip({ start: T16 + 40, durationSec: 700, recordedSec: 700, hasVideo: false, rate: null, width: null, height: null });
  truth.set(a.id, T16);
  truth.set(b.id, T16 + 20);
  truth.set(r.id, T16 + 40);
  const cams = [camera('A', [a]), camera('B', [b]), camera('Эхо', [r])];
  // Рекордер у стены: отражение через 35 мс громче прямого звука.
  const echoes = new Map([[r.id, { delay: 0.035, gain: 1.2 }]]);
  const result = await alignByAudio(cams, runSync(cams), fakeAudio(truth, new Set(), undefined, new Map(), new Map(), echoes), opts);
  const acc = (id: string) => result.cameras.find((c) => c.cameraId === id)!.accuracySec ?? NaN;
  assert.ok(acc('A') < 0.003 && acc('B') < 0.003, `A ${acc('A')}, B ${acc('B')}`);
  assert.ok(acc('Эхо') >= 0.012, `эхо: ${acc('Эхо')}`);
  // Место — у прямого звука или у отражения, но не дальше.
  const e = errors(cams, result.corrections, truth).get(r.id)!;
  assert.ok(Math.abs(e) < 0.04, `${(e * 1000).toFixed(1)} мс`);
});

test('Рекордер разрезал запись на файлы по 2 ГБ: второй файл встаёт ровно с конца первого, а не по секундам BWF', async () => {
  // На съёмке тестера второй файл опаздывал на 0,9 с: BWF-время округлено до секунды, а зазора между файлами нет.
  const truth = new Map<string, number>();
  const a = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 1400, recordedSec: 1400 });
  truth.set(a.id, T16);
  const rec = (real: number, dur: number, size: number) => {
    const c = clip({ start: Math.floor(real), tcSeconds: tcOf(Math.floor(real)), durationSec: dur, recordedSec: dur, hasVideo: false, rate: null, width: null, height: null, sizeBytes: size });
    Object.assign(c, { tc: { ...c.tc!, source: 'bwf' } });
    truth.set(c.id, real);
    return c;
  };
  // Длина первого файла — с долями секунды, как у настоящего ZOOM0001 (7456,085 с): по округлённым временам между
  // файлами выходит ложный зазор 0,6 с.
  const z1 = rec(T16 + 30.9, 1500.4, 2147385344);
  const z2 = rec(T16 + 1531.3, 400, 617230592); // с камерой общего звука нет — место только по стыку
  const cams = [camera('A', [a]), camera('Zoom', [z1, z2])];
  const result = await alignByAudio(cams, runSync(cams), fakeAudio(truth), opts);
  for (const [id, e] of errors(cams, result.corrections, truth)) assert.ok(Math.abs(e) < 0.002, `${id}: ${(e * 1000).toFixed(2)} мс`);
});

test('Уточнение: сбой тайм-кода после паузы меньше кадра (40 мс) тоже находится, и результат не зависит от порядка дорожек', async () => {
  // На съёмке тестера CAM 01 после антракта сбилась на 37 мс; при пороге 60 мс клип вставал то по звуку, то по
  // тайм-коду — в зависимости от того, в каком порядке добавили дорожки.
  const truth = new Map<string, number>();
  const a = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 1500, recordedSec: 1500 });
  truth.set(a.id, T16);
  const b1 = clip({ start: T16 + 100, tcSeconds: tcOf(T16 + 100, 5000), durationSec: 400, recordedSec: 400 });
  const b2 = clip({ start: T16 + 700, tcSeconds: tcOf(T16 + 700, 5000.04), durationSec: 400, recordedSec: 400 });
  truth.set(b1.id, T16 + 100);
  truth.set(b2.id, T16 + 700);
  const rec = clip({ start: T16 + 50, durationSec: 1300, recordedSec: 1300, hasVideo: false, rate: null, width: null, height: null });
  truth.set(rec.id, T16 + 50);
  const forward = [camera('A', [a]), camera('B', [b1, b2]), camera('Рекордер', [rec])];
  const backward = [camera('Рекордер', [rec]), camera('B', [b2, b1]), camera('A', [a])];
  const res1 = await alignByAudio(forward, runSync(forward), fakeAudio(truth), opts);
  const res2 = await alignByAudio(backward, runSync(backward), fakeAudio(truth), opts);
  const e1 = errors(forward, res1.corrections, truth);
  const e2 = errors([backward[2], backward[1], backward[0]], res2.corrections, truth);
  for (const [id, e] of e1) {
    assert.ok(Math.abs(e) < 0.002, `${id}: ${(e * 1000).toFixed(2)} мс`);
    assert.ok(Math.abs(e - e2.get(id)!) < 0.0005, `${id}: ${(e * 1000).toFixed(2)} и ${(e2.get(id)! * 1000).toFixed(2)} мс при другом порядке`);
  }
});

test('BWF-время целыми секундами — часы рекордера: случайно совпав с тайм-кодом камеры, оно не становится общим тайм-кодом', async () => {
  // Рекордер Zoom пишет время начала по своим часам целыми секундами; оно совпало с тайм-кодом камеры до 10 мс.
  // Раньше программа принимала их за общий генератор и переставала уточнять рекордер: второй файл — на 0,15 с мимо.
  const truth = new Map<string, number>();
  const a = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 1500, recordedSec: 1500 });
  truth.set(a.id, T16);
  const z1 = clip({ start: T16 + 20, tcSeconds: tcOf(T16 + 20), durationSec: 700.6, recordedSec: 700.6, hasVideo: false, rate: null, width: null, height: null, sizeBytes: 1e8 });
  const z2 = clip({ start: T16 + 721, tcSeconds: tcOf(T16 + 721), durationSec: 500, recordedSec: 500, hasVideo: false, rate: null, width: null, height: null });
  for (const z of [z1, z2]) Object.assign(z, { tc: { ...z.tc!, source: 'bwf' } });
  truth.set(z1.id, T16 + 20.01); // BWF 20 с, на деле 20,01 — совпадение с тайм-кодом камеры до 10 мс
  truth.set(z2.id, T16 + 720.85); // второй файл после паузы: BWF 721 — округлено
  const cams = [camera('A', [a]), camera('Zoom', [z1, z2])];
  const result = await alignByAudio(cams, runSync(cams), fakeAudio(truth), opts);
  assert.ok(!(result.log ?? []).some((l) => /общий тайм-код/.test(l)), (result.log ?? []).filter((l) => /общий/.test(l)).join("; "));
  for (const [id, e] of errors(cams, result.corrections, truth)) assert.ok(Math.abs(e) < 0.002, `${id}: ${(e * 1000).toFixed(2)} мс`);
});

// Трансляция: звук площадки тихий, поверх него громкий посторонний (комментаторы); камера — короткие клипы с паузами.
function weakScene(sharedGain: number) {
  const burstsFrom = (seed: number, gap: [number, number], amp: [number, number]): Burst[] => {
    const r = rng(seed);
    const out: Burst[] = [];
    for (let t = T16 - 200; t < T16 + 1500; t += gap[0] + r() * (gap[1] - gap[0])) {
      out.push({ t, amp: amp[0] + r() * (amp[1] - amp[0]), freqs: Array.from({ length: 6 }, () => 300 + r() * 5500), phases: Array.from({ length: 6 }, () => r() * Math.PI * 2) });
    }
    return out;
  };
  const shared = burstsFrom(31, [0.4, 2.4], [0.3, 0.9]);
  const talk = burstsFrom(37, [0.12, 0.5], [0.6, 1.2]);
  const truth = new Map<string, number>();
  const r = rng(5);
  const clips: ClipMeta[] = [];
  let t = T16 + 40;
  let slip = 0;
  for (let i = 0; i < 22; i++) {
    const dur = 15 + r() * 35;
    // После десятого клипа камеру выключали: тайм-код сбился на 1,3 с.
    if (i === 10) slip = 1.3;
    const c = clip({ start: Math.floor(t), tcSeconds: tcOf(t, 1000 + slip), durationSec: dur, recordedSec: dur });
    truth.set(c.id, t);
    clips.push(c);
    t += dur + (i === 9 ? 90 : 3 + r() * 15);
  }
  const bc = clip({ start: Math.floor(T16 + 20 + 95), durationSec: 1300, recordedSec: 1300 }); // время из контейнера — на 95 с мимо
  truth.set(bc.id, T16 + 20);
  const gen = (c: ClipMeta, start: number, dur: number, sr: number) => {
    const len = Math.min(dur, c.durationSec - start);
    const from = truth.get(c.id)! + start;
    if (c !== bc) return record(from, len, sr, 0.8, (c.id.length * 7919 + Math.round(start * 1000)) >>> 0, { bursts: shared });
    const a = record(from, len, sr, sharedGain, 11, { bursts: shared, noise: 0 });
    const b = record(from, len, sr, 0.9, 13 + Math.round(start), { bursts: talk });
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
  return { cams: [camera('Камера', clips), camera('Трансляция', [bc])], truth, audio, clips, bc };
}

test('Слабый общий звук (трансляция с комментаторами): совпадение находится голосованием клипов, сбой тайм-кода камеры после паузы поправлен', async () => {
  const { cams, truth, audio, clips, bc } = weakScene(0.25);
  const result = await alignByAudio(cams, runSync(cams), audio, opts);
  const errs = errors([cams[1], cams[0]], result.corrections, truth);
  for (const c of clips) assert.ok(Math.abs(errs.get(c.id)!) < 0.05, `${c.name}: ${(errs.get(c.id)! * 1000).toFixed(0)} мс; ${(result.log ?? []).filter((l) => /итог|по клипам/.test(l)).join(' | ')}`);
  assert.ok(errs.has(bc.id));
});

test('Без общего звука клипы не «находятся» случайно: ни совпадения, ни сдвига', async () => {
  const { cams, audio } = weakScene(0);
  const result = await alignByAudio(cams, runSync(cams), audio, opts);
  assert.ok(!(result.log ?? []).some((l) => /итог: -?\d/.test(l)), (result.log ?? []).filter((l) => /итог/.test(l)).join(' | '));
});

// Петличка у человека на сцене: зал она слышит лишь местами, остальное — свой голос. Камера с петличкой совпадает в семи окнах
// из сорока, у всех соперников — ни в одном.
function sparseScene(heard: number) {
  const burstsFrom = (seed: number, gap: [number, number], amp: [number, number]): Burst[] => {
    const r = rng(seed);
    const out: Burst[] = [];
    for (let t = T16 - 200; t < T16 + 1700; t += gap[0] + r() * (gap[1] - gap[0])) {
      out.push({ t, amp: amp[0] + r() * (amp[1] - amp[0]), freqs: Array.from({ length: 6 }, () => 300 + r() * 5500), phases: Array.from({ length: 6 }, () => r() * 6.28) });
    }
    return out;
  };
  const hall = burstsFrom(41, [0.4, 2.4], [0.3, 0.9]);
  const voice = burstsFrom(43, [0.12, 0.5], [0.6, 1.2]);
  const stretches = Array.from({ length: heard }, (_, i) => T16 + 60 + ((i + 0.5) / heard) * 1200);
  const audible = hall.filter((b) => stretches.some((s) => b.t >= s && b.t < s + 45));
  const cam = clip({ start: T16, durationSec: 1300, recordedSec: 1300 });
  const mic = clip({ start: T16 + 20 + 95, durationSec: 1300, recordedSec: 1300, hasVideo: false, rate: null, width: 0, height: 0 });
  const truth = new Map([[cam.id, T16], [mic.id, T16 + 20]]);
  const gen = (c: ClipMeta, start: number, dur: number, sr: number) => {
    const len = Math.min(dur, c.durationSec - start);
    const from = truth.get(c.id)! + start;
    if (c === cam) return record(from, len, sr, 0.8, 3 + Math.round(start), { bursts: hall });
    const a = record(from, len, sr, 0.5, 11, { bursts: audible, noise: 0 });
    const b = record(from, len, sr, 0.9, 13 + Math.round(start), { bursts: voice });
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
  return { cams: [camera('Камера', [cam]), camera('Петличка', [mic])], truth, audio, cam, mic };
}

test('Совпадение по вероятности: сколько окон случайно не наберётся', () => {
  const zero = Array.from({ length: 5 }, () => ({ support: 0, tested: 40 }));
  // Семь окон из сорока при нуле у соперников (петличка в концерте) — не случайность, три — ещё может быть.
  assert.ok(chanceOfWindows({ support: 7, tested: 40 }, zero) < 1e-7);
  assert.ok(chanceOfWindows({ support: 5, tested: 40 }, zero) < 1e-5);
  assert.ok(chanceOfWindows({ support: 3, tested: 40 }, zero) > 1e-3);
  // У соперников окна тоже совпадают (музыка повторяется) — семи окон мало.
  assert.ok(chanceOfWindows({ support: 7, tested: 40 }, [{ support: 6, tested: 40 }, { support: 4, tested: 40 }, ...zero.slice(2)]) > 1e-5);
  // У соперников почти нет окон — о случайности судить не по чему.
  assert.ok(chanceOfWindows({ support: 7, tested: 40 }, [{ support: 0, tested: 6 }, { support: 0, tested: 4 }]) > 1e-5);
});

test('Запись без общего звука с камерой по вероятности не принимается', async () => {
  const { cams, audio } = sparseScene(0);
  const result = await alignByAudio(cams, runSync(cams), audio, opts);
  assert.ok(!(result.log ?? []).some((l) => /итог: -?\d/.test(l)), (result.log ?? []).filter((l) => /итог/.test(l)).join(' | '));
});

// Устройство с двумя записями: первая слышит зал хорошо, вторая — едва. Часы у обеих одни, ошибка на 40 с.
function secondPassScene(gain: number) {
  const bursts = (seed: number, gap: [number, number], amp: [number, number]): Burst[] => {
    const r = rng(seed);
    const out: Burst[] = [];
    for (let t = T16 - 200; t < T16 + 2500; t += gap[0] + r() * (gap[1] - gap[0])) {
      out.push({ t, amp: amp[0] + r() * (amp[1] - amp[0]), freqs: Array.from({ length: 6 }, () => 300 + r() * 5500), phases: Array.from({ length: 6 }, () => r() * 6.28) });
    }
    return out;
  };
  const hall = bursts(51, [0.4, 2.4], [0.3, 0.9]);
  const voice = bursts(53, [0.12, 0.5], [0.6, 1.2]);
  const cam = clip({ start: T16, durationSec: 2200, recordedSec: 2200 });
  const audioClip = (at: number, dur: number) => clip({ start: Math.floor(at + 40), durationSec: dur, recordedSec: dur, hasVideo: false, rate: null, width: 0, height: 0 });
  const m1 = audioClip(T16 + 30, 900);
  const m2 = audioClip(T16 + 1100, 900);
  const truth = new Map([[cam.id, T16], [m1.id, T16 + 30], [m2.id, T16 + 1100]]);
  const gen = (c: ClipMeta, start: number, dur: number, sr: number) => {
    const len = Math.min(dur, c.durationSec - start);
    const from = truth.get(c.id)! + start;
    if (c === cam) return record(from, len, sr, 0.8, 3 + Math.round(start), { bursts: hall });
    if (c === m1) return record(from, len, sr, 0.8, 5 + Math.round(start), { bursts: hall });
    const a = gain ? record(from, len, sr, gain, 11, { bursts: hall, noise: 0 }) : new Float32Array(Math.round(len * sr));
    const b = record(from, len, sr, 0.9, 13 + Math.round(start), { bursts: voice });
    return a.map((v: number, i: number) => v + b[i]);
  };
  const audio: AudioFetch = {
    features: async (c, start, dur) => {
      const s = gen(c, start, dur, FEAT_SR);
      const picked = pickChannel([s, s], FEAT_SR, peakDb, SILENCE_DB);
      return { feat: picked.feat, peakDb: picked.peakDb, channel: picked.channel };
    },
    samples: async (c, start, dur) => gen(c, start, dur, FINE_SR),
  };
  return { cams: [camera('Камера', [cam]), camera('Петличка', [m1, m2])], truth, audio, m2 };
}

test('Второй проход: слабая запись устройства находится в узком поле и встаёт точно', async () => {
  const { cams, truth, audio, m2 } = secondPassScene(0.12);
  const result = await alignByAudio(cams, runSync(cams), audio, opts);
  const log = (result.log ?? []).filter((l) => /второй проход|кусок встал/.test(l)).join(' | ');
  assert.match(log, /кусок встал/, log);
  const errs = errors(cams, result.corrections, truth);
  assert.ok(Math.abs(errs.get(m2.id)!) < 0.05, `${(errs.get(m2.id)! * 1000).toFixed(0)} мс; ${log}`);
});

test('Второй проход: без общего звука запись не «находится»', async () => {
  const { cams, audio } = secondPassScene(0);
  const result = await alignByAudio(cams, runSync(cams), audio, opts);
  assert.ok(!(result.log ?? []).some((l) => /кусок встал/.test(l)), (result.log ?? []).filter((l) => /второй проход/.test(l)).join(' | '));
});
