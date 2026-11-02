// Коробки MP4/MOV с диска: читаются только заголовки коробок и сами нужные коробки, даже у файла в десятки ГБ.
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { boxMap, readSonyNrtXml } from '../core/mp4Boxes.ts';
import type { BoxNode, ReadAt } from '../core/mp4Boxes.ts';

function readerOf(fh: FileHandle): ReadAt {
  return async (offset, length) => {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  };
}

async function withFile<T>(path: string, fn: (read: ReadAt, size: number) => Promise<T>): Promise<T | null> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(path, 'r');
    return await fn(readerOf(fh), (await fh.stat()).size);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

// XML Sony внутри самого MP4 — на случай, когда C0001M01.XML рядом с клипом потеряли при копировании.
export const readEmbeddedSonyXml = (path: string): Promise<string | null> => withFile(path, readSonyNrtXml);

// mask — как убрать из текстов серийные номера и координаты (своя соль у каждого отчёта).
export const readBoxMap = (path: string, mask: (text: string) => string): Promise<BoxNode[] | null> => withFile(path, (read, size) => boxMap(read, size, mask));
