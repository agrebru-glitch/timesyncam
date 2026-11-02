import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignByAudio } from '../src/core/align.ts';
import { runSync } from '../src/core/sync.ts';
import type { Camera } from '../src/core/types.ts';
import { camera, clip, T16 } from './fixtures.ts';
import { fakeAudio } from './sound.ts';

const tcOf = (epoch: number) => (((epoch + 3 * 3600) % 86400) + 86400) % 86400;
const opts = { searchSec: 30, maxAnchors: 8, isEnabled: () => true };

// Камера с тайм-кодом весь час и телефон без тайм-кода: четыре ролика разной длины со звуком и один — без общего
// звука. Часы телефона спешат на 3,4 с; end — пишет ли он в файл время остановки записи, а не начала.
function scene(end: boolean) {
  const truth = new Map<string, number>();
  const cam = clip({ start: T16, tcSeconds: tcOf(T16), durationSec: 1200, recordedSec: 1200 });
  truth.set(cam.id, T16);
  const takes = [[50.3, 40], [150.7, 200], [420.1, 25], [600.9, 120], [800.4, 70]].map(([at, dur]) => {
    const c = clip({ start: Math.floor(T16 + at + (end ? dur : 0) + 3.4), durationSec: dur, recordedSec: dur, camera: { make: 'realme', model: 'Android' } });
    truth.set(c.id, T16 + at);
    return c;
  });
  return { truth, cam, takes, silent: takes[4] };
}

async function run(cams: Camera[], truth: Map<string, number>, silentId: string) {
  const result = await alignByAudio(cams, runSync(cams), fakeAudio(truth, new Set([silentId])), opts);
  const final = runSync(cams, result.corrections);
  const at = (id: string) => final.placements.find((p) => p.clipId === id)!.start;
  return { result, at };
}

test('Часы телефона — конец записи: видно по роликам, совпавшим по звуку; ролик без звука встаёт с учётом длины', async () => {
  const { truth, cam, takes, silent } = scene(true);
  const { result, at } = await run([camera('Камера', [cam]), camera('Телефон', takes)], truth, silent.id);
  const err = at(silent.id) - at(cam.id) - (truth.get(silent.id)! - T16);
  assert.ok(Math.abs(err) < 1, `ролик без звука мимо на ${err.toFixed(2)} с`);
  for (const t of takes.slice(0, 4)) assert.ok(Math.abs(at(t.id) - at(cam.id) - (truth.get(t.id)! - T16)) < 0.002);
  assert.ok(result.issues.some((i) => i.cameraId === 'Телефон' && /конец записи/.test(i.title)), result.issues.map((i) => i.title).join('; '));
  // Порядок дорожек ответа не меняет.
  const back = await run([camera('Телефон', takes), camera('Камера', [cam])], truth, silent.id);
  assert.ok(Math.abs(back.at(silent.id) - back.at(cam.id) - (at(silent.id) - at(cam.id))) < 0.001);
});

test('Часы телефона — начало записи (как у realme): всё по-прежнему, без лишнего сообщения', async () => {
  const { truth, cam, takes, silent } = scene(false);
  const { result, at } = await run([camera('Камера', [cam]), camera('Телефон', takes)], truth, silent.id);
  const err = at(silent.id) - at(cam.id) - (truth.get(silent.id)! - T16);
  assert.ok(Math.abs(err) < 1, `ролик без звука мимо на ${err.toFixed(2)} с`);
  assert.ok(!result.issues.some((i) => /конец записи/.test(i.title)));
});
