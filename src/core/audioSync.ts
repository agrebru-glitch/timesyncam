// Сверка камер по звуку — вспомогательный шаг после раскладки по тайм-коду и часам.
// Два этапа: грубый — по многополосному отпечатку атак звука (хлопки, удары, начала слов),
// точный — по самой волне на 48 кГц (GCC-PHAT). Канал и полосы частот программа выбирает сама.
import type { Camera, ClipMeta, Issue, IssueAction, Placement, SyncResult, TimeSource } from './types.ts';
import { formatClockTime, formatDurationHuman } from './format.ts';
import { FEAT_RATE, FINE_SR, gccPhat, xcorrFeatures } from './audioFeatures.ts';
import type { Features } from './audioFeatures.ts';

export const ENV_RATE = FEAT_RATE; // кадров отпечатка в секунду: шаг 10 мс
export const AUDIO_SAMPLE_RATE = 8000; // для волны на таймлинии

const MIN_OVERLAP = 6; // секунд общего звука, меньше — не сравниваем
const MAX_WINDOW = 40; // секунд звука в одной точке
const PROBE_LEN = 12; // секунд звука в одной пробе широкого поиска: общий звук бывает совсем коротким
const ACCEPT_SCORE = 0.45;
const ACCEPT_RATIO = 1.5;
const STRONG_SCORE = 0.6; // настолько уверенное совпадение может сменить поправку без подтверждения
const STRONG_RATIO = 2;
const CLEAR_RATIO = 2; // такой отрыв от ложных пиков у случайного совпадения почти не бывает
const VERY_CLEAR_RATIO = 3;

// Совпадение настоящее, когда оно заметно выше всех остальных сдвигов. Высокий балл без отрыва
// бывает и случайно — у коротких клипов с несколькими хлопками.
const isAccepted = (m: { score: number; ratio: number }) => m.ratio >= CLEAR_RATIO || (m.score >= ACCEPT_SCORE && m.ratio >= ACCEPT_RATIO);
const isStrong = (m: { score: number; ratio: number }) => m.ratio >= VERY_CLEAR_RATIO || (m.score >= STRONG_SCORE && m.ratio >= STRONG_RATIO);
const CONSISTENT = 0.12; // ±3 кадра при 25 к/с: точка согласна с текущей поправкой
const NEIGHBOUR = 0.15; // пик в пределах 150 мс от лучшего не считается конкурентом
const FINE_LEN = 4; // секунд волны для точной сверки
const FINE_RANGE = 0.03; // точная сверка ищет в пределах ±30 мс от грубой
const FINE_CONFIDENCE = 10; // пик GCC-PHAT во столько раз выше фона — доверяем
// Рекордер пишет длинные записи на своём кварце, и его часы расходятся с часами камер: за час — на десятые
// доли секунды. Это штатно, поэтому точки с записью рекордера сравниваются с допуском, который растёт
// с расстоянием между точками: рядом — те же ±3 кадра, через час — ещё около 0,2 с.
const DRIFT_PER_SEC = 60e-6;
const RECORDER_STEP = 600; // в длинной записи рекордера — одна точка сверки примерно на 10 минут
const RECORDER_CHECKS = 4; // и не больше четырёх точек на запись
const RECORDER_TRIES = 3; // место не сопоставилось — пробуем следующее, до трёх мест на отрезок
const RECORDER_STRIDE = 90; // шаг между местами сверки внутри одного длинного общего куска
const DRIFT_NOTE = 0.08; // расхождение внутри записи больше двух кадров — сообщаем, что поставили по середине

export interface Match {
  lag: number; // в кадрах отпечатка, с долями
  score: number; // нормированная корреляция в лучшей точке
  ratio: number; // во сколько раз лучший пик выше ближайшего соперника
}

function bestOf(table: { lo: number; scores: Float64Array }, from: number, to: number): Match | null {
  let best = -Infinity;
  let bestK = 0;
  for (let k = Math.max(from, table.lo); k <= Math.min(to, table.lo + table.scores.length - 1); k++) {
    const s = table.scores[k - table.lo];
    if (s > best) {
      best = s;
      bestK = k;
    }
  }
  if (best <= 0) return null;
  const guard = Math.round(NEIGHBOUR * ENV_RATE);
  let rival = 1e-6;
  for (let k = Math.max(from, table.lo); k <= Math.min(to, table.lo + table.scores.length - 1); k++) {
    if (Math.abs(k - bestK) > guard && table.scores[k - table.lo] > rival) rival = table.scores[k - table.lo];
  }
  let frac = 0;
  const i = bestK - table.lo;
  if (i > 0 && i < table.scores.length - 1) {
    const y0 = table.scores[i - 1];
    const y1 = table.scores[i];
    const y2 = table.scores[i + 1];
    const d = y0 - 2 * y1 + y2;
    if (d < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d));
  }
  return { lag: bestK + frac, score: best, ratio: best / rival };
}

// target[i] при нулевом сдвиге соответствует ref[i + refOffset]. Ищем сдвиг в пределах ±maxLag.
export function correlate(target: Features, ref: Features, refOffset: number, maxLag: number): Match | null {
  const table = xcorrFeatures(target, ref, Math.ceil(target.frames * 0.6));
  if (!table) return null;
  const m = bestOf(table, refOffset - maxLag, refOffset + maxLag);
  return m ? { ...m, lag: m.lag - refOffset } : null;
}

// Поиск куска target во всей записи ref: target[0] совпадает с ref[offset]. Для случая, когда часы камеры
// сбиты на минуты или часы и рядом по времени общего звука нет.
export function findInside(target: Features, ref: Features): (Match & { offset: number }) | null {
  if (target.frames < MIN_OVERLAP * ENV_RATE || ref.frames < MIN_OVERLAP * ENV_RATE) return null;
  const minOverlap = Math.max(MIN_OVERLAP * ENV_RATE, Math.ceil(Math.min(target.frames, ref.frames) * 0.6));
  const table = xcorrFeatures(target, ref, minOverlap);
  if (!table) return null;
  const m = bestOf(table, -Infinity, Infinity);
  return m ? { ...m, offset: m.lag } : null;
}

export interface AudioPiece {
  feat: Features;
  peakDb: number; // пик в dBFS: по нему видно, что микрофон был выключен
  channel: number; // канал, где звук чётче — его берёт и точная сверка
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

export interface AudioFetch {
  features: (clip: ClipMeta, startSec: number, durSec: number) => Promise<AudioPiece | null>;
  samples: (clip: ClipMeta, startSec: number, durSec: number, channel: number) => Promise<Float32Array | null>; // 48 кГц
}

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
  fine: boolean; // уточнена по волне до долей миллисекунды
  fineConfidence: number;
  drift?: boolean; // в точке участвует запись рекордера (только звук): допуск растёт с расстоянием
}

// Насколько камеры с точным тайм-кодом могут расходиться по звуку без замечания:
// 60 мс, а если сверялись по записи рекордера — ещё на штатный ход его часов между точками.
export function checkLimit(anchors: AudioAnchor[]): number {
  const ok = anchors.filter((a) => a.accepted);
  if (!ok.some((a) => a.drift)) return 0.06;
  return 0.06 + DRIFT_PER_SEC * (Math.max(...ok.map((a) => a.at)) - Math.min(...ok.map((a) => a.at)));
}

// Согласна ли точка с поправкой, заданной в момент at.
function agrees(a: AudioAnchor, correction: number, at: number): boolean {
  return Math.abs(a.correction - correction) <= CONSISTENT + (a.drift ? DRIFT_PER_SEC * Math.abs(a.at - at) : 0);
}

// Начало самого насыщенного атаками куска длиной lenSec — на нём точная сверка надёжнее всего.
function busiestStart(f: Features, lenSec: number): number {
  const len = Math.min(f.frames, Math.round(lenSec * ENV_RATE));
  const act = new Float64Array(f.frames + 1);
  for (let t = 0; t < f.frames; t++) {
    let s = 0;
    for (let b = 0; b < f.bands; b++) s += Math.max(0, f.data[t * f.bands + b]);
    act[t + 1] = act[t] + s;
  }
  let best = 0;
  let bestT = 0;
  for (let t = 0; t + len <= f.frames; t++) {
    const s = act[t + len] - act[t];
    if (s > best) {
      best = s;
      bestT = t;
    }
  }
  return bestT;
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
  pre?: Record<string, number>; // поправки по контрольным кадрам
  fixed?: Set<string>; // камеры с контрольным кадром — опорные
  controlClips?: Set<string>; // клипы, в которых снят экран синхронизации
  followers?: Set<string>; // ведомые камеры: сверяются по остальным, но опорой ни для кого не служат
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

// Места сверки для записи рекордера: запись делится на отрезки примерно по 10 минут (не больше четырёх),
// в каждом — места, где рекордер пишет вместе с другими камерами, по порядку. Сверка в отрезке идёт
// от места к месту, пока звук не сопоставится; не сопоставился нигде — отрезок пропускается.
function recorderSegments(t: Placement, refs: Placement[], startOf: (p: Placement) => number): Pair[][] {
  const ts = startOf(t);
  const dur = t.end - t.start;
  const spots: Pair[] = [];
  for (const r of refs) {
    const rs = startOf(r);
    const os = Math.max(ts, rs);
    const oe = Math.min(ts + dur, rs + (r.end - r.start));
    if (oe - os < MIN_OVERLAP) continue;
    if (oe - os <= MAX_WINDOW) {
      spots.push({ target: t, ref: r, ws: os, we: oe });
      continue;
    }
    for (let ws = os; ws + MAX_WINDOW <= oe; ws += RECORDER_STRIDE) spots.push({ target: t, ref: r, ws, we: ws + MAX_WINDOW });
  }
  spots.sort((a, b) => a.ws - b.ws);
  const n = Math.min(RECORDER_CHECKS, Math.max(1, Math.ceil(dur / RECORDER_STEP)));
  const segments: Pair[][] = Array.from({ length: n }, () => []);
  for (const s of spots) segments[Math.min(n - 1, Math.floor(((s.ws - ts) / dur) * n))].push(s);
  // Места для проб берём по всему отрезку, а не только из его начала.
  return segments.filter((s) => s.length).map((s) => (s.length <= RECORDER_TRIES ? s : Array.from({ length: RECORDER_TRIES }, (_, i) => s[Math.round((i * (s.length - 1)) / (RECORDER_TRIES - 1))])));
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const anchorWeight = (a: AudioAnchor) => (a.fine ? 10 + a.fineConfidence : a.ratio);

function weightedMedian(list: AudioAnchor[]): number {
  const s = [...list].sort((a, b) => a.correction - b.correction);
  const total = s.reduce((n, a) => n + anchorWeight(a), 0);
  let acc = 0;
  for (let i = 0; i < s.length; i++) {
    acc += anchorWeight(s[i]);
    // Ровно половина веса — середина между двумя точками, как у обычной медианы.
    if (Math.abs(acc - total / 2) < 1e-9 && i + 1 < s.length) return (s[i].correction + s[i + 1].correction) / 2;
    if (acc > total / 2) return s[i].correction;
  }
  return s[s.length - 1].correction;
}

// Часы записи рекордера уходят равномерно, поэтому её точки ложатся на прямую. Поправка записи — значение
// прямой в середине записи: тогда к началу и к концу расхождение одинаковое. Наклон — не больше штатного хода
// часов; если точки слишком близко друг к другу, наклону не верим и берём их взвешенную середину.
function centeredCorrection(group: AudioAnchor[], mid: number): { correction: number; slope: number } {
  const span = Math.max(...group.map((a) => a.at)) - Math.min(...group.map((a) => a.at));
  if (group.length < 2 || span < RECORDER_STEP / 2) return { correction: weightedMedian(group), slope: 0 };
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (const a of group) {
    const w = anchorWeight(a);
    sw += w;
    sx += w * a.at;
    sy += w * a.correction;
  }
  const mx = sx / sw;
  const my = sy / sw;
  let sxx = 0;
  let sxy = 0;
  for (const a of group) {
    const w = anchorWeight(a);
    sxx += w * (a.at - mx) ** 2;
    sxy += w * (a.at - mx) * (a.correction - my);
  }
  const limit = DRIFT_PER_SEC * 1.5;
  const slope = Math.max(-limit, Math.min(limit, sxx > 0 ? sxy / sxx : 0));
  return { correction: my + slope * (mid - mx), slope };
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

export async function refineByAudio(cameras: Camera[], coarse: SyncResult, audio: AudioFetch, opts: AudioOptions): Promise<AudioSyncResult> {
  const clipById = new Map<string, ClipMeta>();
  for (const cam of cameras) for (const c of cam.clips) clipById.set(c.id, c);
  const sourceOf = new Map<string, TimeSource | null>(coarse.cameras.map((c) => [c.cameraId, c.timeSource]));
  const placementsOf = (camId: string) => coarse.placements.filter((p) => p.cameraId === camId && hasAudio(clipById.get(p.clipId)!));
  // Все клипы камеры, в том числе без звука: поправка камеры с тайм-кодом действует и на них.
  const allOf = (camId: string) => coarse.placements.filter((p) => p.cameraId === camId);
  // Поправки по контрольным кадрам применяются до сверки по звуку: такие камеры уже стоят точно.
  const pre = opts.pre ?? {};
  const corrections: Record<string, number> = { ...pre };
  const restorePre = (camId: string) => {
    for (const p of coarse.placements) if (p.cameraId === camId && pre[p.clipId] !== undefined && corrections[p.clipId] === undefined) corrections[p.clipId] = pre[p.clipId];
  };
  const startOf = (p: Placement) => p.start + (corrections[p.clipId] ?? 0);
  // Клипы камер без тайм-кода, которые не подтвердил ни звук, ни экран: их место — догадка,
  // поэтому другие камеры по ним не равняются.
  const untrusted = new Set<string>();
  // Ведомые камеры ни для кого не служат образцом: их звук не сдвигает другие камеры.
  const isFollower = (id: string) => !!opts.followers?.has(id);
  const refsOf = (ids: string[]) => ids.filter((id) => !isFollower(id)).flatMap((id) => placementsOf(id)).filter((p) => !untrusted.has(p.clipId));
  const markUntrusted = (camId: string, anchors: AudioAnchor[], applied: boolean) => {
    if (sourceOf.get(camId) !== 'clock') return;
    for (const p of allOf(camId)) {
      const own = applied && anchors.some((a) => a.clipId === p.clipId && (a.role === 'start' || a.role === 'confirm' || a.role === 'shift'));
      if (!own && !opts.controlClips?.has(p.clipId)) untrusted.add(p.clipId);
    }
  };
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
    for (const p of placementsOf(a)) for (const id of set) for (const q of placementsOf(id).filter((x) => !untrusted.has(x.clipId))) {
      const ps = startOf(p);
      const qs = startOf(q);
      total += Math.max(0, Math.min(ps + p.end - p.start, qs + q.end - q.start) - Math.max(ps, qs));
    }
    return total;
  };

  // Опора: камеры с контрольным кадром; если их нет — камеры с точным тайм-кодом;
  // иначе — камера с видео, у которой больше всего общего звука с остальными: длинная запись рекордера
  // опорой сама не становится, чтобы ход её часов не уводил всю таймлинию. Ведомые камеры опорой не бывают.
  const leaders = withAudio.map((c) => c.id).filter((id) => !isFollower(id));
  const candidates = leaders.length ? leaders : withAudio.map((c) => c.id);
  const fromControl = opts.fixed ? candidates.filter((id) => opts.fixed!.has(id)) : [];
  const absolute = fromControl.length ? [] : candidates.filter((id) => sourceOf.get(id) === 'timecode');
  const withVideo = candidates.filter((id) => !allOf(id).every((p) => !clipById.get(p.clipId)!.hasVideo));
  const pool0 = withVideo.length ? withVideo : candidates;
  const all = withAudio.map((x) => x.id);
  const fixed: string[] = fromControl.length ? [...fromControl] : absolute.length ? [...absolute] : [
    [...pool0].sort((a, b) => overlapWith(b, all.filter((x) => x !== b)) - overlapWith(a, all.filter((x) => x !== a)))[0],
  ];
  const queue = withAudio.map((c) => c.id).filter((id) => !fixed.includes(id));

  // Камеры с точным тайм-кодом тоже сверяем между собой — только чтобы сообщить о расхождении.
  const plans: { camId: string; pairs: Pair[]; segments: Pair[][]; checkOnly: boolean }[] = [];
  const planFor = (camId: string, refs: string[], checkOnly: boolean) => {
    const targets = placementsOf(camId);
    const refList = refsOf(refs);
    // Записи рекордера (только звук) сверяются по отрезкам, клипы с видео — по одной точке.
    const recorder = checkOnly ? [] : targets.filter((p) => !clipById.get(p.clipId)!.hasVideo);
    let pairs = findPairs(targets.filter((p) => !recorder.includes(p)), refList, startOf);
    const perClip = sourceOf.get(camId) === 'clock' && !checkOnly;
    if (!perClip) pairs = spreadPick(pairs, opts.maxAnchors);
    const segments = recorder.flatMap((t) => recorderSegments(t, refList, startOf));
    return { camId, pairs, segments, checkOnly };
  };
  const isRecorder = (camId: string) => allOf(camId).every((p) => !clipById.get(p.clipId)!.hasVideo);
  // Сверка с записью рекордера даёт сбои — предлагаем сделать рекордер ведомым: он встанет по камерам
  // с допуском и перестанет их тревожить. Это и для замечаний самого рекордера, и для камер, сверенных по нему.
  const followerAction = (camId: string, anchors: AudioAnchor[]): IssueAction[] => {
    if (isFollower(camId)) return [];
    if (isRecorder(camId)) return [{ kind: 'make-follower', cameraId: camId }];
    // Сверялась в основном по рекордеру — по удачным точкам, а если удачных нет — по всем попыткам.
    const ok = anchors.some((a) => a.accepted) ? anchors.filter((a) => a.accepted) : anchors;
    const byRecorder = ok.filter((a) => isRecorder(a.refCameraId) && !isFollower(a.refCameraId));
    return byRecorder.length && byRecorder.length * 2 >= ok.length ? [{ kind: 'make-follower', cameraId: byRecorder[0].refCameraId }] : [];
  };

  const totalEstimate = () => plans.reduce((n, p) => n + p.pairs.length + p.segments.length, 0);
  let done = 0;
  const searchFrames = Math.round(opts.searchSec * ENV_RATE);

  // Тишина в звуке камеры: считаем, сколько кусков пришли пустыми, а сколько со звуком.
  const heard = new Map<string, { silent: number; loud: number }>();
  const listen = (camId: string, piece: AudioPiece | null): Features | null => {
    if (!piece) return null;
    const h = heard.get(camId) ?? { silent: 0, loud: 0 };
    const silent = piece.peakDb < SILENCE_DB;
    if (silent) h.silent++;
    else h.loud++;
    heard.set(camId, h);
    return silent ? null : piece.feat;
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
      audio.features(tClip, pair.ws - tStart, pair.we - pair.ws),
      audio.features(rClip, rs0 - rStart, re0 - rs0),
    ]);
    const tFeat = listen(pair.target.cameraId, tPiece);
    const rFeat = listen(pair.ref.cameraId, rPiece);
    done++;
    opts.onProgress?.(done, Math.max(done, totalEstimate()));
    if (!tFeat || !rFeat || tFeat.frames < MIN_OVERLAP * ENV_RATE * 0.8) return null;
    const refOffset = Math.round((pair.ws - rs0) * ENV_RATE);
    const m = correlate(tFeat, rFeat, refOffset, searchFrames);
    if (!m) return null;
    // Поправка считается от исходной раскладки по тайм-коду, с учётом уже найденного сдвига камеры.
    const coarseInc = rs0 - pair.ws + (refOffset + m.lag) / ENV_RATE;
    let correction = (tStart - pair.target.start) + coarseInc;
    const accepted = isAccepted(m);

    // Точный этап: самый «звучный» кусок окна сравнивается по волне на 48 кГц.
    let fine = false;
    let fineConfidence = 0;
    if (accepted && tPiece && rPiece) {
      const segStart = pair.ws + busiestStart(tFeat, FINE_LEN) / ENV_RATE;
      const len = Math.min(FINE_LEN, pair.we - segStart);
      const tLocal = segStart - tStart;
      const rLocal = segStart + coarseInc - FINE_RANGE - rStart;
      if (len >= 1 && tLocal >= 0 && rLocal >= 0 && rLocal + len + 2 * FINE_RANGE <= pair.ref.end - pair.ref.start) {
        const [x, y] = await Promise.all([
          audio.samples(tClip, tLocal, len, tPiece.channel),
          audio.samples(rClip, rLocal, len + 2 * FINE_RANGE, rPiece.channel),
        ]);
        if (x && y && x.length > FINE_SR * 0.5) {
          const off = Math.round(FINE_RANGE * FINE_SR);
          const g = gccPhat(x, y, FINE_SR, off, off);
          if (g && g.confidence >= FINE_CONFIDENCE && Math.abs(g.lag) < off) {
            correction += g.lag / FINE_SR;
            fine = true;
            fineConfidence = g.confidence;
          }
        }
      }
    }
    return {
      cameraId: pair.target.cameraId,
      clipId: pair.target.clipId,
      refCameraId: pair.ref.cameraId,
      refClipId: pair.ref.clipId,
      at: (pair.ws + pair.we) / 2,
      correction,
      score: m.score,
      ratio: m.ratio,
      accepted,
      role: 'weak',
      fine,
      fineConfidence,
      drift: !tClip.hasVideo || !rClip.hasVideo || isFollower(pair.target.cameraId),
    };
  };

  const conc = opts.concurrency ?? 4;

  // Отдельные точки меряем сразу; в отрезке записи рекордера идём от места к месту:
  // звук не сопоставился — пробуем следующее место, сопоставился — точка уточнена по волне, отрезок готов.
  const measurePlan = async (plan: (typeof plans)[number]): Promise<AudioAnchor[]> => {
    const single = await pool(plan.pairs, conc, measure);
    const walked = await pool(plan.segments, conc, async (seg) => {
      const out: AudioAnchor[] = [];
      for (const pair of seg) {
        const a = await measure(pair);
        if (a) out.push(a);
        if (a?.accepted) break;
      }
      return out;
    });
    return [...single.filter((a): a is AudioAnchor => !!a), ...walked.flat()];
  };

  // Сначала проверяем опорные камеры между собой.
  if (absolute.length > 1) {
    for (const id of absolute.slice(1)) plans.push(planFor(id, [absolute[0]], true));
  }
  for (const p of plans) {
    const anchors = await measurePlan(p);
    const ok = anchors.filter((a) => a.accepted);
    for (const a of ok) a.role = 'confirm';
    const corr = ok.length ? median(ok.map((a) => a.correction)) : null;
    results.set(p.camId, { cameraId: p.camId, status: 'checked', model: null, correction: corr, steps: [], anchors });
    // С записью рекордера часы штатно расходятся — на это не жалуемся.
    if (corr !== null && Math.abs(corr) > checkLimit(anchors)) {
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
    const targets = [...placementsOf(camId)].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 4);
    const refs = refsOf(fixed);
    if (!targets.length || !refs.length) return null;
    // Сначала звук самой камеры: если он пустой, искать нечего. Короткие пробы в начале, середине и конце клипа:
    // общий звук с другой камерой может длиться всего десяток секунд.
    const probes: { t: Placement; start: number; env: Features }[] = [];
    for (const t of targets) {
      const dur = t.end - t.start;
      const probeLen = Math.min(PROBE_LEN, dur - 1);
      if (probeLen < MIN_OVERLAP * 1.5) continue;
      const starts = dur - probeLen < 4 ? [(dur - probeLen) / 2] : [0.5, (dur - probeLen) / 2, dur - probeLen - 0.5];
      for (const probeStart of starts) {
        const env = listen(camId, await audio.features(clipById.get(t.clipId)!, probeStart, probeLen));
        done++;
        opts.onProgress?.(done, Math.max(done, totalEstimate() + targets.length * 3));
        if (env) probes.push({ t, start: probeStart, env });
      }
    }
    if (!probes.length) return null;
    const refEnvs = await pool(refs, conc, async (r) => listen(r.cameraId, await audio.features(clipById.get(r.clipId)!, 0, r.end - r.start)));
    // Все уверенные совпадения пробы с клипами других камер. Если один и тот же сдвиг дают разные пробы
    // или разные камеры — это не случайность.
    const hits: { shift: number; score: number; ratio: number; key: string }[] = [];
    probes.forEach(({ t, start: probeStart, env: probe }, pi) => {
      refs.forEach((r, i) => {
        const env = refEnvs[i];
        const m = env ? findInside(probe, env) : null;
        if (m && isAccepted(m)) hits.push({ shift: startOf(r) + m.offset / ENV_RATE - (t.start + probeStart), score: m.score, ratio: m.ratio, key: `${pi}|${r.clipId}` });
      });
    });
    if (!hits.length) return null;
    let bestGroup: typeof hits = [];
    for (const h of hits) {
      const group = hits.filter((x) => Math.abs(x.shift - h.shift) <= 0.2);
      if (group.length > bestGroup.length || (group.length === bestGroup.length && group.reduce((s, x) => s + x.score, 0) > bestGroup.reduce((s, x) => s + x.score, 0))) bestGroup = group;
    }
    const others = hits.filter((x) => !bestGroup.includes(x));
    const competing = others.length > 0 && others.length >= bestGroup.length;
    const confident = !competing && (bestGroup.length >= 2 || isStrong(bestGroup[0]));
    return confident ? { shift: median(bestGroup.map((x) => x.shift)), probes: bestGroup.length } : null;
  };

  // Остальные камеры — по очереди, начиная с той, у которой больше общего звука с уже выровненными.
  // Камеры без тайм-кода — после камер с тайм-кодом: так каждому их клипу есть с чем сравниться.
  // Ведомые — в самом конце, когда все остальные камеры уже стоят.
  const rank = (id: string) => {
    const o = overlapWith(id, fixed);
    return (isFollower(id) ? 0 : 1e12) + (o > 0 ? (sourceOf.get(id) === 'clock' ? 1 : 2) : 0) * 1e9 + o;
  };
  while (queue.length) {
    queue.sort((a, b) => rank(b) - rank(a));
    const camId = queue.shift()!;
    // Ведомая с контрольным кадром стоит по экрану — он точнее звука; образцом для других она всё равно не служит.
    if (opts.fixed?.has(camId)) {
      results.set(camId, { cameraId: camId, status: 'disabled', model: null, correction: null, steps: [], anchors: [] });
      fixed.push(camId);
      continue;
    }
    const enabled = opts.isEnabled(camId);
    let plan = planFor(camId, fixed, false);
    plans.push(plan);
    let anchors = await measurePlan(plan);
    let wide: { shift: number; probes: number } | null = null;
    // Широкий поиск не нужен камере, которую уже поставил контрольный кадр.
    const hasControl = placementsOf(camId).some((p) => pre[p.clipId] !== undefined);
    if (enabled && !hasControl && !anchors.some((a) => a.accepted)) {
      wide = await wideSearch(camId);
      if (wide) {
        for (const p of allOf(camId)) corrections[p.clipId] = wide.shift;
        plan = planFor(camId, fixed, false);
        plans.push(plan);
        anchors = await measurePlan(plan);
      }
    }
    if (plan.pairs.length + plan.segments.length === 0 && !wide) {
      results.set(camId, { cameraId: camId, status: 'no-overlap', model: null, correction: null, steps: [], anchors: [], wideShift: null });
      issues.push(issue({
        severity: 'info',
        cameraId: camId,
        title: `«${nameOf(camId)}» не с чем сверить по звуку`,
        details: 'Рядом по времени клипы этой камеры не идут одновременно с другими камерами, а поиск по всей записи совпадения не нашёл. Камера осталась по тайм-коду и часам.',
        actions: [],
      }));
      markUntrusted(camId, [], false);
      fixed.push(camId);
      continue;
    }
    const res = combine(camId, anchors, sourceOf.get(camId) ?? 'clock', allOf(camId), enabled, coarse.displayTzOffsetMin, isRecorder(camId));
    res.result.wideShift = wide?.shift ?? null;
    if (wide && res.result.status === 'no-match') {
      // Точки рядом не подтвердили, но широкий поиск был уверенным — оставляем общий сдвиг камеры.
      for (const p of allOf(camId)) res.corrections[p.clipId] = wide.shift;
      res.result.status = 'applied';
      res.result.model = 'single';
      res.result.correction = wide.shift;
      res.issues = [];
    }
    results.set(camId, res.result);
    for (const p of allOf(camId)) delete corrections[p.clipId];
    if (enabled) Object.assign(corrections, res.corrections);
    restorePre(camId);
    const followerFix = followerAction(camId, anchors);
    if (wide) {
      issues.push(issue({
        severity: 'warning',
        cameraId: camId,
        title: `«${nameOf(camId)}» найдена по звуку на ${formatDurationHuman(Math.abs(wide.shift))} ${wide.shift > 0 ? 'позже' : 'раньше'}, чем показывают её часы`,
        details: `Часы этой камеры были сбиты${Math.abs(Math.abs(wide.shift) / 3600 - Math.round(Math.abs(wide.shift) / 3600)) < 0.25 && Math.abs(wide.shift) > 1800 ? ' — похоже, на ней другой часовой пояс' : ''}. Программа нашла общий звук ${wide.probes > 1 ? `в ${wide.probes} клипах` : 'в одном клипе'} и сдвинула всю камеру. Проверьте стыковку по картинке; отключить поправку можно в карточке камеры.`,
        actions: [{ kind: 'show-clip', clipId: placementsOf(camId)[0].clipId }, ...followerFix],
      }));
    }
    // Штатный ход часов рекордера — не сбой, к нему кнопку не добавляем.
    issues.push(...res.issues.map((i) => issue({
      ...i,
      title: i.title.replace('{cam}', nameOf(camId)),
      actions: /в пределах погрешности/.test(i.title) ? i.actions : [...i.actions, ...followerFix],
    })));
    markUntrusted(camId, anchors, enabled);
    fixed.push(camId);
  }

  // Камера, у которой звук пустой: говорим прямо, почему по звуку её не сверить.
  let silentIssues = issues;
  for (const cam of withAudio) {
    if (!isSilent(cam.id)) continue;
    const prev = results.get(cam.id);
    results.set(cam.id, { cameraId: cam.id, status: 'silent', model: null, correction: null, steps: [], anchors: prev?.anchors ?? [], wideShift: null });
    for (const p of allOf(cam.id)) delete corrections[p.clipId];
    restorePre(cam.id);
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
// Камеры без тайм-кода и рекордер (recorder) получают поправку по каждому клипу отдельно.
export function combine(camId: string, anchors: AudioAnchor[], source: TimeSource, placements: Placement[], enabled: boolean, tzMin: number, recorder = false): Combined {
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
  const strong = (a: AudioAnchor) => isStrong(a);
  const weightOf = (list: AudioAnchor[]) => list.reduce((n, a) => n + anchorWeight(a), 0);

  if (source === 'clock' || recorder) {
    // Без тайм-кода у каждого клипа своя ошибка часов, а у длинной записи рекордера — свой ход часов:
    // клип с точками получает свою поправку, клипы без точек — поправку ближайшего клипа перед ними.
    const m = median(ok.map((a) => a.correction));
    const own = new Map<string, number>();
    const byClip = new Map<string, AudioAnchor[]>();
    for (const a of ok) {
      if (Math.abs(a.correction - m) > 2) {
        a.role = 'ignored';
        continue;
      }
      byClip.set(a.clipId, [...(byClip.get(a.clipId) ?? []), a]);
    }
    let driftMax = 0;
    let driftClipSec = 0;
    for (const [clipId, list] of byClip) {
      // В клипе — самая большая группа согласных между собой точек (с допуском на ход часов рекордера);
      // поправка — их взвешенная середина, точки вне группы отброшены.
      let group: AudioAnchor[] = [];
      for (const seed of list) {
        const g = list.filter((a) => agrees(a, seed.correction, seed.at));
        if (g.length > group.length || (g.length === group.length && weightOf(g) > weightOf(group))) group = g;
      }
      for (const a of list) a.role = group.includes(a) ? 'confirm' : 'ignored';
      const p = sortedPlacements.find((x) => x.clipId === clipId);
      if (recorder && p) {
        // Длинная запись рекордера встаёт по своей середине; уход часов пересчитываем на всю её длину.
        const fit = centeredCorrection(group, (p.start + p.end) / 2);
        own.set(clipId, fit.correction);
        const drift = Math.abs(fit.slope) * (p.end - p.start);
        if (drift > driftMax) {
          driftMax = drift;
          driftClipSec = p.end - p.start;
        }
      } else {
        own.set(clipId, weightedMedian(group));
      }
    }
    const first = sortedPlacements.find((p) => own.has(p.clipId));
    let current = first ? own.get(first.clipId)! : m;
    out.result.correction = current;
    if (recorder && driftMax > DRIFT_NOTE) {
      out.issues.push({
        severity: 'info',
        cameraId: camId,
        title: `«{cam}»: за ${formatDurationHuman(driftClipSec)} записи часы рекордера ушли на ${Math.round(driftMax * 1000)} мс — это в пределах погрешности`,
        details: `Часы рекордера и камер идут чуть по-разному — для длинной записи это нормально. Запись поставлена по своей середине: к началу и к концу звук может отличаться от видео примерно на ±${Math.round(driftMax * 500)} мс. Если нужна точность до кадра по всей длине, подгоните отдельные места по хлопку в монтажке.`,
        actions: [],
      });
    }
    for (const p of sortedPlacements) {
      if (own.has(p.clipId)) current = own.get(p.clipId)!;
      out.corrections[p.clipId] = current;
    }
    out.result.model = 'per-clip';
  } else {
    // Поправка задаётся точкой в момент currentAt; точки, сверенные с рекордером, сравниваются с допуском на ход часов.
    let current: number | null = null;
    let currentAt = 0;
    for (let i = 0; i < ok.length; i++) {
      const a = ok[i];
      const next = ok[i + 1];
      if (current === null) {
        // Первая точка не должна быть случайным совпадением: две следующие согласны между собой, но не с ней — отбрасываем.
        const after = ok[i + 2];
        if (next && after && !strong(a) && !agrees(next, a.correction, a.at) && agrees(after, next.correction, next.at)) {
          a.role = 'ignored';
          continue;
        }
        current = a.correction;
        currentAt = a.at;
        a.role = 'start';
        out.result.steps.push({ from: sortedPlacements[0]?.start ?? a.at, correction: current });
        continue;
      }
      if (agrees(a, current, currentAt)) {
        a.role = 'confirm';
        continue;
      }
      // Точка просит другую поправку. Верим, если её подтверждает следующая точка или совпадение очень уверенное.
      const confirmed = next ? agrees(next, a.correction, a.at) || (!agrees(next, current, currentAt) && strong(a)) : strong(a);
      if (confirmed) {
        a.role = 'shift';
        current = a.correction;
        currentAt = a.at;
        out.result.steps.push({ from: clipStart.get(a.clipId) ?? a.at, correction: current });
      } else {
        a.role = 'ignored';
      }
    }
    // Поправка отрезка — взвешенная середина всех точек, которые с ней согласились. Точки, уточнённые
    // по волне, весят больше грубых: одна слабая точка не утянет поправку к себе.
    let stepIdx = -1;
    const members: AudioAnchor[][] = out.result.steps.map(() => []);
    for (const a of ok) {
      if (a.role === 'start' || a.role === 'shift') stepIdx++;
      if ((a.role === 'start' || a.role === 'shift' || a.role === 'confirm') && stepIdx >= 0) members[stepIdx].push(a);
    }
    out.result.steps.forEach((s, i) => {
      if (members[i].length) s.correction = weightedMedian(members[i]);
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
