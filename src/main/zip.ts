// Простой ZIP без сжатия: файлы кладутся как есть (звук Opus уже сжат). Имена — в UTF-8, чтобы кириллица
// открывалась правильно. Архив до 4 ГБ и до 65 535 файлов — для отчёта этого с запасом.
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { once } from 'node:events';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crcUpdate(crc: number, buf: Buffer): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function crcOf(path: string): Promise<number> {
  let crc = 0;
  for await (const chunk of createReadStream(path)) crc = crcUpdate(crc, chunk as Buffer);
  return crc;
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export async function writeZip(outPath: string, entries: { name: string; path: string }[]): Promise<void> {
  if (entries.length > 65535) throw new Error('Слишком много файлов для архива');
  const out = createWriteStream(outPath);
  const write = async (buf: Buffer) => {
    if (!out.write(buf)) await once(out, 'drain');
  };
  const { time, date } = dosTime(new Date());
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const size = (await stat(e.path)).size;
    if (offset + size > 0xffffffff - 1e6) throw new Error('Архив больше 4 ГБ');
    const crc = await crcOf(e.path);
    const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // имена в UTF-8
    local.writeUInt16LE(0, 8); // без сжатия
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    await write(local);
    await write(name);
    for await (const chunk of createReadStream(e.path)) await write(chunk as Buffer);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + size;
  }
  const cdBuf = Buffer.concat(central);
  await write(cdBuf);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(end);
  out.end();
  await once(out, 'finish');
}
