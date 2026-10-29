import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../src/core/sync.ts';
import { buildFcpxml } from '../src/core/fcpxml.ts';
import { camera, clip, T16 } from './fixtures.ts';

// «N/Ds» → секунды.
const sec = (v: string) => {
  const m = /^(-?\d+)(?:\/(\d+))?s$/.exec(v)!;
  return Number(m[1]) / Number(m[2] ?? 1);
};
const attr = (xml: string, tag: string, name: string) => [...xml.matchAll(new RegExp(`<${tag} [^>]*name="${name.replace('.', '\\.')}"[^>]*>`, 'g'))].map((m) => m[0]);
const get = (el: string, a: string) => new RegExp(` ${a}="([^"]+)"`).exec(el)![1];

function scene() {
  const video = clip({ start: T16 + 181, tcSeconds: 0 });
  video.path = 'D:\\Съёмка 27_10\\C0001.MP4';
  video.name = 'C0001.MP4';
  const wav = clip({ start: T16 + 170 });
  Object.assign(wav, {
    name: 'ZOOM0001.WAV', path: 'D:\\Звук\\ZOOM0001.WAV', hasVideo: false, rate: null, frames: null, width: null, height: null,
    durationSec: 60, recordedSec: 60, audioChannels: 2, audioSampleRate: 48000,
    tc: { text: '15:16:40:12', seconds: 55000.5, countRate: 25, drop: false, source: 'bwf' },
  });
  const cams = [camera('Камера 1', [video]), camera('Рекордер', [wav])];
  const r = runSync(cams);
  // Точные места после сверки по звуку — с долями кадра.
  const exact: Record<string, number> = { [video.id]: T16 + 181.0731, [wav.id]: T16 + 172.41177 };
  const placements = r.placements.map((p) => ({ ...p, start: exact[p.clipId], end: exact[p.clipId] + (p.end - p.start) }));
  return { cams, r: { ...r, placements, start: Math.min(...placements.map((p) => p.start)) }, video, wav };
}

test('FCPXML: звук рекордера встаёт на таймлинию сэмпл в сэмпл', () => {
  const { cams, r, wav } = scene();
  const xml = buildFcpxml(cams, r, { name: 'Тест & проверка', rate: { num: 25, den: 1 }, width: 3840, height: 2160 });
  const fromStart = (epoch: number) => epoch - r.start; // таймлиния начинается с первого клипа

  const [clipEl] = attr(xml, 'asset-clip', 'ZOOM0001.WAV');
  const [assetEl] = attr(xml, 'asset', 'ZOOM0001.WAV');
  assert.equal(get(clipEl, 'lane'), '-1');
  const offset = sec(get(clipEl, 'offset'));
  assert.ok(Number.isInteger(Math.round(offset * 25 * 1e6) / 1e6), 'клип стоит на кадре таймлинии');
  const trim = sec(get(clipEl, 'start')) - sec(get(assetEl, 'start'));
  assert.ok(trim >= 0 && trim < 1 / 25, `срез ${trim}`);
  // Нулевой сэмпл файла на таймлинии — там, где его нашла синхронизация.
  const zero = offset - trim;
  const expected = fromStart(r.placements.find((p) => p.clipId === wav.id)!.start);
  assert.ok(Math.abs(zero - expected) <= 0.5 / 48000 + 1e-9, `ошибка ${((zero - expected) * 1e6).toFixed(1)} мкс`);
  // Начало файла — по BWF, в сэмплах.
  assert.equal(sec(get(assetEl, 'start')), 55000.5);
});

test('FCPXML: видео на кадре, таймлиния с 00:00:00:00 и первым клипом в начале, путь с кириллицей', () => {
  const { cams, r, video } = scene();
  const xml = buildFcpxml(cams, r, { name: 'Тест & проверка', rate: { num: 25, den: 1 }, width: 3840, height: 2160 });
  assert.match(xml, /<fcpxml version="1\.10">/);
  assert.match(xml, /Тест &amp; проверка/);
  assert.match(xml, /src="file:\/\/\/D:\/%D0%A1%D1%8A%D1%91%D0%BC%D0%BA%D0%B0%2027_10\/C0001\.MP4"/);
  assert.equal(/tcStart="([^"]+)"/.exec(xml)![1], '0s');
  // Первый клип съёмки (здесь рекордер) — в самом начале таймлинии.
  assert.equal(Math.min(...[...xml.matchAll(/<asset-clip [^>]*offset="([^"]+)"/g)].map((m) => sec(m[1]))), 0);
  const [clipEl] = attr(xml, 'asset-clip', 'C0001.MP4');
  assert.equal(get(clipEl, 'lane'), '1');
  const offset = sec(get(clipEl, 'offset'));
  const expected = r.placements.find((p) => p.clipId === video.id)!.start - r.start;
  assert.ok(Math.abs(offset - expected) <= 0.5 / 25 + 1e-9);
  assert.equal(get(clipEl, 'duration'), '10s');
});

test('FCPXML: 29,97 — время в долях 1001/30000', () => {
  const { cams, r } = scene();
  const xml = buildFcpxml(cams, r, { name: 'NTSC', rate: { num: 30000, den: 1001 }, width: 1920, height: 1080 });
  assert.match(xml, /<format id="r0" frameDuration="1001\/30000s"/);
  for (const m of xml.matchAll(/<asset-clip [^>]*offset="([^"]+)"/g)) {
    const frames = (sec(m[1]) * 30000) / 1001;
    assert.ok(Math.abs(frames - Math.round(frames)) < 1e-6, m[1]);
  }
});

test('FCPXML: клипы в файле по дорожкам — рекордер, потом камеры сверху вниз, чтобы звук лёг под своё видео', () => {
  // Камера 2 включилась раньше камеры 1, рекордер — раньше всех.
  const a1 = clip({ start: T16 + 100 });
  const a2 = clip({ start: T16 + 300 });
  const b1 = clip({ start: T16 + 50 });
  const rec = clip({ start: T16 + 10 });
  Object.assign(rec, { name: 'ZOOM0001.WAV', hasVideo: false, rate: null, frames: null, width: null, height: null, durationSec: 600, recordedSec: 600 });
  const cams = [camera('Камера 1', [a1, a2]), camera('Камера 2', [b1]), camera('Рекордер', [rec])];
  const r = runSync(cams);
  const xml = buildFcpxml(cams, r, { name: 'Порядок', rate: { num: 25, den: 1 }, width: 3840, height: 2160 });
  const order = [...xml.matchAll(/<asset-clip [^>]*lane="(-?\d+)"[^>]*name="([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(order, [`-1 ZOOM0001.WAV`, `1 ${a1.name}`, `1 ${a2.name}`, `2 ${b1.name}`]);
});
