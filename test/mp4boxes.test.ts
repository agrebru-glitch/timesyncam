import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxMap, privacyMask, readSonyNrtXml } from '../src/core/mp4Boxes.ts';
import type { ReadAt } from '../src/core/mp4Boxes.ts';
import { parseSonyXml } from '../src/core/sonyXml.ts';
import { SONY_XML_25P } from './fixtures.ts';

const enc = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(parts);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(enc.encode(type), 4);
  out.set(body, 8);
  return out;
}

// Коробка с 64-битным размером, как mdat записи в несколько ГБ.
function bigBox(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(16 + body.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 1);
  out.set(enc.encode(type), 4);
  v.setUint32(12, out.length);
  out.set(body, 16);
  return out;
}

const fullBox = () => new Uint8Array(4); // версия и флаги — нули
const hdlr = (handler: string) => box('hdlr', fullBox(), new Uint8Array(4), enc.encode(handler), new Uint8Array(12), new Uint8Array(1));
const xml = (text: string) => box('xml ', fullBox(), enc.encode(text), new Uint8Array(1));
const reader = (buf: Uint8Array): ReadAt => async (offset, length) => buf.subarray(offset, offset + length);

// Как пишет Sony: ftyp XAVC, mdat, moov, а XML — в коробке meta верхнего уровня в конце файла.
function sonyMp4(meta: Uint8Array): Uint8Array {
  return concat([
    box('ftyp', enc.encode('XAVC'), new Uint8Array(4), enc.encode('XAVCmp42iso2')),
    bigBox('mdat', new Uint8Array(4000)),
    box('moov', box('mvhd', new Uint8Array(100))),
    meta,
  ]);
}

test('XML Sony внутри MP4: тот же текст и те же тайм-код и время, что у XML рядом с клипом', async () => {
  const file = sonyMp4(box('meta', fullBox(), hdlr('nrtm'), box('idat', new Uint8Array(64)), xml(SONY_XML_25P)));
  const text = await readSonyNrtXml(reader(file), file.length);
  assert.equal(text, SONY_XML_25P);
  const a = parseSonyXml(text!)!;
  const b = parseSonyXml(SONY_XML_25P)!;
  assert.deepEqual(a.tc, b.tc);
  assert.deepEqual(a.creation, b.creation);
  assert.equal(a.model, 'ILCE-7M4');
});

test('XML внутри MP4: чего нет — того нет, и битый файл не роняет чтение', async () => {
  const none = concat([box('ftyp', enc.encode('isom')), box('moov', box('mvhd', new Uint8Array(100)))]);
  assert.equal(await readSonyNrtXml(reader(none), none.length), null);
  // Коробка meta с другим XML — не Sony.
  const other = sonyMp4(box('meta', fullBox(), hdlr('mdta'), xml('<x/>')));
  assert.equal(await readSonyNrtXml(reader(other), other.length), null);
  // Файл оборван посреди meta.
  const cut = sonyMp4(box('meta', fullBox(), hdlr('nrtm'), xml(SONY_XML_25P)));
  assert.equal(await readSonyNrtXml(reader(cut.subarray(0, cut.length - 100)), cut.length - 100), null);
  // Последняя коробка с размером 0 — «до конца файла».
  const tail = concat([box('ftyp', enc.encode('XAVC')), box('meta', fullBox(), hdlr('nrtm'), xml(SONY_XML_25P))]);
  new DataView(tail.buffer).setUint32(tail.length - box('meta', fullBox(), hdlr('nrtm'), xml(SONY_XML_25P)).length, 0);
  assert.equal(await readSonyNrtXml(reader(tail), tail.length), SONY_XML_25P);
});

test('XML внутри MOV: meta в moov/udta, без версии и флагов', async () => {
  const file = concat([
    box('ftyp', enc.encode('qt  ')),
    box('mdat', new Uint8Array(100)),
    box('moov', box('mvhd', new Uint8Array(100)), box('udta', box('meta', hdlr('nrtm'), xml(SONY_XML_25P)))),
  ]);
  assert.equal(await readSonyNrtXml(reader(file), file.length), SONY_XML_25P);
});

test('Карта коробок для отчёта: устройство файла, обработчики, время создания, без серийника', async () => {
  const mask = privacyMask('соль');
  const withSerial = SONY_XML_25P.replace(/<Device ([^>]*)\/>/, '<Device manufacturer="Sony" modelName="ILCE-7M4" serialNo="5512345"/>');
  const mvhd = new Uint8Array(100);
  new DataView(mvhd.buffer).setUint32(4, 2082844800 + Date.UTC(2026, 5, 12, 13, 3, 1) / 1000);
  const file = concat([
    box('ftyp', enc.encode('XAVC')),
    bigBox('mdat', new Uint8Array(1000)),
    box('moov', box('mvhd', mvhd), box('trak', box('mdia', hdlr('vide')))),
    box('meta', fullBox(), hdlr('nrtm'), xml(withSerial)),
  ]);
  const map = await boxMap(reader(file), file.length, mask);
  assert.deepEqual(map.map((b) => b.type), ['ftyp', 'mdat', 'moov', 'meta']);
  const moov = map[2];
  assert.equal(moov.children![0].created, '2026-06-12T13:03:01.000Z');
  assert.equal(moov.children![1].children![0].children![0].handler, 'vide');
  const meta = map[3];
  assert.equal(meta.children![0].handler, 'nrtm');
  const text = meta.children![1].text!;
  assert.ok(text.includes('NonRealTimeMeta') && !text.includes('5512345'));
  // Содержимое mdat в карту не попадает.
  assert.equal(map[1].children, undefined);
  assert.equal(map[1].text, undefined);
});

test('Приватность отчёта: серийник — условный, один для одной камеры; координаты убраны', () => {
  const mask = privacyMask('a');
  const x = mask('<Device serialNo="5512345"/><Device serialNo="5512345"/><Device serialNo="7700001"/>');
  const ids = [...x.matchAll(/serialNo="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);
  assert.ok(!x.includes('5512345'));
  // Своя соль у каждого отчёта: условный номер не повторяется от отчёта к отчёту.
  assert.notEqual(privacyMask('b')('serialNo="5512345"'), mask('serialNo="5512345"'));
  // «Номера нет» у Sony остаётся как есть.
  assert.equal(mask('serialNo="4294967295"'), 'serialNo="4294967295"');
  assert.equal(mask('+12.3456+065.4321+100.000/'), '…/');
  assert.equal(mask('<exif:GPSLatitude>12,20.7N</exif:GPSLatitude>'), '<exif:GPSLatitude>…</exif:GPSLatitude>');
  assert.equal(mask('<Group name="ExifGPS"><Item name="Latitude" value="12.3"/></Group>'), '<Group name="ExifGPS">…</Group>');
});
