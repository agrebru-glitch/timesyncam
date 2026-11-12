import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioByChannel, channelLabels, laneKey, laneName } from '../src/core/channels.ts';
import type { Placement } from '../src/core/types.ts';
import { camera, clip, T16 } from './fixtures.ts';

const wav = (name: string) => Object.assign(clip({ start: T16, durationSec: 60, recordedSec: 60, hasVideo: false, rate: null, frames: null, width: null, height: null, audioChannels: 1 }), { name });

test('Каналы рекордера: каждая строка — свой канал с подписью, звук предпросмотра — по каналам', () => {
  const tr1 = wav('ZOOM0001_Tr1.WAV');
  const tr2 = wav('ZOOM0001_Tr2.WAV');
  const rec = camera('Подкаст', [tr1, tr2]);
  const placements: Placement[] = [
    { clipId: tr1.id, cameraId: rec.id, start: 100, end: 160, method: 'clock', lane: 0 },
    { clipId: tr2.id, cameraId: rec.id, start: 100, end: 160, method: 'clock', lane: 1 },
  ];
  assert.deepEqual([...channelLabels(rec, placements)], [[0, 'Tr1'], [1, 'Tr2']]);
  assert.equal(laneName(rec, placements, 1), 'Подкаст · Tr2');
  const a = audioByChannel([rec], placements);
  assert.deepEqual(a.cameras.map((c) => c.id), [rec.id, laneKey(rec.id, 1)]);
  assert.equal(a.placements.find((p) => p.clipId === tr2.id)!.cameraId, `${rec.id}#1`);
  assert.equal(a.placements.find((p) => p.clipId === tr1.id)!.cameraId, rec.id);
  // Камера с видео: вторая строка — наложение клипов, а не канал.
  const v = clip({ start: T16, durationSec: 60, recordedSec: 60 });
  const cam = camera('Камера', [v]);
  assert.equal(channelLabels(cam, [{ clipId: v.id, cameraId: cam.id, start: 0, end: 60, method: 'clock', lane: 1 }]).size, 0);
  // Одна строка — не каналы.
  assert.equal(channelLabels(rec, placements.slice(0, 1)).size, 0);
});
