// Коробки MP4/MOV (ISO BMFF) — то, что лежит в файле, но чего не показывает ffprobe: XML Sony внутри MP4
// и карта коробок для расширенного отчёта. Файл читается через колбэк кусками: у записи в десятки ГБ
// читаются только заголовки коробок и сами нужные коробки, а не mdat.

export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

export interface Box {
  type: string;
  offset: number; // начало коробки
  size: number; // вместе с заголовком
  header: number; // 8 байт, или 16 с 64-битным размером
}

const MAX_BOXES = 4096; // защита от мусора и от фрагментированных файлов с тысячами moof/mdat
const MAX_META = 4 << 20; // коробка meta с XML — килобайты; больше — не она
const MAX_TEXT = 64 << 10;
const MAX_TOP = 64; // в карте: фрагментированный файл — это тысячи одинаковых коробок
const MAX_DEPTH = 8;
const EPOCH_1904 = 2082844800; // секунд от 1904 года, с которого MP4 считает время, до 1970-го

function u32(b: Uint8Array, at: number): number {
  return b[at] * 2 ** 24 + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
}

function u64(b: Uint8Array, at: number): number {
  return u32(b, at) * 2 ** 32 + u32(b, at + 4);
}

// Тип коробки — четыре печатных знака; у Apple бывает «©» (0xA9).
function boxType(b: Uint8Array, at: number): string | null {
  for (let i = at; i < at + 4; i++) if (!((b[i] >= 0x20 && b[i] < 0x7f) || b[i] === 0xa9)) return null;
  return String.fromCharCode(...b.subarray(at, at + 4));
}

// Заголовок коробки по первым 16 байтам: размер 1 — дальше 64-битный, 0 — до конца диапазона.
export function parseBoxHeader(b: Uint8Array, offset: number, end: number): Box | null {
  if (b.length < 8) return null;
  const type = boxType(b, 4);
  if (!type) return null;
  let size = u32(b, 0);
  let header = 8;
  if (size === 1) {
    if (b.length < 16) return null;
    size = u64(b, 8);
    header = 16;
  } else if (size === 0) {
    size = end - offset;
  }
  if (size < header || offset + size > end) return null;
  return { type, offset, size, header };
}

// Коробки подряд в диапазоне файла.
export async function listBoxes(read: ReadAt, start: number, end: number): Promise<Box[]> {
  const out: Box[] = [];
  let at = start;
  while (at + 8 <= end && out.length < MAX_BOXES) {
    const box = parseBoxHeader(await read(at, Math.min(16, end - at)), at, end);
    if (!box) break;
    out.push(box);
    at += box.size;
  }
  return out;
}

// Коробки подряд внутри уже прочитанного куска; смещения — от начала куска.
export function childBoxes(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  let at = start;
  while (at + 8 <= end && out.length < MAX_BOXES) {
    const box = parseBoxHeader(b.subarray(at, Math.min(at + 16, end)), at, end);
    if (!box) break;
    out.push(box);
    at += box.size;
  }
  return out;
}

// Дети коробки meta: в MP4 это FullBox — 4 байта версии и флагов (нули) перед детьми, в MOV — без них.
function metaStart(first4: Uint8Array): number {
  return first4.length >= 4 && u32(first4, 0) === 0 ? 4 : 0;
}

// Текст коробки: UTF-8 или UTF-16 с меткой порядка байтов; завершающие нули срезаются.
function boxText(b: Uint8Array): string {
  const s = b[0] === 0xfe && b[1] === 0xff ? new TextDecoder('utf-16be').decode(b.subarray(2))
    : b[0] === 0xff && b[1] === 0xfe ? new TextDecoder('utf-16le').decode(b.subarray(2))
      : new TextDecoder('utf-8').decode(b);
  return s.replace(/\u0000+$/, '');
}

// XML NonRealTimeMeta, который Sony кладёт в сам MP4: коробка meta верхнего уровня (обработчик nrtm) с коробкой
// 'xml ' — тот же текст, что и C0001M01.XML рядом с клипом. Остаётся в файле, даже если XML потеряли при копировании.
export async function readSonyNrtXml(read: ReadAt, fileSize: number): Promise<string | null> {
  const top = await listBoxes(read, 0, fileSize);
  const metas = top.filter((b) => b.type === 'meta');
  // На всякий случай и в moov/udta — туда кладут метаданные в MOV.
  const moov = top.find((b) => b.type === 'moov');
  if (moov) {
    const udta = (await listBoxes(read, moov.offset + moov.header, moov.offset + moov.size)).find((b) => b.type === 'udta');
    if (udta) metas.push(...(await listBoxes(read, udta.offset + udta.header, udta.offset + udta.size)).filter((b) => b.type === 'meta'));
  }
  for (const meta of metas) {
    if (meta.size - meta.header > MAX_META) continue;
    const body = await read(meta.offset + meta.header, meta.size - meta.header);
    for (const c of childBoxes(body, metaStart(body), body.length)) {
      if (c.type !== 'xml ') continue;
      // 'xml ' — тоже FullBox: 4 байта версии и флагов перед текстом.
      const text = boxText(body.subarray(c.offset + c.header + 4, c.offset + c.size));
      if (text.includes('NonRealTimeMeta')) return text;
    }
  }
  return null;
}

// --- Карта коробок для расширенного отчёта: где камера хранит время и метаданные. Видео в ней нет.

export interface BoxNode {
  type: string;
  offset: number;
  size: number;
  skipped?: number; // столько одинаковых коробок верхнего уровня пропущено (фрагментированный файл)
  uuid?: string; // у uuid — её 16 байт
  handler?: string; // у hdlr: vide, soun, tmcd, rtmd, meta, nrtm…
  entries?: string[]; // у stsd — типы записей: avc1, hvc1, twos, tmcd, rtmd, gpmd…
  created?: string; // у mvhd, tkhd, mdhd — время создания и изменения, как записано
  modified?: string;
  edits?: { duration: number; mediaTime: number }[]; // у elst — правки времени дорожки (в единицах файла)
  text?: string; // текстовые метаданные: XML, XMP, строки udta
  children?: BoxNode[];
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf', 'meta', 'mvex', 'moof', 'traf']);
const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function mp4Time(sec: number): string | undefined {
  return sec > 0 ? new Date((sec - EPOCH_1904) * 1000).toISOString() : undefined;
}

// Серийные номера и координаты в отчёт не попадают. Серийный номер заменяется условным — одинаковым для одной камеры
// внутри отчёта: по модели и номеру программа различает две камеры одной модели, и повтору по отчёту это нужно.
// Соль — своя у каждого отчёта, поэтому номер по условному не восстановить.
export function privacyMask(salt: string): (text: string) => string {
  const pseudonym = (v: string) => {
    if (!v || v === '4294967295') return v; // так Sony пишет «номера нет»
    let h = 2166136261;
    for (const ch of salt + v) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return `x${(h >>> 0).toString(16)}`;
  };
  return (text) => text
    .replace(/(serialNo|SerialNumber)(\s*=\s*"|>)([^"<]*)/gi, (_, k: string, sep: string, v: string) => `${k}${sep}${pseudonym(v)}`)
    .replace(/(umidRef\s*=\s*")[^"]*/g, '$1…')
    .replace(/(<Group name="ExifGPS"[^>]*>)[\s\S]*?(<\/Group>)/g, '$1…$2')
    .replace(/(<[\w:]*GPS\w*[^>]*>)[^<]*/g, '$1…')
    .replace(/(GPS\w*\s*=\s*")[^"]*/g, '$1…')
    .replace(/[+-]\d{1,2}(?:\.\d+)?[+-]\d{1,3}(?:\.\d+)?(?:[+-]\d+(?:\.\d+)?)?(?:CRS[^/]*)?\//g, '…/');
}

type Mask = (text: string) => string;

async function nodeOf(read: ReadAt, box: Box, depth: number, mask: Mask): Promise<BoxNode> {
  const node: BoxNode = { type: box.type, offset: box.offset, size: box.size };
  const start = box.offset + box.header;
  const end = box.offset + box.size;
  const payload = (n: number) => read(start, Math.min(n, end - start));
  const t = box.type;
  if (t === 'uuid') {
    const b = await payload(16 + MAX_TEXT);
    node.uuid = hex(b.subarray(0, 16));
    if (node.uuid === XMP_UUID) node.text = mask(boxText(b.subarray(16)));
  } else if (t === 'hdlr') {
    const b = await payload(12);
    if (b.length >= 12) node.handler = String.fromCharCode(...b.subarray(8, 12));
  } else if (t === 'stsd') {
    node.entries = (await listBoxes(read, start + 8, end)).map((e) => e.type);
  } else if (t === 'mvhd' || t === 'tkhd' || t === 'mdhd') {
    const b = await payload(20);
    const v1 = b[0] === 1;
    if (b.length >= (v1 ? 20 : 12)) {
      node.created = mp4Time(v1 ? u64(b, 4) : u32(b, 4));
      node.modified = mp4Time(v1 ? u64(b, 12) : u32(b, 8));
    }
  } else if (t === 'elst') {
    const b = await payload(8 + 20 * 16);
    const v1 = b[0] === 1;
    const n = b.length >= 8 ? Math.min(u32(b, 4), 16) : 0;
    const step = v1 ? 20 : 12;
    node.edits = [];
    for (let i = 0; i < n && 8 + (i + 1) * step <= b.length; i++) {
      const at = 8 + i * step;
      const media = v1 ? u64(b, at + 8) : u32(b, at + 4);
      node.edits.push({ duration: v1 ? u64(b, at) : u32(b, at), mediaTime: media >= 2 ** 31 && !v1 ? media - 2 ** 32 : media });
    }
  } else if (t === 'xml ') {
    node.text = mask(boxText((await payload(4 + MAX_TEXT)).subarray(4)));
  } else if (t === 'XMP_') {
    node.text = mask(boxText(await payload(MAX_TEXT)));
  } else if (t.charCodeAt(0) === 0xa9) {
    // Строка QuickTime в udta: длина, язык, текст. ©xyz — координаты съёмки.
    const b = await payload(4 + MAX_TEXT);
    const len = b.length >= 4 ? (b[0] << 8) + b[1] : 0;
    node.text = t === '©xyz' ? '…' : mask(boxText(b.subarray(4, 4 + len)));
  } else if (CONTAINERS.has(t) && depth < MAX_DEPTH) {
    const from = t === 'meta' ? start + metaStart(await payload(4)) : start;
    const kids = await listBoxes(read, from, end);
    node.children = [];
    for (const k of kids) node.children.push(await nodeOf(read, k, depth + 1, mask));
  }
  return node;
}

export async function boxMap(read: ReadAt, fileSize: number, mask: Mask): Promise<BoxNode[]> {
  let top = await listBoxes(read, 0, fileSize);
  const out: BoxNode[] = [];
  let skipped = 0;
  if (top.length > MAX_TOP) {
    skipped = top.length - MAX_TOP;
    top = [...top.slice(0, MAX_TOP - 16), ...top.slice(-16)];
  }
  for (let i = 0; i < top.length; i++) {
    if (skipped && i === MAX_TOP - 16) out.push({ type: '…', offset: top[i].offset, size: 0, skipped });
    out.push(await nodeOf(read, top[i], 0, mask));
  }
  return out;
}
