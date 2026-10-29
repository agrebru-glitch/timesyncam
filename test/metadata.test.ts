import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSonyXml, decodeSonyLtc, parseFps } from '../src/core/sonyXml.ts';
import { buildClipMeta, timeFromFilename } from '../src/core/clipMeta.ts';
import type { FfprobeResult } from '../src/core/clipMeta.ts';
import { SONY_XML_25P, SONY_XML_50P, SONY_XML_SQ } from './fixtures.ts';

const sonyProbe = (rate: string, tc: string): FfprobeResult => ({
  streams: [
    { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv422p10le', width: 3840, height: 2160, r_frame_rate: rate },
    { codec_type: 'audio', codec_name: 'pcm_s16be', channels: 2, sample_rate: '48000' },
    { codec_type: 'data', codec_tag_string: 'rtmd', tags: { timecode: tc } },
  ],
  format: { duration: '9.6', tags: { creation_time: '2026-06-12T13:03:01.000000Z' } },
});

const base = { id: 'x', path: 'D:/card/C9151.MP4', name: 'C9151.MP4', sizeBytes: 1, mtimeMs: 0, proxyPath: null };

test('LTC Sony: байты кадры-секунды-минуты-часы, флаги отбрасываются', () => {
  assert.deepEqual(decodeSonyLtc('02293023'), { f: 2, s: 29, m: 30, h: 23, dropFlag: false, halfFlag: false });
  assert.equal(decodeSonyLtc('03140881')!.h, 1);
  assert.equal(decodeSonyLtc('03140881')!.halfFlag, true);
});

test('Sony XML 25p: тайм-код, время съёмки, модель, гамма', () => {
  const x = parseSonyXml(SONY_XML_25P)!;
  assert.equal(x.tc!.text, '23:30:29:02');
  assert.equal(x.creation!.epochSec, Date.UTC(2026, 5, 12, 13, 3, 1) / 1000);
  assert.equal(x.creation!.tzOffsetMin, 180);
  assert.equal(x.model, 'ILCE-7M4');
  assert.equal(x.serial, undefined);
  const m = buildClipMeta({ ...base, probe: sonyProbe('25/1', '23:30:29:02'), sony: x });
  assert.equal(m.camera.model, 'Sony A7 IV');
  assert.equal(m.camera.gamma, 'S-Log3');
  assert.equal(m.codecLabel, 'H.264 4:2:2 10-bit');
  assert.equal(m.durationSec, 9.6);
  assert.equal(m.tc!.seconds, 23 * 3600 + 30 * 60 + 29 + 2 / 25);
  assert.equal(m.captureFps, null);
  assert.equal(m.playable, false);
});

test('Sony XML 50p: монтажка показывает :38, а время то же самое', () => {
  const x = parseSonyXml(SONY_XML_50P)!;
  const m = buildClipMeta({ ...base, probe: sonyProbe('50/1', '01:07:59:38'), sony: x });
  assert.equal(m.tc!.text, '01:07:59:38');
  assert.equal(m.tc!.seconds, 3600 + 7 * 60 + 59 + 19 / 25);
  assert.equal(m.durationSec, 720 / 50);
});

test('Sony XML 50p с нечётного кадра: второй кадр пары не теряется', () => {
  const x = parseSonyXml(SONY_XML_50P.replace('value="19590701"', 'value="19590781"'))!;
  assert.equal(x.tc!.text, '01:07:59:39');
  const m = buildClipMeta({ ...base, probe: sonyProbe('50/1', '01:07:59:39'), sony: x });
  assert.ok(Math.abs(m.tc!.seconds - (3600 + 7 * 60 + 59 + 39 / 50)) < 1e-9);
  // Без тайм-кода в контейнере текст для монтажки — тоже в кадрах 50p.
  const bare = sonyProbe('50/1', '');
  bare.streams = bare.streams!.slice(0, 2);
  assert.equal(buildClipMeta({ ...base, probe: bare, sony: x }).tc!.text, '01:07:59:39');
});

test('Частота из Sony XML: p — кадры, i — полукадры', () => {
  assert.equal(parseFps('25p'), 25);
  assert.equal(parseFps('100.00p'), 100);
  assert.equal(parseFps('50i'), 25);
  assert.ok(Math.abs(parseFps('59.94i')! - 29.97) < 1e-9);
  assert.equal(parseFps(undefined), null);
});

test('Телефон с переменной частотой: длина клипа по файлу, а не по удвоенной частоте', () => {
  const m = buildClipMeta({
    ...base, name: 'VID_20260612_160301.mp4', sony: null,
    probe: {
      streams: [
        { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1920, height: 1080, r_frame_rate: '60/1', avg_frame_rate: '30/1', nb_frames: '300', duration: '10.000' },
        { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
      ],
      format: { duration: '10.02', tags: { creation_time: '2026-06-12T13:03:01.000000Z' } },
    },
  });
  assert.equal(m.durationSec, 10);
  assert.deepEqual(m.rate, { num: 30, den: 1 });
});

test('Sony S&Q: запись 100 к/с в файл 25p — помечается', () => {
  const m = buildClipMeta({ ...base, probe: sonyProbe('25/1', '23:30:29:02'), sony: parseSonyXml(SONY_XML_SQ)! });
  assert.equal(m.captureFps, 100);
  assert.equal(m.durationSec, 16);
  assert.equal(m.recordedSec, 4);
});

test('GoPro: местное время с пометкой UTC читается как местное', () => {
  const m = buildClipMeta({
    ...base, name: 'GX010123.MP4', sony: null,
    probe: { streams: [{ codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p10le', r_frame_rate: '50/1', tags: { handler_name: 'GoPro H.265' } }], format: { duration: '5', tags: { creation_time: '2026-06-12T16:03:01.000000Z' } } },
  });
  assert.equal(m.camera.model, 'GoPro');
  assert.equal(m.clock!.epochSec, new Date(2026, 5, 12, 16, 3, 1).getTime() / 1000);
  assert.match(m.clock!.note!, /GoPro/);
});

test('DJI: время из имени файла', () => {
  const m = buildClipMeta({
    ...base, name: 'DJI_20260612183015_0001_D.MP4', sony: null,
    probe: { streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', r_frame_rate: '30000/1001' }], format: { duration: '5', tags: { creation_time: '2026-06-12T18:30:15.000000Z', encoder: 'DJIMavic3' } } },
  });
  assert.equal(m.clock!.source, 'filename');
  assert.equal(m.clock!.epochSec, new Date(2026, 5, 12, 18, 30, 15).getTime() / 1000);
  assert.equal(m.playable, true);
});

test('iPhone: дата с часовым поясом', () => {
  const m = buildClipMeta({
    ...base, name: 'IMG_1234.MOV', sony: null,
    probe: { streams: [{ codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p10le', r_frame_rate: '30/1' }], format: { duration: '5', tags: { 'com.apple.quicktime.creationdate': '2026-06-12T16:03:01+0300', 'com.apple.quicktime.make': 'Apple', 'com.apple.quicktime.model': 'iPhone 17 Pro' } } },
  });
  assert.equal(m.clock!.epochSec, Date.UTC(2026, 5, 12, 13, 3, 1) / 1000);
  assert.equal(m.clock!.tzOffsetMin, 180);
  assert.equal(m.camera.model, 'Apple iPhone 17 Pro');
});

test('Рекордер BWF: тайм-код из time_reference и дата записи', () => {
  const m = buildClipMeta({
    ...base, name: 'ZOOM0001.WAV', sony: null,
    probe: { streams: [{ codec_type: 'audio', codec_name: 'pcm_s24le', channels: 2, sample_rate: '48000', bits_per_raw_sample: '24' }], format: { duration: '60', tags: { time_reference: String(48000 * (16 * 3600 + 3 * 60 + 1)), date: '2026-06-12', creation_time: '16:03:01', encoded_by: 'ZOOM H6' } } },
  });
  assert.equal(m.hasVideo, false);
  assert.equal(m.tc!.source, 'bwf');
  assert.equal(m.tc!.seconds, 16 * 3600 + 3 * 60 + 1);
  assert.equal(m.codecLabel, 'WAV 24-bit');
  assert.equal(m.clock!.epochSec, new Date(2026, 5, 12, 16, 3, 1).getTime() / 1000);
});

test('Canon/Panasonic MOV: тайм-код из дорожки tmcd', () => {
  const m = buildClipMeta({
    ...base, name: 'MVI_0001.MOV', sony: null,
    probe: { streams: [{ codec_type: 'video', codec_name: 'prores', profile: 'HQ', pix_fmt: 'yuv422p10le', r_frame_rate: '30000/1001' }, { codec_type: 'data', codec_tag_string: 'tmcd', tags: { timecode: '16:03:01;12' } }], format: { duration: '5', tags: { creation_time: '2026-06-12T13:03:01Z' } } },
  });
  assert.equal(m.codecLabel, 'ProRes HQ');
  assert.equal(m.tc!.drop, true);
  assert.ok(Math.abs(m.tc!.seconds - (16 * 3600 + 3 * 60 + 1 + 12 / 30)) < 0.1);
});

test('время в именах телефонов', () => {
  assert.equal(timeFromFilename('PXL_20260612_160301123.mp4'), new Date(2026, 5, 12, 16, 3, 1, 123).getTime() / 1000);
  assert.equal(timeFromFilename('C9151.MP4'), null);
});
