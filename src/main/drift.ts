// Выровненная копия звука: запись растягивается на найденный ход часов и проверяется по звуку.
// Копия пишется под временным именем и получает настоящее только после проверки — неудачная удаляется,
// исходные файлы не меняются никогда.
import { once } from 'node:events';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Stretcher } from '../core/resample.ts';
import { FINE_SR, gccPhat } from '../core/audioFeatures.ts';
import { CHECK_LEN, CHECK_OFFSET, judgeCopy } from '../core/driftExport.ts';
import type { CheckVerdict, DriftCheck, DriftJob, DriftRendered } from '../core/driftExport.ts';
import { audioSamples } from './audio.ts';
import { probe, spawnTool } from './ffmpeg.ts';

const ECHO_SPAN = 0.12;
const NEAR_ECHO = 0.01; // отражение у самого микрофона (4–6 мс) — не повод отбрасывать место, как и в сверке

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

const CHECK_CONFIDENCE = 8; // для проверки — строже, чем в сверке: пики 6–7 в гулком зале бывают ложными

// Только что записанную копию антивирус Windows может ещё держать открытой — тогда ffmpeg её не прочтёт.
async function readFresh(path: string, at: number): Promise<Float32Array | null> {
  for (let i = 0; i < 4; i++) {
    const x = await audioSamples(path, at, CHECK_LEN, 0);
    if (x) return x;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

// Проверка копии по звуку: в каждом месте — насколько копия расходится со своей опорой. Опор в месте может
// быть несколько (по порядку предпочтения): берётся первая, с которой звук совпал чисто.
export async function verifyCopy(path: string, checks: DriftCheck[]): Promise<{ refId: string; at: number; lag: number }[]> {
  const off = Math.round(ECHO_SPAN * FINE_SR);
  const lags: { refId: string; at: number; lag: number }[] = [];
  const done = new Set<number>();
  for (const c of checks) {
    if (done.has(c.at) || c.refAt - ECHO_SPAN < 0) continue;
    const [x, y] = await Promise.all([
      readFresh(path, c.at),
      audioSamples(c.refPath, c.refAt - ECHO_SPAN, CHECK_LEN + 2 * ECHO_SPAN, c.refChannel, { start: c.refAudioStart ?? 0 }),
    ]);
    if (!x || !y || x.length < FINE_SR * CHECK_LEN * 0.9 || y.length < FINE_SR * CHECK_LEN * 0.9) continue;
    const g = gccPhat(x, y, FINE_SR, off, Math.round(CHECK_OFFSET * FINE_SR), off);
    if (!g || g.confidence < CHECK_CONFIDENCE) continue;
    if (g.rival >= 0.7 && Math.abs(g.lag - g.rivalLag) / FINE_SR > NEAR_ECHO) continue; // эхо зала: неясно, где прямой звук
    lags.push({ refId: c.refId, at: c.at, lag: g.lag / FINE_SR });
    done.add(c.at);
  }
  return lags;
}

// В Windows только что записанный файл бывает занят ещё долю секунды — антивирусом или уходящим ffmpeg:
// переименование тогда падает с EBUSY/EPERM. Пробуем ещё раз, до двух секунд.
async function settle(op: () => Promise<void>): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await op();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 10 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

interface Pending {
  job: DriftJob;
  part: string;
  outPath: string;
  durationSec?: number;
  verdict: CheckVerdict;
  error?: string;
}

// Все копии: растянуть, проверить, решить, переименовать или удалить. Копия файла без общего звука с камерами
// (продолжение разрезанной записи) проверке недоступна — её принимают, если копия другого файла того же
// устройства с тем же ходом часов проверку прошла.
export async function renderDriftCopies(jobs: DriftJob[], outDir: string, onProgress: (done: number) => void): Promise<DriftRendered[]> {
  const pending: Pending[] = [];
  for (const [i, job] of jobs.entries()) {
    const outPath = join(outDir, job.outName);
    const part = `${outPath}.part`;
    try {
      await mkdir(dirname(outPath), { recursive: true });
      const { durationSec } = await render(job, part, (f) => onProgress(i + f * 0.9));
      const verdict = judgeCopy(await verifyCopy(part, job.checks));
      pending.push({ job, part, outPath, durationSec, verdict });
    } catch (e) {
      await rm(part, { force: true }).catch(() => {});
      pending.push({ job, part, outPath, verdict: { ok: false, checked: 0, worst: null, spread: null }, error: e instanceof Error ? e.message : String(e) });
    }
    onProgress(i + 1);
  }
  const verified = new Set(pending.filter((p) => p.verdict.ok).map((p) => `${p.job.deviceId}|${p.job.ratio}`));
  const results: DriftRendered[] = [];
  for (const p of pending) {
    const bySibling = !p.verdict.ok && !p.error && p.verdict.checked === 0 && verified.has(`${p.job.deviceId}|${p.job.ratio}`);
    const ok = (p.verdict.ok || bySibling) && p.durationSec !== undefined;
    const base = { clipId: p.job.clipId, checked: p.verdict.checked, residualMs: p.verdict.worst === null ? null : p.verdict.worst * 1000, spreadMs: p.verdict.spread === null ? null : p.verdict.spread * 1000 };
    if (!ok) {
      await rm(p.part, { force: true }).catch(() => {});
      results.push({ ...base, ok: false, reason: p.error ? `ffmpeg: ${p.error}` : p.verdict.reason });
      continue;
    }
    try {
      await settle(() => rm(p.outPath, { force: true }));
      await settle(() => rename(p.part, p.outPath));
      results.push({ ...base, ok: true, outPath: p.outPath, durationSec: p.durationSec, ...(bySibling ? { reason: 'общего звука с камерами нет — ход часов проверен по другой записи того же устройства' } : {}) });
    } catch (e) {
      await rm(p.part, { force: true }).catch(() => {});
      results.push({ ...base, ok: false, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

export async function renderDriftCopy(job: DriftJob, outDir: string, onProgress: (frac: number) => void): Promise<DriftRendered> {
  return (await renderDriftCopies([job], outDir, onProgress))[0];
}
