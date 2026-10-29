// Разбор XML-файла, который камеры Sony пишут рядом с клипом (C0001M01.XML).
import { pad2 } from './timecode.ts';

export interface SonyXmlMeta {
  frames: number | null;
  formatFps: number | null;
  captureFps: number | null;
  // half — второй кадр пары у 50p/59,94p: тайм-код считается по 25/30, а кадров вдвое больше.
  tc: { h: number; m: number; s: number; f: number; half: boolean; countRate: number; halfStep: boolean; drop: boolean; text: string } | null;
  creation: { epochSec: number; tzOffsetMin: number | null } | null;
  make?: string;
  model?: string;
  serial?: string;
  lens?: string;
  gamma?: string;
  width: number | null;
  height: number | null;
}

function attr(xml: string, tag: string, name: string): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*?\\b${name}="([^"]*)"`);
  return re.exec(xml)?.[1];
}

function bcd(byte: string, mask: number): number {
  const v = parseInt(byte, 16) & mask;
  return (v >> 4) * 10 + (v & 0x0f);
}

// Значение LTC у Sony записано байтами кадры-секунды-минуты-часы в BCD, старшие биты — флаги.
// Бит 0x80 часов при halfStep — второй кадр пары (50p, 59,94p).
export function decodeSonyLtc(value: string): { h: number; m: number; s: number; f: number; dropFlag: boolean; halfFlag: boolean } | null {
  if (!/^[0-9a-fA-F]{8}$/.test(value)) return null;
  const ff = value.slice(0, 2);
  const hh = value.slice(6, 8);
  return {
    f: bcd(ff, 0x3f),
    s: bcd(value.slice(2, 4), 0x7f),
    m: bcd(value.slice(4, 6), 0x7f),
    h: bcd(hh, 0x3f),
    dropFlag: (parseInt(ff, 16) & 0x40) !== 0,
    halfFlag: (parseInt(hh, 16) & 0x80) !== 0,
  };
}

// 25p, 50.00p, 59.94p — кадры в секунду; 50i, 59.94i — полукадры, кадров вдвое меньше.
export function parseFps(text: string | undefined): number | null {
  if (!text) return null;
  const m = /([\d.]+)\s*([ip])?/i.exec(text);
  if (!m) return null;
  return m[2]?.toLowerCase() === 'i' ? Number(m[1]) / 2 : Number(m[1]);
}

export function parseSonyXml(xml: string): SonyXmlMeta | null {
  if (!xml.includes('NonRealTimeMeta')) return null;

  const durationText = attr(xml, 'Duration', 'value');
  const formatFps = parseFps(attr(xml, 'VideoFrame', 'formatFps'));
  const captureFps = parseFps(attr(xml, 'VideoFrame', 'captureFps'));

  let tc: SonyXmlMeta['tc'] = null;
  const ltcTable = /<LtcChangeTable\b([^>]*)>([\s\S]*?)<\/LtcChangeTable>/.exec(xml);
  if (ltcTable) {
    const tcFps = Number(/tcFps="(\d+)"/.exec(ltcTable[1])?.[1] ?? 0);
    const halfStep = /halfStep="true"/.test(ltcTable[1]);
    const first = /<LtcChange\b[^>]*frameCount="0"[^>]*value="([0-9a-fA-F]{8})"/.exec(ltcTable[2])
      ?? /<LtcChange\b[^>]*value="([0-9a-fA-F]{8})"/.exec(ltcTable[2]);
    const decoded = first ? decodeSonyLtc(first[1]) : null;
    if (decoded && tcFps > 0) {
      const drop = decoded.dropFlag && (tcFps === 30 || tcFps === 60);
      const half = halfStep && decoded.halfFlag;
      // Текст — в кадрах самого клипа, как его покажет монтажка: у 50p кадры 0–49.
      const frame = halfStep ? decoded.f * 2 + (half ? 1 : 0) : decoded.f;
      tc = {
        h: decoded.h,
        m: decoded.m,
        s: decoded.s,
        f: decoded.f,
        half,
        countRate: tcFps,
        halfStep,
        drop,
        text: `${pad2(decoded.h)}:${pad2(decoded.m)}:${pad2(decoded.s)}${drop ? ';' : ':'}${pad2(frame)}`,
      };
    }
  }

  let creation: SonyXmlMeta['creation'] = null;
  const created = attr(xml, 'CreationDate', 'value');
  if (created) {
    const ms = Date.parse(created);
    if (!Number.isNaN(ms)) {
      const tz = /([+-])(\d{2}):(\d{2})$/.exec(created);
      creation = {
        epochSec: ms / 1000,
        tzOffsetMin: tz ? (tz[1] === '-' ? -1 : 1) * (Number(tz[2]) * 60 + Number(tz[3])) : created.endsWith('Z') ? 0 : null,
      };
    }
  }

  const gamma = /<Item name="CaptureGammaEquation" value="([^"]*)"/.exec(xml)?.[1];
  const width = Number(attr(xml, 'VideoLayout', 'pixel') ?? NaN);
  const height = Number(attr(xml, 'VideoLayout', 'numOfVerticalLine') ?? NaN);
  const serial = attr(xml, 'Device', 'serialNo');

  return {
    frames: durationText ? Number(durationText) : null,
    formatFps,
    captureFps,
    tc,
    creation,
    make: attr(xml, 'Device', 'manufacturer'),
    model: attr(xml, 'Device', 'modelName'),
    serial: serial && serial !== '4294967295' ? serial : undefined,
    lens: attr(xml, 'Lens', 'modelName'),
    gamma,
    width: Number.isFinite(width) ? width : null,
    height: Number.isFinite(height) ? height : null,
  };
}

// Понятные названия моделей Sony.
const SONY_MODELS: Record<string, string> = {
  'ILCE-7M4': 'Sony A7 IV',
  'ILCE-7M3': 'Sony A7 III',
  'ILCE-7SM3': 'Sony A7S III',
  'ILCE-7RM5': 'Sony A7R V',
  'ILCE-7CM2': 'Sony A7C II',
  'ILCE-7M5': 'Sony A7 V',
  'ILCE-1': 'Sony A1',
  'ILCE-1M2': 'Sony A1 II',
  'ILCE-9M3': 'Sony A9 III',
  'ILCE-6700': 'Sony A6700',
  'ILME-FX3': 'Sony FX3',
  'ILME-FX30': 'Sony FX30',
  'ILME-FX6V': 'Sony FX6',
  'ILME-FX6T': 'Sony FX6',
  'ZV-E1': 'Sony ZV-E1',
};

export function friendlyModel(make: string | undefined, model: string | undefined): string | undefined {
  if (!model) return make;
  if (SONY_MODELS[model]) return SONY_MODELS[model];
  if (make && !model.toLowerCase().startsWith(make.toLowerCase())) return `${make} ${model}`;
  return model;
}

const GAMMA_NAMES: Record<string, string> = {
  's-log3-cine': 'S-Log3',
  's-log3': 'S-Log3',
  's-log2': 'S-Log2',
  'rec709': 'Rec.709',
  'rec709-xvycc': 'Rec.709',
  'rec2100-hlg': 'HLG',
  's-cinetone': 'S-Cinetone',
};

export function friendlyGamma(g: string | undefined): string | undefined {
  if (!g) return undefined;
  return GAMMA_NAMES[g.toLowerCase()] ?? g;
}
