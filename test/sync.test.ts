import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRelocation, findDuplicates, findStrays, pilePlacements, planRelocation, relocateFrames, relocationIssues, runSync, sessionGroup } from '../src/core/sync.ts';
import { buildFcp7Xml, defaultTimelineRate } from '../src/core/fcp7.ts';
import { camera, clip, T16 } from './fixtures.ts';
import { parseTc, tcToSeconds } from '../src/core/timecode.ts';

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
  clips[1].path = 'D:\\Съёмка 27_10\\C9152.MP4';
  const cam = camera('Камера 1', clips);
  const r = runSync([cam]);
  const rate = defaultTimelineRate([cam]);
  assert.deepEqual(rate, { num: 25, den: 1 });
  const xml = buildFcp7Xml([cam], r, { name: 'Тест & проверка', rate, width: 3840, height: 2160 });
  assert.match(xml, /<sequence[\s\S]*?<timecode>[\s\S]*?<string>00:00:00:00<\/string><frame>0<\/frame>/);
  assert.match(xml, /file:\/\/localhost\/D:\/%D0%A1%D1%8A%D1%91%D0%BC%D0%BA%D0%B0%2027_10\/C9151\.MP4/);
  assert.match(xml, /Тест &amp; проверка/);
  const seq = xml.slice(xml.indexOf('<sequence'));
  assert.equal((seq.match(/<track[ >]/g) ?? []).length, 3); // видео + 2 канала звука
  // Два канала камеры — стереодорожка для Premiere, а не два моно.
  assert.equal((seq.match(/premiereTrackType="Stereo"/g) ?? []).length, 2);
  assert.match(seq, /currentExplodedTrackIndex="0"[^>]*totalExplodedTrackCount="2"/);
  assert.match(seq, /premiereChannelType="stereo"/);
  // Корзина дорожки с мастер-клипами, как у PluralEyes; каждый файл описан один раз, секвенция ссылается на него.
  assert.match(xml, /<project>\s*<name>Тест &amp; проверка<\/name>\s*<children>\s*<bin><name>Камера 1<\/name><children><clip id="masterclip-1"/);
  assert.equal((xml.match(/<pathurl>/g) ?? []).length, 2);
  assert.match(seq, /<masterclipid>masterclip-1<\/masterclipid>/);
  const starts = [...seq.matchAll(/<start>(\d+)<\/start>/g)].map((m) => Number(m[1]));
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

test('Одноимённые записи разных камер — не копии, даже если размер совпал до байта', () => {
  const named = (over: Parameters<typeof clip>[0]) => ({ ...clip(over), name: 'C0003.MP4' });
  const a = named({ start: T16 + 100, tcSeconds: 1000, camera: { make: 'Sony', model: 'Sony A7 IV', serial: '111' } });
  const otherTc = named({ start: T16 + 100, tcSeconds: 5000, camera: { make: 'Sony', model: 'Sony A7 IV', serial: '111' } });
  const otherSerial = named({ start: T16 + 100, tcSeconds: 1000, camera: { make: 'Sony', model: 'Sony A7 IV', serial: '222' } });
  const otherLength = named({ start: T16 + 100, tcSeconds: 1000, durationSec: 12, frames: 300 });
  const otherFormat = named({ start: T16 + 100, tcSeconds: 1000, rate: { num: 50, den: 1 }, frames: 500 });
  const cams = [camera('A', [a]), camera('B', [otherTc]), camera('C', [otherSerial]), camera('D', [otherLength]), camera('E', [otherFormat])];
  assert.equal(findDuplicates(cams).size, 0);
  assert.deepEqual(planRelocation(cams), { moves: [], drops: [] });
  // Та же запись: у копии без XML длина из MP4 на кадр короче, серийного номера нет — это всё равно копия.
  const copy = { ...a, id: 'copy', path: 'Y:/cam2/C0003.MP4', durationSec: 9.96, frames: 249, camera: { make: 'Sony', model: 'Sony A7 IV' } };
  assert.deepEqual([...findDuplicates([camera('A', [a]), camera('B', [copy])]).keys()], ['B|copy']);
});

test('Перенос по дорожкам: клип другой камеры переезжает на её дорожку, копия уходит к оригиналу', () => {
  const a = freeRunClips([T16 + 10, T16 + 100, T16 + 200]);
  const b = freeRunClips([T16 + 20, T16 + 300], 1000);
  for (const c of b) c.camera = { make: 'Sony', model: 'Sony A7 III' };
  const stray = freeRunClips([T16 + 150], 1000)[0];
  stray.camera = { make: 'Sony', model: 'Sony A7 III' };
  stray.name = 'C0000.MP4';
  const copy = { ...b[1], id: 'copy', path: 'X:/cam1/' + b[1].name };
  copy.clock = { ...copy.clock!, source: 'container' };
  copy.tc = { ...copy.tc!, source: 'container' };
  const cams = [camera('A', [...a, stray, copy]), camera('B', b, { manualShiftSec: 7 })];
  const plan = planRelocation(cams);
  assert.deepEqual(plan.moves.map((m) => `${m.cameraId}:${m.clipId}→${m.ownerId}`), [`A:${stray.id}→B`]);
  assert.deepEqual(plan.drops.map((d) => `${d.cameraId}:${d.clipId}→${d.keptCameraId}`), ['A:copy→B']);
  const moved = applyRelocation(cams, plan);
  assert.deepEqual(moved[0].clips.map((c) => c.id), a.map((c) => c.id));
  assert.deepEqual(moved[1].clips.map((c) => c.id), [...b.map((c) => c.id), stray.id]);
  assert.equal(moved[1].manualShiftSec, 7);
  assert.deepEqual(planRelocation(moved), { moves: [], drops: [] }); // второй раз переносить нечего
  // Папку A добавили ещё раз — файл снова на её дорожке: он убирается оттуда, на дорожке B остаётся как был.
  const again = moved.map((c) => (c.id === 'A' ? { ...c, clips: [...c.clips, stray] } : c));
  const replan = planRelocation(again);
  assert.deepEqual(replan.moves, []);
  assert.deepEqual(replan.drops.map((d) => `${d.cameraId}:${d.clipId}→${d.keptCameraId}:${d.keptClipId}`), [`A:${stray.id}→B:${stray.id}`]);
  assert.deepEqual(applyRelocation(again, replan).map((c) => c.clips.map((x) => x.id)), moved.map((c) => c.clips.map((x) => x.id)));

  const issues = relocationIssues(cams, plan);
  assert.ok(issues.some((i) => i.cameraId === 'B' && /Перенесён на дорожку «B»: C0000\.MP4/.test(i.title) && /в папке «A»/.test(i.details!)));
  assert.ok(issues.some((i) => i.cameraId === 'A' && /копия клипа с дорожки «B»/.test(i.title)));

  const r = runSync(moved);
  const p = r.placements.find((x) => x.clipId === stray.id)!;
  assert.equal(p.cameraId, 'B');
  assert.equal(p.timeCameraId, undefined);
  const bFirst = r.placements.find((x) => x.clipId === b[0].id)!;
  assert.ok(Math.abs((p.start - bFirst.start) - 130) < 0.001, `пауза ${p.start - bFirst.start}`);
  assert.ok(!r.placements.some((x) => x.clipId === 'copy'));
  assert.ok(!r.issues.some((i) => /снят камерой|копия клипа/.test(i.title)));
  assert.equal(r.cameras.find((c) => c.cameraId === 'A')!.timecodeJumps, 0);

  // Контрольный кадр едет вместе с клипом, а с убранной копии — на оставшийся экземпляр.
  const frames = relocateFrames({
    [stray.id]: { cameraId: 'A', clipId: stray.id, localSec: 2 },
    copy: { cameraId: 'A', clipId: 'copy', localSec: 3 },
    [a[0].id]: { cameraId: 'A', clipId: a[0].id, localSec: 1 },
  }, plan);
  assert.deepEqual(frames, {
    [stray.id]: { cameraId: 'B', clipId: stray.id, localSec: 2 },
    [b[1].id]: { cameraId: 'B', clipId: b[1].id, localSec: 3 },
    [a[0].id]: { cameraId: 'A', clipId: a[0].id, localSec: 1 },
  });
});

test('Клип своей камеры без XML не уезжает на дорожку другой камеры той же модели', () => {
  const sony = (serial?: string) => ({ make: 'Sony', model: 'Sony A7 IV', ...(serial ? { serial } : {}) });
  const a = freeRunClips([T16 + 10, T16 + 100, T16 + 200]);
  for (const c of a) c.camera = sony('111');
  const lost = freeRunClips([T16 + 300])[0];
  lost.camera = sony(); // XML потерялся: модель из MP4, серийного номера нет
  const b = freeRunClips([T16 + 20, T16 + 300], 1000);
  for (const c of b) c.camera = sony(); // вторая A7 IV, скинутая без XML
  const cams = [camera('A', [...a, lost]), camera('B', b)];
  assert.equal(findStrays(cams, findDuplicates(cams)).size, 0);
  // Клип с серийным номером другой A7 IV — переезжает, если у дорожки номер свой.
  const strayB = freeRunClips([T16 + 400], 1000)[0];
  strayB.camera = sony('222');
  const b2 = freeRunClips([T16 + 30, T16 + 500], 1000);
  for (const c of b2) c.camera = sony('222');
  assert.deepEqual(planRelocation([camera('A', [...a, strayB]), camera('B', b2)]).moves.map((m) => m.ownerId), ['B']);
  // А у дорожки A номеров нет вовсе — её клипы могут быть той же камерой 222: не угадываем.
  const plainA = b.map((c) => ({ ...c, id: c.id + 'a', path: c.path + 'a' }));
  assert.equal(planRelocation([camera('A', [...plainA, strayB]), camera('B', b2)]).moves.length, 0);
});

test('Согласие дат: большинство решает, когда была съёмка, при равенстве — более поздняя дата', () => {
  const day = 86400;
  const r = (cameraId: string, start: number, weight = 2) => ({ cameraId, start, end: start + 3600, weight });
  // Три камеры в один вечер, рекордер — в 2010 году.
  assert.deepEqual([...sessionGroup([r('A', T16), r('B', T16 + 600), r('C', T16 + 7200), r('Z', T16 - 6112 * day, 1.5)])].sort(), ['A', 'B', 'C']);
  // Один на один: верим поздней дате — сбитые часы уходят в прошлое.
  assert.deepEqual([...sessionGroup([r('A', T16), r('Z', T16 - 6112 * day)])], ['A']);
  // Камера на сутки вперёд — уже не та съёмка.
  assert.deepEqual([...sessionGroup([r('A', T16), r('B', T16 + 300), r('C', T16 + day + 3600)])].sort(), ['A', 'B']);
});

test('Рекордер с датой 2010 года и тайм-кодом по ней не становится опорой и не растягивает съёмку на годы', () => {
  const cams = [
    camera('A', freeRunClips([T16 + 10, T16 + 900], 0)),
    camera('B', freeRunClips([T16 + 40, T16 + 950])),
    // Тайм-код рекордера равен его часам — раньше это считалось «точным тайм-кодом».
    camera('Zoom', [clip({ start: T16 - 6112 * 86400 + 5, tcSeconds: wall(T16 - 6112 * 86400 + 5), hasVideo: false })]),
  ];
  const r = runSync(cams);
  const zoom = r.cameras.find((c) => c.cameraId === 'Zoom')!;
  assert.ok(zoom.dateOutlierSec !== null && zoom.dateOutlierSec < -6000 * 86400);
  assert.ok(r.end - r.start < 3 * 3600, `съёмка растянута на ${((r.end - r.start) / 86400).toFixed(0)} дн`);
  assert.ok(r.issues.some((i) => i.cameraId === 'Zoom' && /дата на устройстве/.test(i.title)));
  // О часовых поясах и «другом дне» по отношению к рекордеру не говорим — у него своя запись.
  assert.ok(!r.issues.some((i) => /расходятся с «Zoom»|чем «Zoom»/.test(i.title)));
});

// Метка тайм-кода 29,97 DF для момента sec от полуночи — как её пишет камера, но без «;»: так тайм-код Sony
// выглядит в контейнере MP4, когда XML потерялся.
function dfLabel(sec: number): string {
  let n = Math.round((sec * 30000) / 1001);
  const d = Math.floor(n / 17982);
  const m = n % 17982;
  n += 18 * d + (m > 2 ? 2 * Math.floor((m - 2) / 1798) : 0);
  const two = (x: number) => String(x).padStart(2, '0');
  return `${two(Math.floor(n / 108000) % 24)}:${two(Math.floor(n / 1800) % 60)}:${two(Math.floor(n / 30) % 60)}:${two(n % 30)}`;
}

test('Тайм-код 29,97 без пометки DF: камера Sony без XML не распадается на отрезки, паузы точны до кадра', () => {
  const fps = 30000 / 1001;
  // Free Run, тайм-код на 5000 с впереди часов; клипы через час с лишним, как на концерте тестера.
  const reals = [T16 + 0.37, T16 + 4059.59 + 0.37, T16 + 9000.81];
  const mk = (real: number, make: string, label: (s: number) => string) => {
    const text = label((wall(real) + 5000) % 86400);
    const seconds = tcToSeconds({ ...parseTc(text)!, drop: false }, 30, fps); // как прочитает файл без пометки
    return clip({ start: Math.floor(real), rate: { num: 30000, den: 1001 }, tc: { text, seconds, countRate: 30, drop: false, source: 'container' }, camera: { make, model: make } });
  };
  const sony = reals.map((r) => mk(r, 'Sony', dfLabel));
  const s = runSync([camera('A', sony)]);
  assert.equal(s.cameras[0].timecodeJumps, 0);
  const at = (id: string) => s.placements.find((p) => p.clipId === id)!.start;
  for (let i = 1; i < reals.length; i++) {
    const err = at(sony[i].id) - at(sony[0].id) - (reals[i] - reals[0]);
    assert.ok(Math.abs(err) < 1 / 30, `клип ${i}: ${(err * 1000).toFixed(0)} мс`);
  }
  // Настоящий NDF у другой камеры так и читается как NDF.
  const ndfLabel = (sec: number) => {
    const n = Math.round((sec * 30000) / 1001);
    const two = (x: number) => String(x).padStart(2, '0');
    return `${two(Math.floor(n / 108000) % 24)}:${two(Math.floor(n / 1800) % 60)}:${two(Math.floor(n / 30) % 60)}:${two(n % 30)}`;
  };
  const canon = reals.map((r) => mk(r, 'Canon', ndfLabel));
  const c = runSync([camera('B', canon)]);
  assert.equal(c.cameras[0].timecodeJumps, 0);
  const atC = (id: string) => c.placements.find((p) => p.clipId === id)!.start;
  for (let i = 1; i < reals.length; i++) assert.ok(Math.abs(atC(canon[i].id) - atC(canon[0].id) - (reals[i] - reals[0])) < 1 / 30);
});

test('Даты файлов — время копирования: тайм-код рекордера не рвётся на отрезки, паузы — по тайм-коду', () => {
  // BWF-тайм-код по часам рекордера, дат в метаданных нет; файлы скопированы через 2 с друг за другом,
  // поэтому по датам файлов записи накладываются.
  const copied = T16 + 2 * 86400;
  const lengths = [7456.085, 2143.048];
  const recs = [0, 7457].map((at, i) => {
    const c = clip({ start: copied + i * 2 - lengths[i], tcSeconds: 29110 + at, durationSec: lengths[i], recordedSec: lengths[i], hasVideo: false, rate: null, width: null, height: null });
    Object.assign(c, { clock: { ...c.clock!, source: 'file', precisionSec: 3 } });
    return c;
  });
  const s = runSync([camera('Zoom', recs)]);
  assert.equal(s.cameras[0].timecodeJumps, 0);
  const at = (id: string) => s.placements.find((p) => p.clipId === id)!.start;
  assert.ok(Math.abs(at(recs[1].id) - at(recs[0].id) - 7457) < 0.001);
  assert.equal(new Set(s.placements.map((p) => p.segment)).size, 1);
});

test('Расхождение «часы − тайм-код» около 12 часов: ни один клип не уезжает на сутки', () => {
  // Как у CAM 03 на концерте, когда даты файлов — время копирования: тайм-код 22:50 и 23:57,
  // файлы скопированы в полдень. Расхождение у первого клипа −11,6 ч, у второго перешло бы через −12 ч.
  const noon = T16 - 4 * 3600 + 2 * 86400; // 12:00 по Москве через двое суток
  const lengths = [2932.43, 4460.46];
  const tcs = [82201.59, 86248.36];
  const cams = lengths.map((len, i) => {
    const c = clip({ start: noon + i * 2 - len, tcSeconds: tcs[i], durationSec: len, recordedSec: len });
    Object.assign(c, { clock: { ...c.clock!, source: 'file', precisionSec: 3 } });
    return c;
  });
  const s = runSync([camera('CAM 03', cams)]);
  const at = (id: string) => s.placements.find((p) => p.clipId === id)!.start;
  assert.ok(Math.abs(at(cams[1].id) - at(cams[0].id) - (tcs[1] - tcs[0])) < 0.001, `${at(cams[1].id) - at(cams[0].id)}`);
});

test('Камеры с датами копирования не перевешивают одно устройство с верной датой', () => {
  // Три камеры без дат в метаданных: время — из дат файлов, а это время копирования через двое суток,
  // и по нему клипы каждой камеры накладываются. Петличка — с временем из имени файла.
  const copiedAt = T16 + 2 * 86400;
  const cams = ['CAM 01', 'CAM 02', 'CAM 03'].map((name) => camera(name, [3000, 4400].map((len, i) => {
    const c = clip({ start: copiedAt + i * 2 - len, durationSec: len, recordedSec: len });
    Object.assign(c, { clock: { ...c.clock!, source: 'file', precisionSec: 3 } });
    return c;
  })));
  const lav = clip({ start: T16, durationSec: 1800, recordedSec: 1800, hasVideo: false, rate: null, width: null, height: null });
  Object.assign(lav, { clock: { ...lav.clock!, source: 'filename' } });
  const s = runSync([...cams, camera('Петличка', [lav])]);
  assert.equal(s.cameras.find((c) => c.cameraId === 'Петличка')!.dateOutlierSec, null);
  for (const name of ['CAM 01', 'CAM 02', 'CAM 03']) {
    assert.notEqual(s.cameras.find((c) => c.cameraId === name)!.dateOutlierSec, null);
    assert.ok(s.issues.some((i) => i.cameraId === name && /время копирования/.test(i.title)));
  }
  // До сверки по звуку всё лежит у начала съёмки, а не через двое суток.
  assert.ok(s.end - s.start < 3 * 3600);
});

test('Корзины проекта — как папки: клипы дорожки из разных подпапок лежат во вложенных корзинах', () => {
  // Три камеры в одной папке карты, как «Cam 33» у тестера: подпапки CLIP1 и CLIP2.
  const clips = freeRunClips([T16, T16 + 600, T16 + 1200]);
  clips[0].path = 'G:/Съёмка/CLIP1/C9167.MP4';
  clips[1].path = 'G:/Съёмка/CLIP1/C9168.MP4';
  clips[2].path = 'G:/Съёмка/CLIP2/C8908.MP4';
  const cam = camera('Cam 33', clips);
  const xml = buildFcp7Xml([cam], runSync([cam]), { name: 'Концерт', rate: { num: 25, den: 1 }, width: 3840, height: 2160 });
  assert.match(xml, /<bin><name>Cam 33<\/name><children><bin><name>CLIP1<\/name><children><clip id="masterclip-1"[\s\S]*?<clip id="masterclip-2"[\s\S]*?<\/children><\/bin><bin><name>CLIP2<\/name><children><clip id="masterclip-3"/);
});


test('Две камеры в одной папке и смена карты: каждая камера на своей дорожке, наложения не считаются ошибкой', () => {
  // Камеры пишут файлами по 535 с встык; у второй третий файл — после смены карты, тайм-код тот же Free Run.
  const x = freeRunClips([T16, T16 + 535, T16 + 1070], 1000);
  const y = freeRunClips([T16 + 30, T16 + 565, T16 + 2000], 20000);
  for (const c of [...x, ...y]) Object.assign(c, { durationSec: 535, recordedSec: 535 });
  const s = runSync([camera('Cam 33', [...x, ...y])]);
  assert.ok(!s.issues.some((i) => /накладываются/.test(i.title)), s.issues.map((i) => i.title).join('; '));
  const laneOf = (id: string) => s.placements.find((p) => p.clipId === id)!.lane;
  assert.ok(x.every((c) => laneOf(c.id) === laneOf(x[0].id)));
  assert.ok(y.every((c) => laneOf(c.id) === laneOf(y[0].id)), `${y.map((c) => laneOf(c.id))}`);
  assert.notEqual(laneOf(x[0].id), laneOf(y[0].id));
});
