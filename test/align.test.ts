import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agreeingClocks, alignByAudio } from '../src/core/align.ts';
import { runSync } from '../src/core/sync.ts';
import type { Camera, ClipMeta } from '../src/core/types.ts';
import { camera, clip, T16 } from './fixtures.ts';
import { fakeAudio, rng } from './sound.ts';
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
  // Камера A с точным тайм-кодом не сдвинулась.
  assert.ok(Math.abs(result.corrections[a.id] ?? 0) < 1e-9);
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

test('Ведомая: встаёт по остальным, но ни одна камера по ней не сверяется', async () => {
  const truth = new Map<string, number>();
  const mk = (realStart: number, dur: number, clockError: number, extra: Partial<ClipMeta> = {}) => {
    const c = clip({ start: Math.floor(realStart + clockError), durationSec: dur, recordedSec: dur, ...extra });
    truth.set(c.id, realStart);
    return c;
  };
  const a = camera('A', [mk(T16 + 10, 120, 0.3), mk(T16 + 400, 120, 0.3)]);
  const b = camera('B', [mk(T16 + 40, 120, -1.7), mk(T16 + 430, 120, -1.7)]);
  const rec = camera('Рекордер', [mk(T16, 700, 1.2, { hasVideo: false, rate: null, width: null, height: null })], { follower: true });
  const cams = [a, b, rec];
  const result = await alignByAudio(cams, runSync(cams), fakeAudio(truth), { ...opts, followers: new Set(['Рекордер']) });
  for (const [id, e] of errors(cams, result.corrections, truth)) assert.ok(Math.abs(e) < 0.002, `${id}: ${(e * 1000).toFixed(2)} мс`);
  const used = result.cameras.flatMap((c) => c.anchors.filter((x) => x.role === 'confirm'));
  assert.ok(used.filter((x) => x.cameraId !== 'Рекордер').every((x) => x.refCameraId !== 'Рекордер' || x.cameraId === 'Рекордер'));
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
  assert.ok(result.issues.some((i) => /часы рекордера ушли/.test(i.title)), result.issues.map((i) => i.title).join('; '));
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
