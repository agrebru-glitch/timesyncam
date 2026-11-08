import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraGroups, splitByCamera } from '../src/core/split.ts';
import { initialState, newCamera, reducer } from '../src/renderer/state.ts';
import type { State } from '../src/renderer/state.ts';
import type { ClipMeta } from '../src/core/types.ts';
import { camera, clip, T16 } from './fixtures.ts';

const shot = (model: string, serial?: string, make = 'Sony', folder = 'X:/card') => {
  const c = clip({ start: T16 });
  c.camera = { make, model, ...(serial ? { serial } : {}) };
  c.path = `${folder}/${c.name}`;
  return c;
};
const many = (n: number, f: () => ClipMeta) => Array.from({ length: n }, f);

test('Камеры дорожки: по числу клипов, без серийного номера — к той же модели с номером, без сведений — к самой большой', () => {
  const a7 = many(5, () => shot('Sony A7 IV', '111'));
  const a7noSerial = many(2, () => shot('Sony A7 IV')); // потерялся XML
  const dji = many(3, () => shot('Osmo Action 5 Pro', undefined, 'DJI', 'X:/dji'));
  const wav = shot('');
  wav.camera = {};
  const groups = cameraGroups(camera('A', [...a7, ...dji, ...a7noSerial, wav]));
  assert.deepEqual(groups.map((g) => [g.label, g.clipIds.length]), [['Sony A7 IV', 8], ['DJI Osmo Action 5 Pro', 3]]);
  // Две камеры одной модели различаются серийным номером.
  const two = cameraGroups(camera('B', [...many(3, () => shot('Sony FX3', '1')), ...many(2, () => shot('Sony FX3', '2'))]));
  assert.deepEqual(two.map((g) => g.label), ['Sony FX3 · 1', 'Sony FX3 · 2']);
  // Одна камера — раскладывать нечего.
  assert.equal(cameraGroups(camera('C', a7)).length, 1);
});

test('Разложить по камерам: большая остаётся, остальные — на новые дорожки следом или на дорожку своей камеры', () => {
  const a7 = many(4, () => shot('Sony A7 IV', '111'));
  const dji = many(3, () => shot('Osmo Action 5 Pro', undefined, 'DJI', 'X:/dji'));
  const fx3 = many(2, () => shot('Sony FX3', '222'));
  const fx3Track = camera('FX3', many(5, () => shot('Sony FX3', '222')));
  const mixed = camera('Матч', [...a7, ...dji, ...fx3], { excludedClipIds: [dji[0].id, a7[0].id] });
  let n = 0;
  const { cameras, moved } = splitByCamera([mixed, fx3Track], 'Матч', (name) => ({ ...camera(`new${++n}`, []), name }));
  assert.deepEqual(cameras.map((c) => [c.name, c.clips.length]), [['Матч', 4], ['DJI Osmo Action 5 Pro', 3], ['FX3', 7]]);
  assert.equal(moved.size, 5);
  // Убранный клип остаётся убранным на новой дорожке; у старой — только свои.
  assert.deepEqual(cameras[1].excludedClipIds, [dji[0].id]);
  assert.deepEqual(cameras[0].excludedClipIds, [a7[0].id]);
  assert.deepEqual(cameras[1].folders, ['X:/dji']);
  // Имя занято — с номером.
  const again = splitByCamera([camera('DJI Osmo Action 5 Pro', []), camera('M', [...a7, ...dji])], 'M', (name) => ({ ...camera('x', []), name }));
  assert.equal(again.cameras[2].name, 'DJI Osmo Action 5 Pro (2)');
});

function withScan(state: State, cameraId: string, clips: ClipMeta[]): State {
  return reducer(state, { type: 'scan-done', cameraId, clips, folders: ['X:/card'], issues: [] });
}

test('Окно «разложить»: появляется на дорожке с разными камерами; «оставить» — не спрашивает снова, пока не появится новая камера', () => {
  const cam = newCamera(1);
  let s: State = { ...initialState, cameras: [cam] };
  s = withScan(s, cam.id, [...many(3, () => shot('Sony A7 IV')), ...many(2, () => shot('Sony A6700'))]);
  assert.equal(s.splitOffer, cam.id);
  s = reducer(s, { type: 'split-decline', cameraId: cam.id });
  assert.equal(s.splitOffer, null);
  // Добавили ещё клипы тех же камер — не спрашиваем.
  s = withScan(s, cam.id, [shot('Sony A7 IV')]);
  assert.equal(s.splitOffer, null);
  // Появилась третья камера — спрашиваем снова.
  s = withScan(s, cam.id, [shot('Osmo Action 5 Pro', undefined, 'DJI')]);
  assert.equal(s.splitOffer, cam.id);
  const v = s.version;
  s = reducer(s, { type: 'split-camera', cameraId: cam.id });
  assert.equal(s.splitOffer, null);
  assert.equal(s.cameras.length, 3);
  assert.ok(s.version > v);
  // Одна камера на дорожке — окна нет.
  const solo = newCamera(1);
  assert.equal(withScan({ ...initialState, cameras: [solo] }, solo.id, many(3, () => shot('Sony A7 IV'))).splitOffer, null);
});

test('Подсказка про контрольный кадр — один раз, когда клипы появились на третьей дорожке', () => {
  const cams = [newCamera(1), newCamera(2), newCamera(3), newCamera(4)];
  let s: State = { ...initialState, cameras: cams };
  s = withScan(s, cams[0].id, [shot('Sony A7 IV', '1')]);
  s = withScan(s, cams[1].id, [shot('Sony A7 IV', '2')]);
  assert.equal(s.controlHint, null, 'на второй дорожке подсказки нет');
  s = withScan(s, cams[2].id, [shot('Sony A7 IV', '3')]);
  assert.notEqual(s.controlHint, null, 'на третьей — есть');
  s = reducer(s, { type: 'control-hint-close' });
  s = withScan(s, cams[3].id, [shot('Sony A7 IV', '4')]);
  assert.equal(s.controlHint, null, 'второй раз не показывается');
  // И после «Очистить проект» — тоже.
  s = reducer(s, { type: 'clear-all' });
  assert.equal(s.controlHintShown, true);
});
