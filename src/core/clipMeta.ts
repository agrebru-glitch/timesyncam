// Сводит данные ffprobe, сайдкаров и имени файла в одно описание клипа.
// Камеры пишут время по-разному, поэтому источники проверяются по порядку надёжности.
import type { ClipMeta, ClipTimecode, ClipClock, Rate } from './types.ts';
import { parseRate, rateValue, parseTc, tcToSeconds, isNtscRate, secondsToTcText } from './timecode.ts';
import type { SonyXmlMeta } from './sonyXml.ts';
import { friendlyModel, friendlyGamma } from './sonyXml.ts';

export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  profile?: string;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  bits_per_sample?: number;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  duration?: string;
  channels?: number;
  sample_rate?: string;
  tags?: Record<string, string>;
}

export interface FfprobeResult {
  streams?: FfprobeStream[];
  format?: { format_name?: string; duration?: string; tags?: Record<string, string> };
}

export interface ClipInput {
  id: string;
  path: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
  probe: FfprobeResult | null;
  sony: SonyXmlMeta | null;
  proxyPath: string | null;
}

export type Vendor =
  | 'sony' | 'canon' | 'panasonic' | 'fujifilm' | 'nikon' | 'blackmagic'
  | 'gopro' | 'dji' | 'insta360' | 'apple' | 'android' | 'recorder';

const VENDOR_NAMES: Record<Vendor, string> = {
  sony: 'Sony', canon: 'Canon', panasonic: 'Panasonic', fujifilm: 'Fujifilm', nikon: 'Nikon',
  blackmagic: 'Blackmagic', gopro: 'GoPro', dji: 'DJI', insta360: 'Insta360', apple: 'iPhone',
  android: 'Android', recorder: 'Рекордер',
};

const PLAYABLE_PIX = new Set(['yuv420p', 'yuvj420p']);

function tagsLower(tags: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags ?? {})) out[k.toLowerCase()] = v;
  return out;
}

export function detectVendor(name: string, probe: FfprobeResult | null, sony: SonyXmlMeta | null): Vendor | null {
  if (sony) return 'sony';
  const fmt = tagsLower(probe?.format?.tags);
  const streamTags = (probe?.streams ?? []).map((s) => Object.values(s.tags ?? {}).join(' ')).join(' ');
  const hay = `${Object.values(fmt).join(' ')} ${streamTags}`.toLowerCase();
  const n = name.toUpperCase();

  if (/gopro/.test(hay) || /^(G[HXSL]\d{6}|GOPR\d{4}|GP\d{6})\./.test(n)) return 'gopro';
  if (/\bdji\b|dji\./.test(hay) || n.startsWith('DJI_')) return 'dji';
  if (/insta360/.test(hay) || /\.INSV$/.test(n)) return 'insta360';
  if (fmt['com.apple.quicktime.make']?.toLowerCase().includes('apple') || /^IMG_\d{4}\.(MOV|MP4)$/.test(n)) return 'apple';
  if (/blackmagic/.test(hay)) return 'blackmagic';
  if (/canon/.test(hay) || fmt.major_brand === 'CAEP') return 'canon';
  if (/panasonic|lumix/.test(hay)) return 'panasonic';
  if (/fujifilm/.test(hay)) return 'fujifilm';
  if (/nikon/.test(hay)) return 'nikon';
  if (/sony/.test(hay)) return 'sony';
  if (/^(PXL|VID)_\d{8}/.test(n) || /android/.test(hay)) return 'android';
  if (/zoom|tascam|sound devices|zaxcom|rode|deity/.test(hay)) return 'recorder';
  return null;
}

// Дата с поясом: 2026-06-12T16:03:01+0300 (Apple) или +03:00
function parseDateWithTz(text: string): { epochSec: number; tzOffsetMin: number | null } | null {
  const norm = text.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(norm);
  if (Number.isNaN(ms)) return null;
  const tz = /([+-])(\d{2}):(\d{2})$/.exec(norm);
  return {
    epochSec: ms / 1000,
    tzOffsetMin: tz ? (tz[1] === '-' ? -1 : 1) * (Number(tz[2]) * 60 + Number(tz[3])) : /z$/i.test(norm) ? 0 : null,
  };
}

function localEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number, ms = 0): number {
  return new Date(y, mo - 1, d, h, mi, s, ms).getTime() / 1000;
}

// Время из имени файла: DJI_20260612183015_0001_D.MP4, PXL_20260612_183015123.mp4, 20260612_183015.mp4
export function timeFromFilename(name: string): number | null {
  const m = /(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})(\d{3})?/.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return localEpoch(y, mo, d, h, mi, s, m[7] ? Number(m[7]) : 0);
}

// Многие камеры (GoPro, часть DJI) пишут местное время, но помечают его как UTC.
function reinterpretUtcAsLocal(epochSec: number): number {
  const d = new Date(epochSec * 1000);
  return localEpoch(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

function bitDepth(s: FfprobeStream): number | null {
  const raw = Number(s.bits_per_raw_sample ?? NaN);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const pix = s.pix_fmt ?? '';
  const m = /p(\d{2})(le|be)$/.exec(pix);
  if (m) return Number(m[1]);
  return pix ? 8 : null;
}

function chroma(pix: string | undefined): string | null {
  if (!pix) return null;
  if (pix.includes('444')) return '4:4:4';
  if (pix.includes('422')) return '4:2:2';
  if (pix.includes('420') || pix === 'nv12' || pix === 'p010le') return '4:2:0';
  return null;
}

export function codecLabel(video: FfprobeStream | undefined, audio: FfprobeStream | undefined, formatName?: string): string | null {
  if (video) {
    const c = video.codec_name ?? '';
    const names: Record<string, string> = {
      h264: 'H.264', hevc: 'H.265', prores: 'ProRes', dnxhd: 'DNxHD/HR', mjpeg: 'Motion JPEG',
      mpeg2video: 'MPEG-2', av1: 'AV1', vp9: 'VP9', cfhd: 'CineForm', rawvideo: 'Uncompressed',
    };
    const base = names[c] ?? c.toUpperCase();
    if (c === 'prores') return `ProRes ${video.profile ?? ''}`.trim();
    if (c === 'dnxhd') return video.profile ? `DNx ${video.profile}` : base;
    const parts = [base, chroma(video.pix_fmt), bitDepth(video) ? `${bitDepth(video)}-bit` : null].filter(Boolean);
    return parts.join(' ');
  }
  if (audio) {
    const bits = audio.bits_per_raw_sample ?? (audio.bits_per_sample ? String(audio.bits_per_sample) : undefined);
    // Несжатый звук подписываем по контейнеру: WAV (и RF64), AIFF, CAF, W64.
    const pcmBox = /aiff/.test(formatName ?? '') ? 'AIFF' : /caf/.test(formatName ?? '') ? 'CAF' : /w64/.test(formatName ?? '') ? 'W64' : 'WAV';
    if (audio.codec_name?.startsWith('pcm')) return `${pcmBox}${bits && bits !== '0' ? ` ${bits}-bit` : ''}`;
    return audio.codec_name?.toUpperCase() ?? null;
  }
  return null;
}

export function buildClipMeta(input: ClipInput): ClipMeta {
  const streams = input.probe?.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && s.codec_name !== 'mjpeg' && s.codec_name !== 'png')
    ?? streams.find((s) => s.codec_type === 'video' && Number(s.nb_frames ?? 2) > 1);
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const formatTags = tagsLower(input.probe?.format?.tags);
  const sony = input.sony;
  const vendor = detectVendor(input.name, input.probe, sony);

  let rate: Rate | null = video ? parseRate(video.r_frame_rate) ?? parseRate(video.avg_frame_rate) : null;
  if (rate && rateValue(rate) > 240) rate = parseRate(video?.avg_frame_rate);
  if (sony?.formatFps && (!rate || Math.abs(rateValue(rate) - sony.formatFps) > 0.5)) {
    rate = isNtscRate(sony.formatFps) ? { num: Math.round(sony.formatFps) * 1000, den: 1001 } : { num: sony.formatFps, den: 1 };
  }
  const fps = rate ? rateValue(rate) : null;

  let frames: number | null = sony?.frames ?? (video?.nb_frames ? Number(video.nb_frames) : null);
  if (frames !== null && (!Number.isFinite(frames) || frames <= 0)) frames = null;
  let durationSec = frames !== null && fps ? frames / fps : Number(input.probe?.format?.duration ?? video?.duration ?? audio[0]?.duration ?? 0);
  if (!Number.isFinite(durationSec)) durationSec = 0;

  // Замедленная (S&Q 100/120 к/с в файл 25p) или ускоренная съёмка: запись длилась не столько, сколько файл.
  const captureFps = sony?.captureFps && fps && Math.abs(sony.captureFps - fps) > 0.5 ? sony.captureFps : null;
  const recordedSec = captureFps && frames ? frames / captureFps : durationSec;

  // Тайм-код: Sony XML → дорожка тайм-кода в контейнере → BWF у звуковых рекордеров.
  let containerTcText: string | undefined;
  for (const s of streams) {
    const t = tagsLower(s.tags).timecode;
    if (t) {
      containerTcText = t;
      break;
    }
  }
  containerTcText ??= formatTags.timecode;

  let tc: ClipTimecode | null = null;
  if (sony?.tc) {
    const actual = fps && isNtscRate(fps) ? (sony.tc.countRate * 1000) / 1001 : sony.tc.countRate;
    tc = {
      text: containerTcText ?? sony.tc.text,
      seconds: tcToSeconds(sony.tc, sony.tc.countRate, actual),
      countRate: sony.tc.countRate,
      drop: sony.tc.drop,
      source: 'sony-xml',
    };
  } else if (containerTcText && fps) {
    const parts = parseTc(containerTcText);
    const countRate = Math.round(fps);
    if (parts && parts.f < countRate) {
      tc = { text: containerTcText, seconds: tcToSeconds(parts, countRate, fps), countRate, drop: parts.drop, source: 'container' };
    }
  } else if (!video && formatTags.time_reference && audio[0]?.sample_rate) {
    const samples = Number(formatTags.time_reference);
    const sr = Number(audio[0].sample_rate);
    if (Number.isFinite(samples) && sr > 0) {
      const seconds = samples / sr;
      tc = { text: secondsToTcText(seconds, 25), seconds, countRate: 25, drop: false, source: 'bwf' };
    }
  }

  // Часы камеры.
  let clock: ClipClock | null = null;
  const fileNameTime = timeFromFilename(input.name);
  const apple = formatTags['com.apple.quicktime.creationdate'];
  const parsedApple = apple ? parseDateWithTz(apple) : null;
  const created = formatTags.creation_time ? parseDateWithTz(formatTags.creation_time) : null;
  const createdValid = created && created.epochSec > Date.UTC(2000, 0, 1) / 1000 ? created : null;

  if (sony?.creation) {
    clock = { epochSec: sony.creation.epochSec, precisionSec: 1, tzOffsetMin: sony.creation.tzOffsetMin, source: 'sony-xml' };
  } else if (parsedApple) {
    clock = { epochSec: parsedApple.epochSec, precisionSec: 1, tzOffsetMin: parsedApple.tzOffsetMin, source: 'container' };
  } else if (vendor === 'dji' && fileNameTime !== null) {
    clock = { epochSec: fileNameTime, precisionSec: 1, tzOffsetMin: null, source: 'filename', note: 'Время взято из имени файла DJI' };
  } else if (createdValid && (vendor === 'gopro' || vendor === 'dji') && createdValid.tzOffsetMin === 0) {
    clock = {
      epochSec: reinterpretUtcAsLocal(createdValid.epochSec),
      precisionSec: 1,
      tzOffsetMin: null,
      source: 'container',
      note: `${VENDOR_NAMES[vendor]} записывает местное время с пометкой UTC — прочитали как местное`,
    };
  } else if (!video && formatTags.date && /^\d{4}-\d{2}-\d{2}$/.test(formatTags.date) && /^\d{2}:\d{2}:\d{2}$/.test(formatTags.creation_time ?? '')) {
    // BWF у рекордеров: дата и время начала записи по их часам, местное время.
    const [y, mo, d] = formatTags.date.split('-').map(Number);
    const [h, mi, s] = formatTags.creation_time.split(':').map(Number);
    clock = { epochSec: localEpoch(y, mo, d, h, mi, s), precisionSec: 1, tzOffsetMin: null, source: 'container' };
  } else if (createdValid) {
    clock = { epochSec: createdValid.epochSec, precisionSec: 1, tzOffsetMin: createdValid.tzOffsetMin === 0 ? null : createdValid.tzOffsetMin, source: 'container' };
  } else if (fileNameTime !== null) {
    clock = { epochSec: fileNameTime, precisionSec: 1, tzOffsetMin: null, source: 'filename', note: 'Время взято из имени файла' };
  } else if (input.mtimeMs > 0) {
    // Дата изменения файла обычно совпадает с концом записи, но меняется при неаккуратном копировании.
    clock = { epochSec: input.mtimeMs / 1000 - recordedSec, precisionSec: 3, tzOffsetMin: null, source: 'file', note: 'Время взято из даты файла — проверьте, что файлы копировались без изменений' };
  }

  const make = sony?.make ?? formatTags['com.apple.quicktime.make'] ?? formatTags.make ?? (vendor ? VENDOR_NAMES[vendor] : undefined);
  const model = sony?.model ?? formatTags['com.apple.quicktime.model'] ?? formatTags.model;

  const playable = !!video && video.codec_name === 'h264' && PLAYABLE_PIX.has(video.pix_fmt ?? '');

  return {
    id: input.id,
    path: input.path,
    name: input.name,
    sizeBytes: input.sizeBytes,
    durationSec,
    recordedSec,
    captureFps,
    rate,
    frames,
    width: video?.width ?? sony?.width ?? null,
    height: video?.height ?? sony?.height ?? null,
    codec: video?.codec_name ?? audio[0]?.codec_name ?? null,
    codecLabel: codecLabel(video, audio[0], input.probe?.format?.format_name),
    hasVideo: !!video,
    audioChannels: audio.reduce((n, s) => n + (s.channels ?? 0), 0),
    audioSampleRate: audio[0]?.sample_rate ? Number(audio[0].sample_rate) : null,
    tc,
    clock,
    camera: {
      make,
      model: friendlyModel(make, model) ?? (vendor ? VENDOR_NAMES[vendor] : undefined),
      lens: sony?.lens,
      gamma: friendlyGamma(sony?.gamma),
      serial: sony?.serial,
    },
    proxyPath: input.proxyPath,
    playable,
  };
}
