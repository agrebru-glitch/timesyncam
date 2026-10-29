// Звук для сверки камер: ffmpeg вынимает кусок звука в 8 кГц моно, ядро превращает его в огибающую атак.
import { AUDIO_SAMPLE_RATE, envelope, peakDb } from '../core/audioSync.ts';
import type { AudioPiece } from '../core/audioSync.ts';
import { runTool } from './ffmpeg.ts';

const cache = new Map<string, AudioPiece>();
const CACHE_LIMIT = 400;

export async function audioEnvelope(path: string, startSec: number, durSec: number): Promise<AudioPiece | null> {
  const start = Math.max(0, startSec);
  const dur = durSec - (start - startSec);
  if (dur <= 0.5) return null;
  const key = `${path}|${start.toFixed(2)}|${dur.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const r = await runTool('ffmpeg', [
      '-v', 'error', '-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', path,
      '-vn', '-ac', '1', '-ar', String(AUDIO_SAMPLE_RATE), '-f', 'f32le', 'pipe:1',
    ], 60000);
    if (r.code !== 0 || r.stdout.length < 4) return null;
    const buf = r.stdout;
    const samples = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + Math.floor(buf.length / 4) * 4));
    const piece = { env: envelope(samples, AUDIO_SAMPLE_RATE), peakDb: peakDb(samples) };
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(key, piece);
    return piece;
  } catch {
    return null;
  }
}
