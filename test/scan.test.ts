import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectPaths } from '../src/main/scan.ts';

test('Пачка файлов на дорожку: клипы, прокси и звук — вместе, сайдкары молча пропускаются', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tsc-scan-'));
  try {
    // Карта Sony, карта GoPro и папка рекордера — как их бросают на дорожку пачкой.
    const sony = join(root, 'A7IV', 'PRIVATE', 'M4ROOT');
    const gopro = join(root, 'GOPRO', 'DCIM', '100GOPRO');
    const rec = join(root, 'REC');
    for (const d of [join(sony, 'CLIP'), join(sony, 'SUB'), gopro, rec]) await mkdir(d, { recursive: true });
    const files = {
      clip: join(sony, 'CLIP', 'C0001.MP4'),
      xml: join(sony, 'CLIP', 'C0001M01.XML'),
      thm: join(sony, 'CLIP', 'C0001T01.JPG'),
      sub: join(sony, 'SUB', 'C0001S03.MP4'),
      gx: join(gopro, 'GX010001.MP4'),
      lrv: join(gopro, 'GL010001.LRV'),
      orphanLrv: join(gopro, 'GL010002.LRV'),
      wav: join(rec, 'ZOOM0001.WAV'),
      notes: join(root, 'план съёмки.docx'),
    };
    for (const f of Object.values(files)) await writeFile(f, '');

    const got = await collectPaths([files.clip, files.xml, files.thm, files.sub, files.gx, files.lrv, files.orphanLrv, files.notes, rec, files.clip]);
    const byPath = new Map(got.media.map((m) => [m.path, m.proxyPath]));
    assert.deepEqual([...byPath.keys()].sort(), [files.clip, files.gx, files.wav, files.orphanLrv].sort());
    assert.equal(byPath.get(files.clip), files.sub);
    assert.equal(byPath.get(files.gx), files.lrv);
    assert.equal(byPath.get(files.orphanLrv), null);
    assert.deepEqual(got.skipped, [files.notes]);
    assert.deepEqual(got.folders.sort(), [join(sony, 'CLIP'), join(sony, 'SUB'), gopro, root, rec].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Две карты с одинаковыми именами клипов: прокси — со своей карты', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tsc-scan-'));
  try {
    for (const card of ['card1', 'card2']) {
      await mkdir(join(root, card, 'SUB'), { recursive: true });
      await mkdir(join(root, card, 'CLIP'), { recursive: true });
      await writeFile(join(root, card, 'CLIP', 'C0001.MP4'), '');
      await writeFile(join(root, card, 'SUB', 'C0001S03.MP4'), '');
    }
    const got = await collectPaths([join(root, 'card1'), join(root, 'card2')]);
    assert.equal(got.media.length, 2);
    for (const m of got.media) assert.equal(m.proxyPath, m.path.replace('CLIP', 'SUB').replace('C0001.MP4', 'C0001S03.MP4'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
