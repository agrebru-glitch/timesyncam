import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../src/core/sync.ts';
import { buildFcpxml } from '../src/core/fcpxml.ts';
import { buildFcp7Xml } from '../src/core/fcp7.ts';
import { END_GAP, moveToEnd, problemClips } from '../src/core/exportOptions.ts';
import type { AudioSyncResult } from '../src/core/audioSync.ts';
import { camera, clip, T16 } from './fixtures.ts';

const sec = (v: string) => {
  const m = /^(-?\d+)(?:\/(\d+))?s$/.exec(v)!;
  return Number(m[1]) / Number(m[2] ?? 1);
};

function scene() {
  const a1 = clip({ start: T16, durationSec: 60, recordedSec: 60 });
  const a2 = clip({ start: T16 + 100, durationSec: 60, recordedSec: 60 });
  const b1 = clip({ start: T16 + 10, durationSec: 40, recordedSec: 40 });
  const wav = clip({ start: T16 - 5, durationSec: 200, recordedSec: 200, hasVideo: false, rate: null, width: null, height: null });
  Object.assign(wav, { name: 'ZOOM0001.WAV', audioChannels: 2, audioSampleRate: 48000 });
  const cams = [camera('A', [a1, a2]), camera('B', [b1]), camera('Звук', [wav])];
  return { cams, sync: runSync(cams), a1, a2, b1, wav };
}

const audioWith = (unsure: AudioSyncResult['unsure']): AudioSyncResult => ({ cameras: [], corrections: {}, issues: [], unsure });

test('Опции экспорта: проблемные — ненайденные и без звука у неподтверждённого устройства, «по соседям» и «хуже кадра» — нет', () => {
  const { cams, a1, a2, b1, wav } = scene();
  const audio = audioWith({ [a1.id]: 'neighbours', [a2.id]: 'rough', [b1.id]: 'not-found', [wav.id]: 'no-sound' });
  const p = problemClips(cams, audio);
  // У «Звука» все клипы неточны и звука нет — его место ничем не подтверждено.
  assert.deepEqual([...p].sort(), [b1.id, wav.id].sort());
  // Клип без звука у камеры, другие клипы которой найдены, — не проблемный.
  assert.deepEqual([...problemClips(cams, audioWith({ [a1.id]: 'no-sound' }))], []);
  assert.equal(problemClips(cams, null).size, 0);
});

test('Опции экспорта: перенос в конец — подряд на своих дорожках, через 10 с после последнего клипа, остальные на местах', () => {
  const { sync, a2, b1 } = scene();
  const moved = moveToEnd(sync, new Set([b1.id, a2.id]));
  const stay = sync.placements.filter((p) => p.clipId !== b1.id && p.clipId !== a2.id);
  const end = Math.max(...stay.map((p) => p.end));
  for (const p of stay) assert.deepEqual(moved.placements.find((q) => q.clipId === p.clipId), p);
  const pa = moved.placements.find((p) => p.clipId === a2.id)!;
  const pb = moved.placements.find((p) => p.clipId === b1.id)!;
  assert.equal(pa.start, end + END_GAP);
  assert.equal(pb.start, end + END_GAP);
  assert.equal(pa.cameraId, 'A');
  assert.equal(pb.end - pb.start, 40);
  assert.equal(moved.end, Math.max(pa.end, pb.end));
  assert.equal(moveToEnd(sync, new Set()), sync);
});

test('Опции экспорта: без звука камер — в FCPXML у видео только картинка, в XML нет дорожек звука камер', () => {
  const { cams, sync } = scene();
  const opts = { name: 'T', rate: { num: 25, den: 1 }, width: 1920, height: 1080 };
  const on = buildFcpxml(cams, sync, opts);
  const off = buildFcpxml(cams, sync, { ...opts, cameraAudio: false });
  assert.ok(!/srcEnable/.test(on));
  // Три клипа камер на таймлинии и три в браузере; srcEnable — только на таймлинии.
  assert.equal([...off.matchAll(/<asset-clip [^>]*lane="[1-9][^>]*srcEnable="video"/g)].length, 3);
  assert.ok(![...off.matchAll(/<asset-clip [^>]*name="ZOOM0001.WAV"[^>]*>/g)].some((m) => /srcEnable/.test(m[0])));

  const x7on = buildFcp7Xml(cams, sync, opts);
  const x7off = buildFcp7Xml(cams, sync, { ...opts, cameraAudio: false });
  const audioTracks = (x: string) => [...x.matchAll(/<outputchannelindex>/g)].length;
  assert.ok(audioTracks(x7on) > audioTracks(x7off));
  assert.equal(audioTracks(x7off), 2); // стерео рекордера — две дорожки
});

test('Опции экспорта: мультикам — ракурс на дорожку, клипы подряд с промежутками, на таймлинии один мультикам-клип', () => {
  const { cams, sync, a1, a2 } = scene();
  const xml = buildFcpxml(cams, sync, { name: 'T', rate: { num: 25, den: 1 }, width: 1920, height: 1080, multicam: true });
  const media = /<media id="mc1"[\s\S]*?<\/media>/.exec(xml)![0];
  const angles = [...media.matchAll(/<mc-angle name="([^"]+)" angleID="([^"]+)">([\s\S]*?)<\/mc-angle>/g)];
  assert.deepEqual(angles.map((m) => m[1]), ['A', 'B', 'Звук']);
  // В ракурсе A: клип, промежуток, клип — встык друг к другу.
  const partsA = [...angles[0][3].matchAll(/<(asset-clip|gap) [^>]*offset="([^"]+)"[^>]*duration="([^"]+)"/g)].map((m) => ({ kind: m[1], off: sec(m[2]), dur: sec(m[3]) }));
  for (let i = 1; i < partsA.length; i++) assert.ok(Math.abs(partsA[i].off - (partsA[i - 1].off + partsA[i - 1].dur)) < 1e-9, JSON.stringify(partsA));
  const pa1 = sync.placements.find((p) => p.clipId === a1.id)!;
  const pa2 = sync.placements.find((p) => p.clipId === a2.id)!;
  const clipsA = partsA.filter((p) => p.kind === 'asset-clip');
  assert.ok(Math.abs(clipsA[1].off - clipsA[0].off - Math.round((pa2.start - pa1.start) * 25) / 25) < 1e-9);
  assert.ok(!/ lane="/.test(media));
  // На таймлинии — только мультикам-клип: картинка с A, звук с рекордера.
  const spine = /<spine>([\s\S]*?)<\/spine>/.exec(xml)![1];
  assert.match(spine, /^\s*<mc-clip ref="mc1"[^>]*><mc-source angleID="angle-v1" srcEnable="video"\/><mc-source angleID="angle-a1" srcEnable="audio"\/><\/mc-clip>\s*$/);
  assert.ok(!/<asset-clip/.test(spine));
});
