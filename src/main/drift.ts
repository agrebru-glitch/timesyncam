// Выровненная копия звука: запись растягивается на найденный ход часов и проверяется по звуку.
// Копия пишется под временным именем и получает настоящее только после проверки — неудачная удаляется,
// исходные файлы не меняются никогда.
import { once } from 'node:events';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Stretcher } from '../core/resample.ts';
import { FINE_SR, gccPhat } from '../core/audioFeatures.ts';
import { CHECK_LEN } from '../core/driftExport.ts';
import type { DriftCheck, DriftJob, DriftRendered } from '../core/driftExport.ts';
import { audioSamples } from './audio.ts';
import { probe, spawnTool } from './ffmpeg.ts';

const CHECK_RANGE = 0.06; // копию ищем в ±60 мс от расчётного места: так видна и ошибка хода часов
const ECHO_SPAN = 0.12;
const CHECK_TOLERANCE = 0.008; // копия годится, если расхождение везде меньше четверти кадра
const CHECK_MIN = 2; // и если её удалось проверить хотя бы в двух местах

// PCM той же разрядности, что у оригинала; сжатый звук — в 24 бита.
function pcmCodec(codec: string | undefined): string {
  return codec && /^pcm_(s16le|s24le|s32le|f32le)$/.test(codec) ? codec : 'pcm_s24le';
}

async function render(job: DriftJob, outPath: string, onProgress: (frac: number) => void): Promise<{ durationSec: number }> {
  const info = await probe(job.path);
  const stream = info?.streams?.find((s) => s.codec_type === 'audio');
  if (!info || !stream?.channels || !stream.sample_rate) throw new Error('не удалось прочитать звук');
  const ch = stream.channels;
  const sr = Number(stream.sample_rate);
  const total = Math.max(1, Math.round(Number(info.format?.duration ?? stream.duration ?? 0) * sr));
  // BWF: время начала записи остаётся тем же — копия начинается там же, где оригинал.
  const tags = info.format?.tags ?? {};
  const meta: string[] = [];
  if (tags.time_reference) meta.push('-metadata', `time_reference=${tags.time_reference}`);
  if (tags.date) meta.push('-metadata', `origination_date=${tags.date}`);
  if (tags.creation_time && /^\d{2}:\d{2}:\d{2}$/.test(tags.creation_time)) meta.push('-metadata', `origination_time=${tags.creation_time}`);
  if (tags.encoded_by) meta.push('-metadata', `originator=${tags.encoded_by}`);
  meta.push('-metadata', `coding_history=${[tags.coding_history?.trim(), `A=PCM,F=${sr},T=TimesynCam drift ${job.ppm.toFixed(2)} ppm`].filter(Boolean).join('\r\n')}`);

  const dec = spawnTool('ffmpeg', ['-v', 'error', '-i', job.path, '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1']);
  const enc = spawnTool('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(sr), '-ac', String(ch), '-i', 'pipe:0', '-c:a', pcmCodec(stream.codec_name), '-write_bext', '1', '-rf64', 'auto', ...meta, '-f', 'wav', outPath]);
  let encErr = '';
  enc.stderr.on('data', (d: Buffer) => (encErr += d.toString()));
  dec.stderr.on('data', () => {});
  const encDone = once(enc, 'close');
  const decDone = once(dec, 'close');
  const st = new Stretcher(ch, job.ratio);
  let rest = Buffer.alloc(0);
  let frames = 0;
  const write = async (f: Float32Array) => {
    if (f.length && !enc.stdin.write(Buffer.from(f.buffer, f.byteOffset, f.byteLength))) await once(enc.stdin, 'drain');
  };
  for await (const chunk of dec.stdout as AsyncIterable<Buffer>) {
    const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    const usable = buf.length - (buf.length % (4 * ch));
    rest = Buffer.from(buf.subarray(usable));
    if (!usable) continue;
    const floats = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable));
    frames += floats.length / ch;
    await write(st.push(floats));
    onProgress(Math.min(1, frames / total));
  }
  await write(st.finish(frames));
  enc.stdin.end();
  const [[decCode], [encCode]] = await Promise.all([decDone, encDone]);
  if (decCode !== 0 || encCode !== 0) throw new Error(`ffmpeg: ${encErr.trim().split('\n').pop() ?? 'ошибка записи'}`);
  return { durationSec: Stretcher.outputFrames(frames, job.ratio) / sr };
}

// Проверка копии по звуку: в каждом месте она должна совпасть с опорой там, где рассчитано.
export async function verifyCopy(path: string, checks: DriftCheck[]): Promise<{ checked: number; worst: number | null }> {
  const off = Math.round(ECHO_SPAN * FINE_SR);
  const residuals: number[] = [];
  for (const c of checks) {
    if (c.refAt - ECHO_SPAN < 0) continue;
    const [x, y] = await Promise.all([
      audioSamples(path, c.at, CHECK_LEN, 0),
      audioSamples(c.refPath, c.refAt - ECHO_SPAN, CHECK_LEN + 2 * ECHO_SPAN, c.refChannel),
    ]);
    if (!x || !y || x.length < FINE_SR * CHECK_LEN * 0.9 || y.length < FINE_SR * CHECK_LEN * 0.9) continue;
    const g = gccPhat(x, y, FINE_SR, off, Math.round(CHECK_RANGE * FINE_SR), off);
    if (!g || g.confidence < 6 || g.rival >= 0.7) continue;
    residuals.push(Math.abs(g.lag) / FINE_SR);
  }
  return { checked: residuals.length, worst: residuals.length ? Math.max(...residuals) : null };
}

export async function renderDriftCopy(job: DriftJob, outDir: string, onProgress: (frac: number) => void): Promise<DriftRendered> {
  const outPath = join(outDir, job.outName);
  const part = `${outPath}.part`;
  try {
    const { durationSec } = await render(job, part, (f) => onProgress(f * 0.9));
    const { checked, worst } = await verifyCopy(part, job.checks);
    onProgress(1);
    // Непроверенную копию в таймлинию не ставим: неверный коэффициент как раз и не даёт её сверить.
    if (worst === null || checked < CHECK_MIN || worst > CHECK_TOLERANCE) {
      await rm(part, { force: true });
      const reason = worst !== null && worst > CHECK_TOLERANCE ? `копия расходится с видео на ${Math.round(worst * 1000)} мс` : 'копию не удалось проверить по звуку';
      return { clipId: job.clipId, ok: false, checked, residualMs: worst === null ? null : worst * 1000, reason };
    }
    await rm(outPath, { force: true });
    await rename(part, outPath);
    return { clipId: job.clipId, ok: true, outPath, durationSec, checked, residualMs: worst === null ? null : worst * 1000 };
  } catch (e) {
    await rm(part, { force: true }).catch(() => {});
    return { clipId: job.clipId, ok: false, checked: 0, residualMs: null, reason: e instanceof Error ? e.message : String(e) };
  }
}
