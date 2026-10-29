// Звук для сверки камер и волны на таймлинии. ffmpeg вынимает нужный кусок звука, ядро считает отпечаток.
import { AUDIO_SAMPLE_RATE, peakDb, SILENCE_DB, waveformPeaks } from '../core/audioSync.ts';
import type { AudioPiece } from '../core/audioSync.ts';
import { FEAT_SR, FINE_SR, pickChannel } from '../core/audioFeatures.ts';
import { runTool } from './ffmpeg.ts';

const featCache = new Map<string, AudioPiece>();
const waves = new Map<string, Uint8Array>();
const CACHE_LIMIT = 400;

function toFloat32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + Math.floor(buf.length / 4) * 4));
}

async function decode(path: string, startSec: number, durSec: number | null, args: string[]): Promise<Float32Array | null> {
  const seek = startSec > 0 ? ['-ss', startSec.toFixed(4)] : [];
  const len = durSec !== null ? ['-t', durSec.toFixed(4)] : [];
  try {
    const r = await runTool('ffmpeg', ['-v', 'error', ...seek, ...len, '-i', path, '-vn', ...args, '-f', 'f32le', 'pipe:1'], 180000);
    if (r.code !== 0 || r.stdout.length < 4) return null;
    return toFloat32(r.stdout);
  } catch {
    return null;
  }
}

// Отпечаток звука: оба канала по отдельности, программа берёт тот, где звук чётче.
export async function audioFeatures(path: string, startSec: number, durSec: number): Promise<AudioPiece | null> {
  const start = Math.max(0, startSec);
  const dur = durSec - (start - startSec);
  if (dur <= 0.5) return null;
  const key = `${path}|${start.toFixed(2)}|${dur.toFixed(2)}`;
  const hit = featCache.get(key);
  if (hit) return hit;
  const inter = await decode(path, start, dur, ['-ac', '2', '-ar', String(FEAT_SR)]);
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

// Волна выбранного канала на 48 кГц — для точной сверки.
export async function audioSamples(path: string, startSec: number, durSec: number, channel: number): Promise<Float32Array | null> {
  if (startSec < 0 || durSec <= 0) return null;
  return decode(path, startSec, durSec, ['-af', `pan=mono|c0=c${channel === 1 ? 1 : 0}`, '-ar', String(FINE_SR)]);
}

// Волна всего клипа для таймлинии. Считается один раз на клип и хранится, пока программа открыта.
export async function audioWaveform(path: string): Promise<Uint8Array | null> {
  const hit = waves.get(path);
  if (hit) return hit;
  const samples = await decode(path, 0, null, ['-ac', '1', '-ar', String(AUDIO_SAMPLE_RATE)]);
  if (!samples) return null;
  const peaks = waveformPeaks(samples, AUDIO_SAMPLE_RATE);
  waves.set(path, peaks);
  return peaks;
}
