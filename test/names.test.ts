import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderTitle } from '../src/renderer/state.ts';

test('Имя дорожки — по папке, которую назвал оператор; служебные папки карты пропускаются', () => {
  assert.equal(folderTitle(String.raw`D:\Съёмка\CAM 01`), 'CAM 01');
  assert.equal(folderTitle(String.raw`D:\Съёмка\hl-2026-10-30`), 'hl-2026-10-30');
  // Файлы перетащили прямо из папки карты Sony или GoPro — берём папку выше служебных.
  assert.equal(folderTitle(String.raw`E:\CAM 02\PRIVATE\M4ROOT\CLIP`), 'CAM 02');
  assert.equal(folderTitle(String.raw`E:\GoPro левая\DCIM\100GOPRO`), 'GoPro левая');
  assert.equal(folderTitle('/Volumes/Untitled/Рекордер/FOLDER01'), 'FOLDER01');
  // Карта целиком, без папки с именем — имени нет, дорожка остаётся «Камера N».
  assert.equal(folderTitle(String.raw`E:\DCIM\100MSDCF`), null);
});

test('Папки «001», «002» — имена камер от оператора, а не служебные папки карты', () => {
  assert.equal(folderTitle(String.raw`D:\2026 10 27 Съёмка\001`), '001');
  assert.equal(folderTitle(String.raw`D:\2026 10 27 Съёмка\002\PRIVATE\M4ROOT\CLIP`), '002');
  assert.equal(folderTitle(String.raw`E:\Panasonic\DCIM\100_PANA`), 'Panasonic');
});
