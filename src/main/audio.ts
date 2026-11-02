// Звук для сверки камер и волны на таймлинии. ffmpeg вынимает нужный кусок звука, ядро считает отпечаток.
import { AUDIO_SAMPLE_RATE, peakDb, SILENCE_DB, waveformPeaks } from '../core/audioSync.ts';
import type { AudioPiece } from '../core/audioSync.ts';
import { BandEnergy, FEAT_RATE, FEAT_SR, FINE_SR, featuresFromEnergy, pickChannel } from '../core/audioFeatures.ts';
import { runTool, spawnTool } from './ffmpeg.ts';

const featCache = new Map<string, AudioPiece>();
const waves = new Map<string, Uint8Array>();
const CACHE_LIMIT = 400;

function toFloat32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + Math.floor(buf.length / 4) * 4));
}

// Перемотка: быстрая — до секунды перед нужным местом, последняя секунда — точная, с разбором звука.
// Быстрая перемотка в AAC (M4A, звук телефонов, GoPro, DJI) попадает на границу блока по 1024 сэмпла
// и ошибается на 5–20 мс; точная последняя секунда это исправляет и почти ничего не стоит.
export function seekArgs(startSec: number, durSec: number | null): { input: string[]; output: string[] } {
  const len = durSec !== null ? ['-t', durSec.toFixed(4)] : [];
  if (startSec <= 0) return { input: [], output: len };
  const fast = Math.max(0, startSec - 1);
  return { input: fast > 0 ? ['-ss', fast.toFixed(4)] : [], output: ['-ss', (startSec - fast).toFixed(4), ...len] };
}

// Где в клипе первый сэмпл звука. У части телефонов звук в файле начинается позже видео (realme — на 0,22 с):
// разбор с начала файла отдаёт звук с первого сэмпла, а перемотка -ss считает от начала файла — без поправки
// разбор целиком и окна расходятся на этот сдвиг. Поэтому все разборы идут по времени клипа, а до первого сэмпла
// звука — тишина. copy — звук, вынутый из клипа в отдельный файл (расширенный отчёт): его время начинается
// с первого сэмпла.
export interface AudioTiming {
  start: number;
  copy?: boolean;
}

export const clipTiming = (c: { audioStartSec?: number }): AudioTiming => ({ start: c.audioStartSec ?? 0 });

function withSilence(data: Float32Array, samples: number): Float32Array {
  const out = new Float32Array(samples + data.length);
  out.set(data, samples);
  return out;
}

// channels и sr — какими выходят сэмплы: тишина спереди должна быть в том же виде.
async function decode(path: string, startSec: number, durSec: number | null, args: string[], sr: number, channels: number, timing?: AudioTiming): Promise<Float32Array | null> {
  const first = timing?.start ?? 0;
  const pad = Math.max(0, first - startSec);
  const len = durSec === null ? null : durSec - pad;
  const silence = Math.round(pad * sr) * channels;
  if (len !== null && len <= 0) return new Float32Array(Math.round((durSec ?? 0) * sr) * channels);
  // Место в самом файле: у звука, вынутого в отдельный файл, время сдвинуто на начало звука в клипе.
  const from = Math.max(startSec, first) - (timing?.copy ? first : 0);
  const { input, output } = seekArgs(from, len);
  try {
    const r = await runTool('ffmpeg', ['-v', 'error', ...input, '-i', path, ...output, '-vn', ...args, '-f', 'f32le', 'pipe:1'], 180000);
    if (r.code !== 0 || r.stdout.length < 4) return null;
    const data = toFloat32(r.stdout);
    return silence ? withSilence(data, silence) : data;
  } catch {
    return null;
  }
}

// Отпечаток звука: оба канала по отдельности, программа берёт тот, где звук чётче.
export async function audioFeatures(path: string, startSec: number, durSec: number, timing?: AudioTiming): Promise<AudioPiece | null> {
  const start = Math.max(0, startSec);
  const dur = durSec - (start - startSec);
  if (dur <= 0.5) return null;
  const key = `${path}|${start.toFixed(2)}|${dur.toFixed(2)}`;
  const hit = featCache.get(key);
  if (hit) return hit;
  const inter = await decode(path, start, dur, ['-ac', '2', '-ar', String(FEAT_SR)], FEAT_SR, 2, timing);
  if (!inter) return null;
  const n = Math.floor(inter.length / 2);
  const ch = [new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    ch[0][i] = inter[2 * i];
    ch[1][i] = inter[2 * i + 1];
  }
  const picked = pickChannel(ch, FEAT_SR, peakDb, SILENCE_DB);
  const piece: AudioPiece = { feat: picked.feat, peakDb: picked.peakDb, channel: picked.channel };
  if (featCache.size > CACHE_LIMIT) featCache.delete(featCache.keys().next().value!);
  featCache.set(key, piece);
  return piece;
}

// Отпечаток всего файла — для сверки «все со всеми». Звук читается потоком, по кускам, и сразу
// превращается в громкость по полосам для обоих каналов; берётся канал, где атаки звука чётче.
// Хранится, пока открыта программа (в фоновом потоке сверки).
const wholeCache = new Map<string, Promise<AudioPiece | null>>();

export function audioWholeFeatures(path: string, durationSec: number, timing?: AudioTiming): Promise<AudioPiece | null> {
  const hit = wholeCache.get(path);
  if (hit) return hit;
  const job = readWhole(path, durationSec, timing?.start ?? 0);
  wholeCache.set(path, job);
  return job;
}

// first — где в клипе первый сэмпл звука: до него — тишина, чтобы отпечаток шёл по времени клипа.
function readWhole(path: string, durationSec: number, first: number): Promise<AudioPiece | null> {
  return new Promise((resolve) => {
    const expected = Math.ceil(durationSec * FEAT_RATE) + 16;
    const ch = [new BandEnergy(FEAT_SR, expected), new BandEnergy(FEAT_SR, expected)];
    const silence = Math.round(first * FEAT_SR);
    if (silence > 0) for (const c of ch) c.push(new Float32Array(silence));
    let rest: Buffer = Buffer.alloc(0);
    let same = true; // каналы одинаковые по всему файлу (моно, разложенное на два) — второй не берём
    const child = spawnTool('ffmpeg', ['-v', 'error', '-i', path, '-vn', '-ac', '2', '-ar', String(FEAT_SR), '-f', 'f32le', 'pipe:1']);
    child.stdout.on('data', (d: Buffer) => {
      const buf = rest.length ? Buffer.concat([rest, d]) : d;
      const usable = Math.floor(buf.length / 8) * 8;
      rest = buf.subarray(usable);
      const inter = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable));
      const n = inter.length / 2;
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        l[i] = inter[2 * i];
        r[i] = inter[2 * i + 1];
        if (same && Math.abs(l[i] - r[i]) > 1e-6) same = false;
      }
      ch[0].push(l);
      ch[1].push(r);
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0 || ch[0].frames < 2) return resolve(null);
      const db = (peak: number) => (peak > 0 ? 20 * Math.log10(peak) : -200);
      const cands = (same ? [0] : [0, 1]).map((i) => ({ i, peakDb: db(ch[i].peak), raw: featuresFromEnergy(ch[i].energy(), ch[i].frames) }));
      const loud = cands.filter((c) => c.peakDb >= SILENCE_DB);
      const best = (loud.length ? loud : cands).reduce((a, b) => (b.raw.clarity > a.raw.clarity ? b : a));
      resolve({ feat: best.raw.feat, peakDb: Math.max(...cands.map((c) => c.peakDb)), channel: best.i });
    });
  });
}

// Волна выбранного канала на 48 кГц — для точной сверки.
export async function audioSamples(path: string, startSec: number, durSec: number, channel: number, timing?: AudioTiming): Promise<Float32Array | null> {
  if (startSec < 0 || durSec <= 0) return null;
  return decode(path, startSec, durSec, ['-af', `pan=mono|c0=c${channel === 1 ? 1 : 0}`, '-ar', String(FINE_SR)], FINE_SR, 1, timing);
}

// Волна всего клипа для таймлинии. Считается один раз на клип и хранится, пока программа открыта.
export async function audioWaveform(path: string, timing?: AudioTiming): Promise<Uint8Array | null> {
  const hit = waves.get(path);
  if (hit) return hit;
  const samples = await decode(path, 0, null, ['-ac', '1', '-ar', String(AUDIO_SAMPLE_RATE)], AUDIO_SAMPLE_RATE, 1, timing);
  if (!samples) return null;
  const peaks = waveformPeaks(samples, AUDIO_SAMPLE_RATE);
  waves.set(path, peaks);
  return peaks;
}
