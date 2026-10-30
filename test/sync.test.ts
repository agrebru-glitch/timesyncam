import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicates, findStrays, pilePlacements, runSync } from '../src/core/sync.ts';
import { buildFcp7Xml, defaultTimelineRate } from '../src/core/fcp7.ts';
import { camera, clip, T16 } from './fixtures.ts';

const OFFSET = 7 * 3600 + 27 * 60 + 28; // как в реальной съёмке на A7 IV: тайм-код убегает вперёд на 7:27:28
const wall = (epoch: number) => (((epoch + 3 * 3600) % 86400) + 86400) % 86400;

// Камера в Free Run: тайм-код точен до кадра, часы округляют до секунды вниз.
function freeRunClips(starts: number[], offset = OFFSET) {
  return starts.map((s) => clip({ start: Math.floor(s), tcSeconds: (wall(s) + offset) % 86400 }));
}

test('Free Run со сдвигом и переходом тайм-кода через полночь: паузы точны до кадра', () => {
  const exact = [T16 + 181.08, T16 + 213.84, T16 + 1800.4, T16 + 2 * 3600 + 12.6, T16 + 4 * 3600 + 5.2];
  const cam = camera('A', freeRunClips(exact));
  const r = runSync([cam]);
  const cs = r.cameras[0];
  assert.equal(cs.timeSource, 'timecode-and-clock');
  assert.equal(cs.timecodeJumps, 0);
  const starts = r.placements.map((p) => p.start);
  for (let i = 1; i < exact.length; i++) {
    assert.ok(Math.abs((starts[i] - starts[0]) - (exact[i] - exact[0])) < 0.001, `пауза ${i}`);
  }
  assert.ok(Math.abs(starts[0] - exact[0]) < 1.1);
  assert.equal(r.issues.filter((i) => i.severity !== 'info').length, 0);
});

test('Тайм-код совпадает с часами — камера считается точной (опорной)', () => {
  const cam = camera('A', freeRunClips([T16 + 10.5, T16 + 100.25], 0));
  const r = runSync([cam]);
  assert.equal(r.cameras[0].timeSource, 'timecode');
});

test('Камера без тайм-кода выравнивается по часам, есть подсказка про опорную', () => {
  const ref = camera('Опорная', freeRunClips([T16 + 10, T16 + 500], 0));
  const plain = camera('Без TC', [clip({ start: T16 + 20 }), clip({ start: T16 + 300 })]);
  const r = runSync([ref, plain]);
  assert.equal(r.cameras[1].timeSource, 'clock');
  assert.ok(r.issues.some((i) => i.cameraId === 'Без TC' && i.severity === 'info' && /по своим часам/.test(i.title)));
});

test('Rec Run: тайм-код непрерывный, хотя между клипами паузы — берём часы', () => {
  let tc = 50000;
  const clips = [0, 60, 200, 400, 700].map((d) => {
    const c = clip({ start: T16 + d, tcSeconds: tc });
    tc += 10;
    return c;
  });
  const r = runSync([camera('A', clips)]);
  assert.equal(r.cameras[0].recRun, true);
  assert.equal(r.cameras[0].timeSource, 'clock');
  assert.ok(r.issues.some((i) => /Rec Run/.test(i.title)));
});

test('Смена форматов внутри камеры (25p 4K → 50p 1080 → S&Q → 25p): клипы на своих местах', () => {
  const exact = [T16 + 10, T16 + 100.02, T16 + 300.4, T16 + 400.76];
  const clips = freeRunClips(exact);
  Object.assign(clips[1], { rate: { num: 50, den: 1 }, frames: 500, width: 1920, height: 1080 });
  Object.assign(clips[2], { captureFps: 100, recordedSec: 4, durationSec: 16, frames: 400 });
  const r = runSync([camera('A', clips)]);
  const at = (i: number) => r.placements.find((p) => p.clipId === clips[i].id)!.start;
  for (const i of [1, 2, 3]) assert.ok(Math.abs((at(i) - at(0)) - (exact[i] - exact[0])) < 0.001, `клип ${i}`);
  assert.equal(r.cameras[0].lanes, 1);
  assert.equal(r.cameras[0].timecodeJumps, 0);
  assert.deepEqual(r.issues.map((i) => i.severity), ['error']); // только S&Q
});

test('NTSC: 24p (23,976) вперемешку с 30p (29,97 DF) не уезжает на минуту', () => {
  // Тайм-код выставлен по часам. Тайм-код 23,976 без drop frame считается кадрами с полуночи — это метка × 1,001.
  const exact = [T16 + 10.2, T16 + 120.5, T16 + 200.3, T16 + 330.7, T16 + 600.1];
  const ntsc24 = new Set([1, 3]);
  const clips = exact.map((s, i) => {
    const c = clip({ start: Math.floor(s), tcSeconds: wall(s) * (ntsc24.has(i) ? 1.001 : 1) });
    c.rate = ntsc24.has(i) ? { num: 24000, den: 1001 } : { num: 30000, den: 1001 };
    c.tc!.drop = !ntsc24.has(i);
    return c;
  });
  const r = runSync([camera('A', clips)]);
  assert.equal(r.cameras[0].timeSource, 'timecode');
  for (const [i, c] of clips.entries()) {
    const err = r.placements.find((p) => p.clipId === c.id)!.start - exact[i];
    assert.ok(Math.abs(err) < 0.001, `клип ${i}: ${err.toFixed(3)} с`);
  }
  assert.equal(r.issues.length, 0);
});

test('S&Q помечается ошибкой с предложением убрать, после удаления — чисто', () => {
  const clips = freeRunClips([T16 + 10, T16 + 30, T16 + 100]);
  clips[1].captureFps = 100;
  clips[1].recordedSec = 4;
  clips[1].durationSec = 16;
  const cam = camera('A', clips);
  const r = runSync([cam]);
  const sq = r.issues.find((i) => /S&Q/.test(i.title))!;
  assert.equal(sq.severity, 'error');
  assert.equal(sq.actions[0].kind, 'exclude-clips');
  const r2 = runSync([{ ...cam, excludedClipIds: [clips[1].id] }]);
  assert.equal(r2.issues.length, 0);
  assert.equal(r2.placements.length, 2);
});

test('Клипы одной камеры накладываются — ошибка, клип уходит на вторую дорожку', () => {
  const a = clip({ start: T16, durationSec: 60, recordedSec: 60 });
  const b = clip({ start: T16 + 20 });
  const r = runSync([camera('A', [a, b])]);
  assert.ok(r.issues.some((i) => i.severity === 'error' && /накладываются/.test(i.title)));
  assert.equal(r.cameras[0].lanes, 2);
});

test('Камера на целые часы в стороне — предлагается сдвиг', () => {
  const a = camera('A', [clip({ start: T16 }), clip({ start: T16 + 1800 })]);
  const b = camera('B', [clip({ start: T16 + 3 * 3600 + 30 }), clip({ start: T16 + 3 * 3600 + 900 })]);
  const r = runSync([a, b]);
  const tz = r.issues.find((i) => i.cameraId === 'B' && /ч/.test(i.title))!;
  assert.ok(tz);
  assert.deepEqual(tz.actions[0], { kind: 'shift-camera', cameraId: 'B', seconds: -3 * 3600 });
});

test('Ручной сдвиг камеры двигает все её клипы', () => {
  const cam = camera('A', [clip({ start: T16 }), clip({ start: T16 + 100 })], { manualShiftSec: -1.04 });
  const r = runSync([cam]);
  assert.ok(Math.abs(r.placements[0].start - (T16 - 1.04)) < 1e-9);
});

test('Экспорт XML: дорожка на камеру, таймлиния с 00:00:00:00 и первым клипом в начале, путь с кириллицей', () => {
  const clips = freeRunClips([T16 + 181.08, T16 + 213.84]);
  clips[0].path = 'D:\\Съёмка 27_10\\C9151.MP4';
  clips[0].name = 'C9151.MP4';
  const cam = camera('Камера 1', clips);
  const r = runSync([cam]);
  const rate = defaultTimelineRate([cam]);
  assert.deepEqual(rate, { num: 25, den: 1 });
  const xml = buildFcp7Xml([cam], r, { name: 'Тест & проверка', rate, width: 3840, height: 2160 });
  assert.match(xml, /<sequence[\s\S]*?<timecode>[\s\S]*?<string>00:00:00:00<\/string><frame>0<\/frame>/);
  assert.match(xml, /file:\/\/localhost\/D:\/%D0%A1%D1%8A%D1%91%D0%BC%D0%BA%D0%B0%2027_10\/C9151\.MP4/);
  assert.match(xml, /Тест &amp; проверка/);
  assert.equal((xml.match(/<track>/g) ?? []).length, 3); // видео + 2 канала звука
  const starts = [...xml.matchAll(/<start>(\d+)<\/start>/g)].map((m) => Number(m[1]));
  assert.equal(starts[0], 0);
  assert.equal(starts[1], Math.round((r.placements[1].start - r.placements[0].start) * 25));
});

test('До синхронизации клипы лежат кучкой: подряд по порядку съёмки, все камеры с нуля', () => {
  // Часы второй камеры сбиты на сутки, третий клип первой камеры снят раньше остальных, у одного клипа нет часов.
  const a = camera('A', [
    clip({ start: T16 + 600, durationSec: 30 }),
    clip({ start: T16 + 3600, durationSec: 20 }),
    clip({ start: T16, durationSec: 10 }),
    clip({ durationSec: 5 }),
  ]);
  const b = camera('B', [clip({ start: T16 - 86400, durationSec: 40 }), clip({ start: T16 - 86400 + 7200, durationSec: 15 })], { manualShiftSec: 3600 });
  const p = pilePlacements([a, b]);
  const of = (cam: string) => p.filter((x) => x.cameraId === cam);

  // Порядок по часам, клип без часов — последним.
  assert.deepEqual(of('A').map((x) => x.clipId), [a.clips[2].id, a.clips[0].id, a.clips[1].id, a.clips[3].id]);
  // Обе камеры начинаются с нуля, ни часы, ни ручной сдвиг кучку не двигают.
  assert.equal(of('A')[0].start, 0);
  assert.equal(of('B')[0].start, 0);
  // Подряд с одинаковым небольшим зазором, длительность клипа сохраняется.
  const gaps = of('A').slice(1).map((x, i) => x.start - of('A')[i].end);
  assert.ok(gaps.every((g) => g === gaps[0] && g >= 1 && g < 5), `зазоры ${gaps}`);
  assert.ok(of('A').every((x, i) => x.end - x.start === [10, 30, 20, 5][i]));
  // Вся кучка — меньше двух минут, хотя по часам клипы разнесены на сутки.
  assert.ok(Math.max(...p.map((x) => x.end)) < 120);
});

test('Кучка не показывает клипы, убранные с таймлинии', () => {
  const a = camera('A', [clip({ start: T16 }), clip({ start: T16 + 100 }), clip({ start: T16 + 200 })]);
  a.excludedClipIds = [a.clips[1].id];
  const p = pilePlacements([a]);
  assert.deepEqual(p.map((x) => x.clipId), [a.clips[0].id, a.clips[2].id]);
});

test('Копии клипа: оставляется копия с Sony XML, лишняя не ставится на таймлинию', () => {
  const orig = clip({ start: T16 + 100, tcSeconds: 1000 });
  orig.name = 'C0003.MP4';
  const copy = { ...clip({ start: T16 + 100, tcSeconds: 1000 }), name: 'C0003.MP4' };
  copy.clock = { ...copy.clock!, source: 'container' };
  copy.tc = { ...copy.tc!, source: 'container' };
  const same = clip({ start: T16 + 500 });
  const twin = { ...same, id: 'twin', path: 'Y:/backup/' + same.name };
  const other = { ...clip({ start: T16 + 900 }), name: 'C0003.MP4', sizeBytes: 5e8 }; // то же имя, другой файл
  const cams = [camera('A', [copy, same, twin]), camera('B', [orig, other])];
  const dups = findDuplicates(cams);
  assert.deepEqual([...dups.values()].map((d) => `${d.cameraId}:${d.clipId}→${d.keptCameraId}:${d.keptClipId}`).sort(), [`A:${copy.id}→B:${orig.id}`, `A:twin→A:${same.id}`].sort());
  const r = runSync(cams);
  assert.ok(!r.placements.some((p) => p.clipId === copy.id || p.clipId === 'twin'));
  assert.ok(r.issues.some((i) => /копия клипа с дорожки «B»/.test(i.title)));
  assert.ok(r.issues.some((i) => /лежит в двух папках/.test(i.title)));
  assert.equal(pilePlacements(cams).filter((p) => p.cameraId === 'A').length, 1);
});

test('Чужой клип: снят камерой другой дорожки — стоит на своей дорожке, но по часам и тайм-коду своей камеры', () => {
  const a = freeRunClips([T16 + 10, T16 + 100, T16 + 200]);
  const b = freeRunClips([T16 + 20, T16 + 300], 1000);
  for (const c of b) c.camera = { make: 'Sony', model: 'Sony A7 III' };
  // Клип камеры B попал в папку A: свои часы и тайм-код B, а у A тайм-код убегает на 7:27:28.
  const stray = freeRunClips([T16 + 150], 1000)[0];
  stray.camera = { make: 'Sony', model: 'Sony A7 III' };
  const cams = [camera('A', [...a, stray]), camera('B', b, { manualShiftSec: 7 })];
  assert.equal(findStrays(cams, findDuplicates(cams)).get(`A|${stray.id}`)?.ownerId, 'B');
  const r = runSync(cams);
  const p = r.placements.find((x) => x.clipId === stray.id)!;
  assert.equal(p.cameraId, 'A');
  assert.equal(p.timeCameraId, 'B');
  const bFirst = r.placements.find((x) => x.clipId === b[0].id)!;
  assert.ok(Math.abs((p.start - bFirst.start) - 130) < 0.001, `пауза ${p.start - bFirst.start}`); // и ручной сдвиг B у него тоже
  assert.equal(r.cameras[0].timecodeJumps, 0);
  assert.ok(r.issues.some((i) => /снят камерой «B»/.test(i.title)));
  assert.ok(!r.issues.some((i) => /клипы с разных камер/.test(i.title)));
});
