import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackOrder } from '../src/core/trackOrder.ts';
import { runSync } from '../src/core/sync.ts';
import { buildFcp7Xml } from '../src/core/fcp7.ts';
import { buildFcpxml } from '../src/core/fcpxml.ts';
import type { ClipMeta } from '../src/core/types.ts';
import { camera, clip, T16 } from './fixtures.ts';

const named = (name: string, over: Parameters<typeof clip>[0]): ClipMeta => Object.assign(clip(over), { name });
const sound = (name: string, start: number, dur: number) =>
  Object.assign(named(name, { start, durationSec: dur, recordedSec: dur, hasVideo: false, rate: null, width: null, height: null }), { audioChannels: 1, audioSampleRate: 48000 });

// Лекция: основная камера пишет почти всё время, вторая — вставки, рекордер и петличка — звук.
function scene() {
  const main = camera('Основная', [named('MAIN1.MP4', { start: T16, durationSec: 600, recordedSec: 600 })]);
  const side = camera('Вставки', [named('SIDE1.MP4', { start: T16 + 60, durationSec: 40, recordedSec: 40 }), named('SIDE2.MP4', { start: T16 + 300, durationSec: 30, recordedSec: 30 })]);
  const rec = camera('Рекордер', [sound('REC.WAV', T16 - 10, 700)]);
  const lav = camera('Петличка', [sound('LAV.WAV', T16 + 100, 200)]);
  const empty = camera('Пустая', []);
  return { cams: [rec, main, empty, lav, side], main, side, rec, lav, empty };
}

test('Порядок дорожек: сверху — меньше материала, звук — под камерами по тому же правилу, пустые — внизу', () => {
  const s = scene();
  assert.deepEqual(trackOrder(s.cams).map((c) => c.name), ['Вставки', 'Основная', 'Петличка', 'Рекордер', 'Пустая']);
  // Исключённые клипы не считаются: у основной камеры осталось 0 с — она выше вставок.
  const main = { ...s.main, excludedClipIds: [s.main.clips[0].id] };
  assert.deepEqual(trackOrder([main, s.side]).map((c) => c.name), ['Основная', 'Вставки']);
  // При равном количестве — порядок проекта.
  const a = camera('А', [named('A.MP4', { start: T16, durationSec: 10, recordedSec: 10 })]);
  const b = camera('Б', [named('B.MP4', { start: T16, durationSec: 10, recordedSec: 10 })]);
  assert.deepEqual(trackOrder([b, a]).map((c) => c.name), ['Б', 'А']);
});

test('Порядок дорожек в экспорте: V1 — камера с наибольшим количеством материала, звук сверху вниз — от меньшего к большему', () => {
  const s = scene();
  const sync = runSync(s.cams);
  const opts = { name: 'T', rate: { num: 25, den: 1 }, width: 1920, height: 1080 };

  // XML (Premiere, Resolve): V1 — нижняя дорожка.
  const x7 = buildFcp7Xml(s.cams, sync, opts);
  // Дорожки таймлинии — в <sequence>; выше, в корзинах, у каждого клипа свои <video> и <audio>.
  const seq = x7.slice(x7.indexOf('<sequence'));
  const section = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(seq)![1];
  const tracks = (xml: string) => [...xml.matchAll(/<track[ >][\s\S]*?<\/track>/g)].map((m) => [...new Set([...m[0].matchAll(/<name>([^<]+\.(?:MP4|WAV))<\/name>/g)].map((n) => n[1]))].join(','));
  assert.deepEqual(tracks(section('video')), ['MAIN1.MP4', 'SIDE1.MP4,SIDE2.MP4']);
  const audio = tracks(section('audio'));
  const first = (name: string) => audio.findIndex((t) => t.includes(name));
  assert.ok(first('SIDE1.MP4') < first('MAIN1.MP4') && first('MAIN1.MP4') < first('LAV.WAV') && first('LAV.WAV') < first('REC.WAV'), audio.join(' | '));

  // FCPXML: lane 1 — ближе всех к основной (ниже всех), звук без видео — под ней, −1 сверху.
  const fx = buildFcpxml(s.cams, sync, opts);
  const laneOf = (name: string) => Number(new RegExp(`<asset-clip [^>]*lane="(-?\\d+)"[^>]*name="${name.replace('.', '\\.')}"`).exec(fx)![1]);
  assert.equal(laneOf('MAIN1.MP4'), 1);
  assert.equal(laneOf('SIDE1.MP4'), 2);
  assert.equal(laneOf('SIDE2.MP4'), 2);
  assert.equal(laneOf('LAV.WAV'), -1);
  assert.equal(laneOf('REC.WAV'), -2);
});

test('XML для DaVinci: звук парами к видео — A1 у камеры на V1, дальше вверх по видео, рекордеры ниже всех; для Premiere — как было', () => {
  const s = scene();
  const sync = runSync(s.cams);
  const opts = { name: 'T', rate: { num: 25, den: 1 }, width: 1920, height: 1080 };
  const audioOf = (xml: string) => {
    const seq = xml.slice(xml.indexOf('<sequence'));
    const audio = /<audio>([\s\S]*?)<\/audio>\s*<\/media>/.exec(seq)![1];
    return [...audio.matchAll(/<track[ >][\s\S]*?<\/track>/g)].map((m) => [...new Set([...m[0].matchAll(/<name>([^<]+\.(?:MP4|WAV))<\/name>/g)].map((n) => n[1]))].join(','));
  };
  const resolve = audioOf(buildFcp7Xml(s.cams, sync, { ...opts, audioOrder: 'video' }));
  const first = (list: string[], name: string) => list.findIndex((t) => t.includes(name));
  assert.equal(first(resolve, 'MAIN1.MP4'), 0, resolve.join(' | '));
  assert.ok(first(resolve, 'MAIN1.MP4') < first(resolve, 'SIDE1.MP4') && first(resolve, 'SIDE1.MP4') < first(resolve, 'LAV.WAV') && first(resolve, 'LAV.WAV') < first(resolve, 'REC.WAV'), resolve.join(' | '));
  // Видео и корзины те же, что для Premiere; меняется только порядок дорожек звука.
  const premiere = buildFcp7Xml(s.cams, sync, opts);
  const davinci = buildFcp7Xml(s.cams, sync, { ...opts, audioOrder: 'video' });
  const bins = (x: string) => x.slice(0, x.indexOf('<sequence'));
  assert.equal(bins(davinci), bins(premiere));
  assert.deepEqual([...audioOf(premiere)].sort(), [...resolve].sort());
});
