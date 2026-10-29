// Сверка камер по звуку — вспомогательный шаг после раскладки по тайм-коду и часам.
// Сравниваются не сами волны, а «атаки» звука (хлопки, удары, начала слов): так совпадают
// и встроенный микрофон камеры, и петличка, и рекордер, даже при разной громкости.
import type { Camera, ClipMeta, Issue, Placement, SyncResult, TimeSource } from './types.ts';
import { formatClockTime, formatDurationHuman } from './format.ts';

export const ENV_RATE = 100; // кадров огибающей в секунду: шаг 10 мс
export const AUDIO_SAMPLE_RATE = 8000;

const MIN_OVERLAP = 6; // секунд общего звука, меньше — не сравниваем
const MAX_WINDOW = 40; // секунд звука в одной точке
const PROBE_LEN = 20; // секунд звука в одной пробе широкого поиска
const ACCEPT_SCORE = 0.25;
const ACCEPT_RATIO = 1.3;
const STRONG_SCORE = 0.45; // настолько уверенное совпадение может сменить поправку без подтверждения
const STRONG_RATIO = 1.8;
const CONSISTENT = 0.12; // ±3 кадра при 25 к/с: точка согласна с текущей поправкой
const NEIGHBOUR = 0.15; // пик в пределах 150 мс от лучшего не считается конкурентом

// Огибающая атак: энергия по 10 мс в логарифме, берём только рост, затем приводим к нулевому среднему.
export function envelope(samples: Float32Array, sampleRate: number): Float32Array {
  const hop = Math.round(sampleRate / ENV_RATE);
  const n = Math.floor(samples.length / hop);
  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = i * hop; k < (i + 1) * hop; k++) s += samples[k] * samples[k];
    energy[i] = Math.log(1e-7 + s / hop);
  }
  const onset = new Float32Array(n);
  for (let i = 1; i < n; i++) onset[i] = Math.max(0, energy[i] - energy[i - 1]);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += onset[i];
  mean /= n || 1;
  let sd = 0;
  for (let i = 0; i < n; i++) sd += (onset[i] - mean) ** 2;
  sd = Math.sqrt(sd / (n || 1)) || 1;
  for (let i = 0; i < n; i++) onset[i] = (onset[i] - mean) / sd;
  return onset;
}

export interface Match {
  lag: number; // в кадрах огибающей, с долями
  score: number; // нормированная корреляция в лучшей точке
  ratio: number; // во сколько раз лучший пик выше ближайшего соперника
}

// target[i] при нулевом сдвиге соответствует ref[i + refOffset]. Ищем сдвиг в пределах ±maxLag.
export function correlate(target: Float32Array, ref: Float32Array, refOffset: number, maxLag: number): Match | null {
  const scores = new Float64Array(2 * maxLag + 1);
  let best = -Infinity;
  let bestIdx = -1;
  for (let l = -maxLag; l <= maxLag; l++) {
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    let count = 0;
    for (let i = 0; i < target.length; i++) {
      const j = i + refOffset + l;
      if (j < 0 || j >= ref.length) continue;
      const a = target[i];
      const b = ref[j];
      sab += a * b;
      saa += a * a;
      sbb += b * b;
      count++;
    }
    const s = count > target.length * 0.6 && saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : -1;
    scores[l + maxLag] = s;
    if (s > best) {
      best = s;
      bestIdx = l + maxLag;
    }
  }
  if (bestIdx < 0 || best <= 0) return null;
  const guard = Math.round(NEIGHBOUR * ENV_RATE);
  let rival = 1e-6;
  for (let k = 0; k < scores.length; k++) {
    if (Math.abs(k - bestIdx) > guard && scores[k] > rival) rival = scores[k];
  }
  // Уточнение между кадрами огибающей по параболе.
  let frac = 0;
  if (bestIdx > 0 && bestIdx < scores.length - 1) {
    const y0 = scores[bestIdx - 1];
    const y1 = scores[bestIdx];
    const y2 = scores[bestIdx + 1];
    const d = y0 - 2 * y1 + y2;
    if (d < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d));
  }
  return { lag: bestIdx - maxLag + frac, score: best, ratio: best / rival };
}

// Быстрое преобразование Фурье (по месту, длина — степень двойки).
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] /= n;
  }
}

// Поиск куска target во всей записи ref: target[0] совпадает с ref[offset]. Для случая, когда часы камеры
// сбиты на минуты или часы и рядом по времени общего звука нет.
export function findInside(target: Float32Array, ref: Float32Array): (Match & { offset: number }) | null {
  const n = target.length;
  const m = ref.length;
  if (n < MIN_OVERLAP * ENV_RATE || m < MIN_OVERLAP * ENV_RATE) return null;
  let size = 1;
  while (size < n + m) size <<= 1;
  const ar = new Float64Array(size);
  const ai = new Float64Array(size);
  const br = new Float64Array(size);
  const bi = new Float64Array(size);
  for (let i = 0; i < m; i++) ar[i] = ref[i];
  for (let i = 0; i < n; i++) br[i] = target[i];
  fft(ar, ai, false);
  fft(br, bi, false);
  for (let i = 0; i < size; i++) {
    const r = ar[i] * br[i] + ai[i] * bi[i];
    const im = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = r;
    ai[i] = im;
  }
  fft(ar, ai, true);
  // ar[k] = Σ ref[i + k]·target[i]; отрицательные сдвиги лежат в конце массива.
  const p2r = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) p2r[i + 1] = p2r[i] + ref[i] * ref[i];
  const p2t = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) p2t[i + 1] = p2t[i] + target[i] * target[i];
  const minOverlap = Math.max(MIN_OVERLAP * ENV_RATE, Math.ceil(Math.min(n, m) * 0.6));
  if (n + m - 2 * minOverlap < 0) return null;
  const lo = -(n - minOverlap);
  const hi = m - minOverlap;
  const scores = new Float64Array(hi - lo + 1);
  let best = -Infinity;
  let bestK = 0;
  for (let k = lo; k <= hi; k++) {
    const raw = ar[k >= 0 ? k : size + k];
    const i0 = Math.max(0, -k);
    const i1 = Math.min(n, m - k);
    const st = p2t[i1] - p2t[i0];
    const sr = p2r[i1 + k] - p2r[i0 + k];
    const s = st > 0 && sr > 0 ? raw / Math.sqrt(st * sr) : -1;
    scores[k - lo] = s;
    if (s > best) {
      best = s;
      bestK = k;
    }
  }
  if (best <= 0) return null;
  const guard = Math.round(NEIGHBOUR * ENV_RATE);
  let rival = 1e-6;
  for (let k = lo; k <= hi; k++) if (Math.abs(k - bestK) > guard && scores[k - lo] > rival) rival = scores[k - lo];
  return { offset: bestK, lag: bestK, score: best, ratio: best / rival };
}

export interface AudioPiece {
  env: Float32Array;
  peakDb: number; // пик в dBFS: по нему видно, что микрофон был выключен
}

export const SILENCE_DB = -70;

// Волна для таймлинии: пик каждых 10 мс в логарифмической шкале, 0…255.
// Логарифм нужен, чтобы тихий микрофон камеры и громкий рекордер выглядели сравнимо.
export const WAVE_RATE = 100;
const WAVE_FLOOR_DB = -54;

export function waveformPeaks(samples: Float32Array, sampleRate: number): Uint8Array {
  const hop = Math.round(sampleRate / WAVE_RATE);
  const n = Math.ceil(samples.length / hop);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let peak = 0;
    const end = Math.min(samples.length, (i + 1) * hop);
    for (let k = i * hop; k < end; k++) {
      const v = Math.abs(samples[k]);
      if (v > peak) peak = v;
    }
    const db = peak > 0 ? 20 * Math.log10(peak) : -200;
    out[i] = Math.round(Math.max(0, Math.min(1, (db - WAVE_FLOOR_DB) / -WAVE_FLOOR_DB)) * 255);
  }
  return out;
}

export function peakDb(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  return peak > 0 ? 20 * Math.log10(peak) : -200;
}

export type EnvelopeFetch = (clip: ClipMeta, startSec: number, durSec: number) => Promise<AudioPiece | null>;

export interface AudioAnchor {
  cameraId: string;
  clipId: string;
  refCameraId: string;
  refClipId: string;
  at: number; // середина окна на таймлинии
  correction: number; // на сколько секунд звук предлагает сдвинуть клип
  score: number;
  ratio: number;
  accepted: boolean; // совпадение уверенное
  // Что точка сделала: задала поправку, подтвердила текущую, сменила её с этого клипа, была отброшена.
  role: 'start' | 'confirm' | 'shift' | 'ignored' | 'weak';
}

export type AudioCameraStatus =
  | 'reference' // опорная: по ней сверяются остальные
  | 'applied' // поправка по звуку применена
  | 'confirmed' // звук подтвердил раскладку, поправка меньше кадра
  | 'checked' // камера с точным тайм-кодом: только сверили
  | 'no-overlap' // нет общего звука с другими камерами
  | 'no-match' // общий звук есть, но совпадения не нашлось
  | 'no-audio'
  | 'silent' // звуковая дорожка есть, но в ней тишина — микрофон был выключен
  | 'disabled';

export interface AudioCameraResult {
  cameraId: string;
  status: AudioCameraStatus;
  model: 'single' | 'per-anchor' | 'per-clip' | null;
  correction: number | null; // поправка в начале съёмки
  steps: { from: number; correction: number }[]; // где и на сколько менялась поправка
  anchors: AudioAnchor[];
  wideShift?: number | null; // сдвиг всей камеры, найденный поиском по всей записи
}

export interface AudioSyncResult {
  cameras: AudioCameraResult[];
  corrections: Record<string, number>; // поправка каждого клипа в секундах
  issues: Issue[];
}

export interface AudioOptions {
  searchSec: number;
  maxAnchors: number;
  isEnabled: (cameraId: string) => boolean;
  onProgress?: (done: number, total: number) => void;
  concurrency?: number;
}

const hasAudio = (c: ClipMeta) => c.audioChannels > 0 && c.captureFps === null;

interface Pair {
  target: Placement;
  ref: Placement;
  ws: number;
  we: number;
}

let issueSeq = 0;
function issue(partial: Omit<Issue, 'id'>): Issue {
  issueSeq += 1;
  return { id: `a${issueSeq}`, ...partial };
}

// Окна для сверки: пересечения клипов камеры с клипами уже выровненных камер.
function findPairs(targets: Placement[], refs: Placement[], startOf: (p: Placement) => number): Pair[] {
  const pairs: Pair[] = [];
  for (const t of targets) {
    const ts = startOf(t);
    const te = ts + (t.end - t.start);
    let bestPair: Pair | null = null;
    for (const r of refs) {
      const rs = startOf(r);
      const re = rs + (r.end - r.start);
      const os = Math.max(ts, rs);
      const oe = Math.min(te, re);
      if (oe - os < MIN_OVERLAP) continue;
      if (!bestPair || oe - os > bestPair.we - bestPair.ws) {
        const mid = (os + oe) / 2;
        const half = Math.min(MAX_WINDOW, oe - os) / 2;
        bestPair = { target: t, ref: r, ws: mid - half, we: mid + half };
      }
    }
    if (bestPair) pairs.push(bestPair);
  }
  return pairs;
}

// Несколько точек, разнесённых по всей съёмке: начало, середина, конец.
function spreadPick(pairs: Pair[], count: number): Pair[] {
  if (pairs.length <= count) return pairs;
  const sorted = [...pairs].sort((a, b) => a.ws - b.ws);
  const t0 = sorted[0].ws;
  const t1 = sorted[sorted.length - 1].we;
  const bin = (t1 - t0) / count;
  const picked: Pair[] = [];
  for (let k = 0; k < count; k++) {
    const inBin = sorted.filter((p) => p.ws >= t0 + k * bin && p.ws < t0 + (k + 1) * bin + (k === count - 1 ? 1 : 0));
    if (inBin.length) picked.push(inBin.reduce((a, b) => (b.we - b.ws > a.we - a.ws ? b : a)));
  }
  return picked;
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export async function refineByAudio(cameras: Camera[], coarse: SyncResult, fetch: EnvelopeFetch, opts: AudioOptions): Promise<AudioSyncResult> {
  const clipById = new Map<string, ClipMeta>();
  for (const cam of cameras) for (const c of cam.clips) clipById.set(c.id, c);
  const sourceOf = new Map<string, TimeSource | null>(coarse.cameras.map((c) => [c.cameraId, c.timeSource]));
  const placementsOf = (camId: string) => coarse.placements.filter((p) => p.cameraId === camId && hasAudio(clipById.get(p.clipId)!));
  const corrections: Record<string, number> = {};
  const startOf = (p: Placement) => p.start + (corrections[p.clipId] ?? 0);
  const results = new Map<string, AudioCameraResult>();
  const issues: Issue[] = [];
  const nameOf = (id: string) => cameras.find((c) => c.id === id)?.name ?? '';

  const withAudio = cameras.filter((c) => placementsOf(c.id).length > 0);
  for (const cam of cameras) {
    if (!withAudio.includes(cam)) {
      results.set(cam.id, { cameraId: cam.id, status: cam.clips.length ? 'no-audio' : 'no-overlap', model: null, correction: null, steps: [], anchors: [] });
    }
  }
  if (withAudio.length < 2) {
    for (const cam of withAudio) results.set(cam.id, { cameraId: cam.id, status: 'no-overlap', model: null, correction: null, steps: [], anchors: [] });
    return { cameras: cameras.map((c) => results.get(c.id)!), corrections, issues };
  }

  const overlapWith = (a: string, set: string[]) => {
    let total = 0;
    for (const p of placementsOf(a)) for (const id of set) for (const q of placementsOf(id)) {
      total += Math.max(0, Math.min(p.end, q.end) - Math.max(p.start, q.start));
    }
    return total;
  };

  // Опора: камеры с точным тайм-кодом, иначе — камера, у которой больше всего общего звука с остальными.
  const absolute = withAudio.filter((c) => sourceOf.get(c.id) === 'timecode').map((c) => c.id);
  const fixed: string[] = absolute.length ? [...absolute] : [
    withAudio.map((c) => c.id).sort((a, b) => overlapWith(b, withAudio.map((x) => x.id).filter((x) => x !== b)) - overlapWith(a, withAudio.map((x) => x.id).filter((x) => x !== a)))[0],
  ];
  const queue = withAudio.map((c) => c.id).filter((id) => !fixed.includes(id));

  // Камеры с точным тайм-кодом тоже сверяем между собой — только чтобы сообщить о расхождении.
  const plans: { camId: string; pairs: Pair[]; checkOnly: boolean }[] = [];
  const planFor = (camId: string, refs: string[], checkOnly: boolean) => {
    const refPlacements = refs.flatMap((id) => placementsOf(id));
    let pairs = findPairs(placementsOf(camId), refPlacements, startOf);
    const perClip = sourceOf.get(camId) === 'clock' && !checkOnly;
    if (!perClip) pairs = spreadPick(pairs, opts.maxAnchors);
    return { camId, pairs, checkOnly };
  };

  const totalEstimate = () => plans.reduce((n, p) => n + p.pairs.length, 0);
  let done = 0;
  const searchFrames = Math.round(opts.searchSec * ENV_RATE);

  // Тишина в звуке камеры: считаем, сколько кусков пришли пустыми, а сколько со звуком.
  const heard = new Map<string, { silent: number; loud: number }>();
  const listen = (camId: string, piece: AudioPiece | null): Float32Array | null => {
    if (!piece) return null;
    const h = heard.get(camId) ?? { silent: 0, loud: 0 };
    const silent = piece.peakDb < SILENCE_DB;
    if (silent) h.silent++;
    else h.loud++;
    heard.set(camId, h);
    return silent ? null : piece.env;
  };
  const isSilent = (camId: string) => {
    const h = heard.get(camId);
    return !!h && h.silent > 0 && h.loud === 0;
  };

  const measure = async (pair: Pair): Promise<AudioAnchor | null> => {
    const tClip = clipById.get(pair.target.clipId)!;
    const rClip = clipById.get(pair.ref.clipId)!;
    const tStart = startOf(pair.target);
    const rStart = startOf(pair.ref);
    const rs0 = Math.max(rStart, pair.ws - opts.searchSec);
    const re0 = Math.min(rStart + (pair.ref.end - pair.ref.start), pair.we + opts.searchSec);
    const [tPiece, rPiece] = await Promise.all([
      fetch(tClip, pair.ws - tStart, pair.we - pair.ws),
      fetch(rClip, rs0 - rStart, re0 - rs0),
    ]);
    const tEnv = listen(pair.target.cameraId, tPiece);
    const rEnv = listen(pair.ref.cameraId, rPiece);
    done++;
    opts.onProgress?.(done, Math.max(done, totalEstimate()));
    if (!tEnv || !rEnv || tEnv.length < MIN_OVERLAP * ENV_RATE * 0.8) return null;
    const refOffset = Math.round((pair.ws - rs0) * ENV_RATE);
    const m = correlate(tEnv, rEnv, refOffset, searchFrames);
    if (!m) return null;
    // Поправка считается от исходной раскладки по тайм-коду, с учётом уже найденного сдвига камеры.
    const correction = (tStart - pair.target.start) + rs0 - pair.ws + (refOffset + m.lag) / ENV_RATE;
    return {
      cameraId: pair.target.cameraId,
      clipId: pair.target.clipId,
      refCameraId: pair.ref.cameraId,
      refClipId: pair.ref.clipId,
      at: (pair.ws + pair.we) / 2,
      correction,
      score: m.score,
      ratio: m.ratio,
      accepted: m.score >= ACCEPT_SCORE && m.ratio >= ACCEPT_RATIO,
      role: 'weak',
    };
  };

  const conc = opts.concurrency ?? 4;

  // Сначала проверяем опорные камеры между собой.
  if (absolute.length > 1) {
    for (const id of absolute.slice(1)) plans.push(planFor(id, [absolute[0]], true));
  }
  for (const p of plans) {
    const anchors = (await pool(p.pairs, conc, measure)).filter((a): a is AudioAnchor => !!a);
    const ok = anchors.filter((a) => a.accepted);
    for (const a of ok) a.role = 'confirm';
    const corr = ok.length ? median(ok.map((a) => a.correction)) : null;
    results.set(p.camId, { cameraId: p.camId, status: 'checked', model: null, correction: corr, steps: [], anchors });
    if (corr !== null && Math.abs(corr) > 0.06) {
      issues.push(issue({
        severity: 'info',
        cameraId: p.camId,
        title: `По звуку «${nameOf(p.camId)}» расходится с «${nameOf(absolute[0])}» на ${formatDurationHuman(corr)}`,
        details: 'У обеих камер точный тайм-код, поэтому раскладка не менялась. Скорее всего, камеры стояли далеко друг от друга: звук идёт около 340 м/с. Проверьте стыковку по картинке.',
        actions: [{ kind: 'open-faq', anchor: 'manual-sync' }],
      }));
    }
  }
  for (const id of fixed) if (!results.has(id)) results.set(id, { cameraId: id, status: 'reference', model: null, correction: null, steps: [], anchors: [] });

  // Широкий поиск: часы камеры сбиты на минуты или часы, и рядом по времени общего звука нет.
  // Берём до трёх самых длинных клипов камеры и ищем их звук во всех клипах уже выровненных камер.
  const wideSearch = async (camId: string): Promise<{ shift: number; probes: number } | null> => {
    const targets = [...placementsOf(camId)].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 3);
    const refs = fixed.flatMap((id) => placementsOf(id));
    if (!targets.length || !refs.length) return null;
    // Сначала звук самой камеры: если он пустой, искать нечего. Короткие пробы в начале, середине и конце клипа:
    // общий звук с другой камерой может длиться всего десяток секунд.
    const probes: { t: Placement; start: number; env: Float32Array }[] = [];
    for (const t of targets) {
      const dur = t.end - t.start;
      const probeLen = Math.min(PROBE_LEN, dur - 1);
      if (probeLen < MIN_OVERLAP * 1.5) continue;
      const starts = dur - probeLen < 4 ? [(dur - probeLen) / 2] : [0.5, (dur - probeLen) / 2, dur - probeLen - 0.5];
      for (const probeStart of starts) {
        const env = listen(camId, await fetch(clipById.get(t.clipId)!, probeStart, probeLen));
        done++;
        opts.onProgress?.(done, Math.max(done, totalEstimate() + targets.length * 3));
        if (env) probes.push({ t, start: probeStart, env });
      }
    }
    if (!probes.length) return null;
    const refEnvs = await pool(refs, conc, async (r) => listen(r.cameraId, await fetch(clipById.get(r.clipId)!, 0, r.end - r.start)));
    const found: { shift: number; score: number; ratio: number }[] = [];
    for (const { t, start: probeStart, env: probe } of probes) {
      const hits = refs.map((r, i) => {
        const env = refEnvs[i];
        const m = env ? findInside(probe, env) : null;
        return m ? { shift: startOf(r) + m.offset / ENV_RATE - (t.start + probeStart), score: m.score, ratio: m.ratio } : null;
      }).filter((h): h is { shift: number; score: number; ratio: number } => !!h).sort((a, b) => b.score - a.score);
      if (!hits.length) continue;
      const best = hits[0];
      const rivalOther = hits.find((h) => Math.abs(h.shift - best.shift) > NEIGHBOUR)?.score ?? 0;
      found.push({ shift: best.shift, score: best.score, ratio: Math.min(best.ratio, best.score / Math.max(rivalOther, 1e-6)) });
    }
    const good = found.filter((f) => f.score >= ACCEPT_SCORE && f.ratio >= ACCEPT_RATIO);
    if (!good.length) return null;
    const m = median(good.map((f) => f.shift));
    const agree = good.filter((f) => Math.abs(f.shift - m) <= 0.2);
    const confident = agree.length >= 2 || (agree.length === 1 && agree[0].score >= STRONG_SCORE && agree[0].ratio >= STRONG_RATIO);
    return confident ? { shift: median(agree.map((f) => f.shift)), probes: agree.length } : null;
  };

  // Остальные камеры — по очереди, начиная с той, у которой больше общего звука с уже выровненными.
  while (queue.length) {
    queue.sort((a, b) => overlapWith(b, fixed) - overlapWith(a, fixed));
    const camId = queue.shift()!;
    const enabled = opts.isEnabled(camId);
    let plan = planFor(camId, fixed, false);
    plans.push(plan);
    let anchors = (await pool(plan.pairs, conc, measure)).filter((a): a is AudioAnchor => !!a);
    let wide: { shift: number; probes: number } | null = null;
    if (enabled && !anchors.some((a) => a.accepted)) {
      wide = await wideSearch(camId);
      if (wide) {
        for (const p of placementsOf(camId)) corrections[p.clipId] = wide.shift;
        plan = planFor(camId, fixed, false);
        plans.push(plan);
        anchors = (await pool(plan.pairs, conc, measure)).filter((a): a is AudioAnchor => !!a);
      }
    }
    if (plan.pairs.length === 0 && !wide) {
      results.set(camId, { cameraId: camId, status: 'no-overlap', model: null, correction: null, steps: [], anchors: [], wideShift: null });
      issues.push(issue({
        severity: 'info',
        cameraId: camId,
        title: `«${nameOf(camId)}» не с чем сверить по звуку`,
        details: 'Рядом по времени клипы этой камеры не идут одновременно с другими камерами, а поиск по всей записи совпадения не нашёл. Камера осталась по тайм-коду и часам.',
        actions: [],
      }));
      fixed.push(camId);
      continue;
    }
    const res = combine(camId, anchors, sourceOf.get(camId) ?? 'clock', placementsOf(camId), enabled, coarse.displayTzOffsetMin);
    res.result.wideShift = wide?.shift ?? null;
    if (wide && res.result.status === 'no-match') {
      // Точки рядом не подтвердили, но широкий поиск был уверенным — оставляем общий сдвиг камеры.
      for (const p of placementsOf(camId)) res.corrections[p.clipId] = wide.shift;
      res.result.status = 'applied';
      res.result.model = 'single';
      res.result.correction = wide.shift;
      res.issues = [];
    }
    results.set(camId, res.result);
    for (const p of placementsOf(camId)) delete corrections[p.clipId];
    if (enabled) Object.assign(corrections, res.corrections);
    if (wide) {
      issues.push(issue({
        severity: 'warning',
        cameraId: camId,
        title: `«${nameOf(camId)}» найдена по звуку на ${formatDurationHuman(Math.abs(wide.shift))} ${wide.shift > 0 ? 'позже' : 'раньше'}, чем показывают её часы`,
        details: `Часы этой камеры были сбиты${Math.abs(Math.abs(wide.shift) / 3600 - Math.round(Math.abs(wide.shift) / 3600)) < 0.25 && Math.abs(wide.shift) > 1800 ? ' — похоже, на ней другой часовой пояс' : ''}. Программа нашла общий звук ${wide.probes > 1 ? `в ${wide.probes} клипах` : 'в одном клипе'} и сдвинула всю камеру. Проверьте стыковку по картинке; отключить поправку можно в карточке камеры.`,
        actions: [{ kind: 'show-clip', clipId: placementsOf(camId)[0].clipId }],
      }));
    }
    issues.push(...res.issues.map((i) => issue({ ...i, title: i.title.replace('{cam}', nameOf(camId)) })));
    fixed.push(camId);
  }

  // Камера, у которой звук пустой: говорим прямо, почему по звуку её не сверить.
  let silentIssues = issues;
  for (const cam of withAudio) {
    if (!isSilent(cam.id)) continue;
    const prev = results.get(cam.id);
    results.set(cam.id, { cameraId: cam.id, status: 'silent', model: null, correction: null, steps: [], anchors: prev?.anchors ?? [], wideShift: null });
    for (const p of placementsOf(cam.id)) delete corrections[p.clipId];
    silentIssues = silentIssues.filter((i) => i.cameraId !== cam.id || i.severity === 'error');
    silentIssues.push(issue({
      severity: 'warning',
      cameraId: cam.id,
      title: `«${nameOf(cam.id)}»: в звуке тишина — сверить по звуку нельзя`,
      details: 'Звуковая дорожка есть, но в ней ничего не записано: встроенный микрофон был выключен или уровень записи стоял на нуле. Камера осталась по тайм-коду и часам. На следующих съёмках включите запись звука на каждой камере.',
      actions: [{ kind: 'open-faq', anchor: 'audio' }],
    }));
  }

  return { cameras: cameras.map((c) => results.get(c.id)!), corrections, issues: silentIssues };
}

interface Combined {
  result: AudioCameraResult;
  corrections: Record<string, number>;
  issues: Omit<Issue, 'id'>[];
}

// Сводим точки камеры в поправку — по ходу съёмки, от точки к точке:
// первая точка задаёт поправку для своего клипа и всех следующих; следующая точка сверяет кадр
// и, если расходится, меняет поправку со своего клипа и дальше. Предыдущие клипы не трогаются.
export function combine(camId: string, anchors: AudioAnchor[], source: TimeSource, placements: Placement[], enabled: boolean, tzMin: number): Combined {
  for (const a of anchors) a.role = 'weak';
  const ok = anchors.filter((a) => a.accepted).sort((a, b) => a.at - b.at);
  const out: Combined = {
    result: { cameraId: camId, status: enabled ? 'no-match' : 'disabled', model: null, correction: null, steps: [], anchors },
    corrections: {},
    issues: [],
  };
  if (ok.length === 0) {
    if (enabled) {
      out.issues.push({
        severity: 'warning',
        cameraId: camId,
        title: '«{cam}»: по звуку совпадения не нашлось',
        details: 'Общий звук с другими камерами есть, но уверенно сопоставить его не получилось — тихо, шумно или микрофон выключен. Камера осталась по тайм-коду и часам. Проверьте по хлопку.',
        actions: [{ kind: 'open-faq', anchor: 'manual-sync' }],
      });
    }
    return out;
  }

  const sortedPlacements = [...placements].sort((a, b) => a.start - b.start);
  const clipStart = new Map(sortedPlacements.map((p) => [p.clipId, p.start]));
  const strong = (a: AudioAnchor) => a.score >= STRONG_SCORE && a.ratio >= STRONG_RATIO;
  const close = (x: number, y: number) => Math.abs(x - y) <= CONSISTENT;

  if (source === 'clock') {
    // Без тайм-кода у каждого клипа своя ошибка часов: клип с точкой получает свою поправку,
    // клипы без точки — поправку ближайшей точки перед ними.
    const m = median(ok.map((a) => a.correction));
    const own = new Map<string, number>();
    for (const a of ok) {
      if (Math.abs(a.correction - m) <= 2) {
        a.role = 'confirm';
        own.set(a.clipId, a.correction);
      } else {
        a.role = 'ignored';
      }
    }
    let current = ok.find((a) => a.role === 'confirm')?.correction ?? m;
    out.result.correction = current;
    for (const p of sortedPlacements) {
      if (own.has(p.clipId)) current = own.get(p.clipId)!;
      out.corrections[p.clipId] = current;
    }
    out.result.model = 'per-clip';
  } else {
    let current: number | null = null;
    for (let i = 0; i < ok.length; i++) {
      const a = ok[i];
      const next = ok[i + 1];
      if (current === null) {
        // Первая точка не должна быть случайным совпадением: две следующие согласны между собой, но не с ней — отбрасываем.
        const after = ok[i + 2];
        if (next && after && !strong(a) && !close(next.correction, a.correction) && close(after.correction, next.correction)) {
          a.role = 'ignored';
          continue;
        }
        current = a.correction;
        a.role = 'start';
        out.result.steps.push({ from: sortedPlacements[0]?.start ?? a.at, correction: current });
        continue;
      }
      if (close(a.correction, current)) {
        a.role = 'confirm';
        continue;
      }
      // Точка просит другую поправку. Верим, если её подтверждает следующая точка или совпадение очень уверенное.
      const confirmed = next ? close(next.correction, a.correction) || (!close(next.correction, current) && strong(a)) : strong(a);
      if (confirmed) {
        a.role = 'shift';
        current = a.correction;
        out.result.steps.push({ from: clipStart.get(a.clipId) ?? a.at, correction: current });
      } else {
        a.role = 'ignored';
      }
    }
    // Поправка отрезка — среднее всех точек, которые с ней согласились: точнее, чем по одной точке.
    let stepIdx = -1;
    const members: number[][] = out.result.steps.map(() => []);
    for (const a of ok) {
      if (a.role === 'start' || a.role === 'shift') stepIdx++;
      if ((a.role === 'start' || a.role === 'shift' || a.role === 'confirm') && stepIdx >= 0) members[stepIdx].push(a.correction);
    }
    out.result.steps.forEach((s, i) => {
      if (members[i].length) s.correction = median(members[i]);
    });
    out.result.correction = out.result.steps[0]?.correction ?? null;
    for (const p of sortedPlacements) {
      let c = out.result.steps[0]?.correction ?? 0;
      for (const s of out.result.steps) if (s.from <= p.start + 1e-6) c = s.correction;
      out.corrections[p.clipId] = c;
    }
    out.result.model = out.result.steps.length > 1 ? 'per-anchor' : 'single';
    if (out.result.steps.length > 1) {
      const list = out.result.steps.slice(1).map((s) => `с ${formatClockTime(s.from, tzMin)} — ${formatSigned(s.correction)}`).join(', ');
      out.issues.push({
        severity: 'info',
        cameraId: camId,
        title: `«{cam}»: по звуку поправка менялась ${out.result.steps.length - 1} раз`,
        details: `В начале ${formatSigned(out.result.steps[0].correction)}, дальше ${list}. Похоже, часы камеры уплывают или тайм-код сбивался. Клипы до каждой такой точки не менялись.`,
        actions: [],
      });
    }
  }

  const ignored = anchors.filter((a) => a.role === 'ignored').length;
  if (ignored > 0) {
    out.issues.push({
      severity: 'info',
      cameraId: camId,
      title: `«{cam}»: ${ignored} из ${ok.length} точек сверки по звуку отброшены`,
      details: 'Они противоречили соседним точкам — скорее всего, звук в этих местах был похож на другой фрагмент.',
      actions: [],
    });
  }

  if (!enabled) {
    out.corrections = {};
    return out;
  }
  const maxAbs = Math.max(0, ...Object.values(out.corrections).map(Math.abs));
  out.result.status = maxAbs < 0.02 ? 'confirmed' : 'applied';
  return out;
}

// Камеры, которые звук подтвердил или поправил.
export function heardCameras(result: AudioSyncResult | null): Set<string> {
  return new Set((result?.cameras ?? []).filter((c) => c.status === 'applied' || c.status === 'confirmed').map((c) => c.cameraId));
}

export function formatSigned(sec: number): string {
  const sign = sec < 0 ? '−' : '+';
  const s = Math.abs(sec);
  return s < 60 ? `${sign}${s.toFixed(2).replace('.', ',')} с` : `${sign}${formatDurationHuman(s)}`;
}
