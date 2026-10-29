import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../src/core/sync.ts';
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

test('Смена форматов внутри камеры (25p, 50p, 1080) — без замечаний', () => {
  const clips = freeRunClips([T16 + 10, T16 + 100, T16 + 300]);
  clips[1].rate = { num: 50, den: 1 };
  clips[2].width = 1920;
  clips[2].height = 1080;
  const r = runSync([camera('A', clips)]);
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

test('Экспорт XML: дорожка на камеру, тайм-код таймлинии = время суток, путь с кириллицей', () => {
  const clips = freeRunClips([T16 + 181.08, T16 + 213.84]);
  clips[0].path = 'D:\\Съёмка 27_10\\C9151.MP4';
  clips[0].name = 'C9151.MP4';
  const cam = camera('Камера 1', clips);
  const r = runSync([cam]);
  const rate = defaultTimelineRate([cam]);
  assert.deepEqual(rate, { num: 25, den: 1 });
  const xml = buildFcp7Xml([cam], r, { name: 'Тест & проверка', rate, width: 3840, height: 2160 });
  assert.match(xml, /<string>16:03:00:00<\/string>/);
  assert.match(xml, /file:\/\/localhost\/D:\/%D0%A1%D1%8A%D1%91%D0%BC%D0%BA%D0%B0%2027_10\/C9151\.MP4/);
  assert.match(xml, /Тест &amp; проверка/);
  assert.equal((xml.match(/<track>/g) ?? []).length, 3); // видео + 2 канала звука
  const starts = [...xml.matchAll(/<start>(\d+)<\/start>/g)].map((m) => Number(m[1]));
  assert.equal(starts[0], Math.round((r.placements[0].start - (T16 + 180)) * 25));
});
