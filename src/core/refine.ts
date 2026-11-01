// Уточнение каждого клипа по звуку — после сборки по кускам.
//
// Сборка ставит записи целиком: внутри куска клипы стоят по тайм-коду или встык и двигаются только вместе.
// Это надёжно, но не точно: тайм-код через паузу бывает сбит на доли секунды (камеру выключали — при включении
// она пересчитывает его по часам с точностью до секунды), BWF-время рекордеров записано целыми секундами,
// «встык» по часам, точным до секунды, бывает ошибочным, а часы звуковых устройств идут со своей скоростью.
// По часам такие сбои не увидеть — часы сами точны лишь до секунды. Их видно только по звуку.
//
// Поэтому каждый клип сверяется по звуку со всеми, кто звучит одновременно с ним, и места всех клипов
// решаются вместе — взвешенным методом наименьших квадратов:
//   • неизвестные — начало каждого клипа и скорость часов каждого звукового устройства (видео — шкала времени);
//   • измерения — сдвиги в окнах звука между парами клипов: сначала по отпечатку (±3 с, потом ±0,25 с,
//     с долями кадра), затем точно по волне на 48 кГц;
//   • связи внутри устройства — с той погрешностью, какой они заслуживают: файлы одной непрерывной записи —
//     жёстко, тайм-код через паузу — ±0,4 с, BWF-время — ±0,6 с, «встык» по часам — ±1 с;
//   • выбросы — ложные совпадения в повторяющейся музыке — гасятся итерациями с весами Хьюбера.
// Ход часов решается здесь же: без выравнивания запись ставится по середине, с выравниванием копия звука
// растягивается на найденный коэффициент.
//
// Модель: момент u внутри клипа (секунды файла) звучит на таймлинии в момент S + u·(1 + p·10⁻⁶), где S — начало
// клипа, p — ход часов его устройства в миллионных. Окно, где момент uc клипа c совпал с моментом ud клипа d, —
// уравнение Sd − Sc + pd·ud·10⁻⁶ − pc·uc·10⁻⁶ = uc − ud, линейное по неизвестным.
import type { Camera, ClipMeta, Issue, SyncResult } from './types.ts';
import { FEAT_RATE, FINE_SR, gccPhat, hasAttacks, poolFeatures, sliceFeatures } from './audioFeatures.ts';
import type { Features } from './audioFeatures.ts';
import { SILENCE_DB } from './audioSync.ts';
import type { AudioFetch, AudioPiece, DriftEstimate } from './audioSync.ts';
import { formatDurationHuman, pluralRu } from './format.ts';

const PASSES = [
  // Первый проход ловит большие сбои (скачок тайм-кода — до секунды, ложное «встык» — до 2,5 с), второй — точнее.
  { pool: 4, search: 3, win: 30, maxWindows: 6, sigma: 0.02, consistency: 0.12 },
  { pool: 1, search: 0.25, win: 20, maxWindows: 10, sigma: 0.006, consistency: 0.03 },
];
const STEP = 30; // секунд между окнами сверки
const MIN_OVERLAP = 12; // секунд общего звука, меньше — пару не сравниваем
const CLEAR_SCORE = 0.1;
const CLEAR_RATIO = 1.35;
const NEIGHBOUR = 0.15; // пик в пределах 150 мс от лучшего не считается соперником
const FINE_LEN = 8; // секунд волны в точной сверке: в гулком зале нужно больше звука
const FINE_RANGE = 0.02; // точная сверка уточняет грубую в пределах ±20 мс: шире — может перескочить на соседнее эхо зала
const FINE_CONFIDENCE = 6; // пик GCC-PHAT во столько раз выше фона; согласие точек проверяет общий расчёт
const FINE_PER_CLIP = 3; // точек точной сверки на клип — в начале, середине и конце: по ним виден и ход часов
const FINE_TOTAL = 900; // и не больше 900 на всю съёмку — каждая точка читает звук с диска
const SIGMA_FINE = 0.001;
// Эхо: второй пик в 20–120 мс от лучшего почти той же высоты — неясно, где прямой звук. Точка по отпечатку
// с таким эхо весит вчетверо меньше, точка по волне не берётся: она могла встать на отражение.
const ECHO_SPAN = 0.12;
const ECHO_COARSE = 0.85;
const ECHO_FINE = 0.7;
const FRAME_LIMIT = 0.035; // хуже — уже заметно глазу: точность камеры хуже кадра — предупреждаем
const HUBER = 2.5;
const OUTLIER = 6; // измерение дальше шести своих погрешностей от общего решения — ложное
// Слабая привязка клипа к месту после сборки: держит клипы без общего звука, а общий сдвиг всей съёмки
// ложится на менее надёжные часы — тайм-код по часам точнее видео без него, видео — звука с дат файлов.
const PRIOR_START = { exact: 0.2, video: 1, audio: 5 };
const PRIOR_PPM = 300; // ход часов звуковых устройств — обычно десятки миллионных, редко сотни
const MAX_PPM = 600;
// Погрешность связи соседних клипов одного устройства — насколько их взаимному месту можно верить без звука.
const LINK = { rigid: 0.0005, tc: 0.4, bwf: 0.6, chain: 1, clock: 2 } as const;
// Связь держится жёстко, пока звук не покажет явный сбой: отклонение больше 60 мс и больше четырёх погрешностей.
// Меньшее — скорее неточность измерения в гулком зале, чем настоящий сбой: тайм-код после выключения камеры
// сбивается на доли секунды, ложное «встык» — на секунды, а запись не должна рваться от шума измерений.
const HOLD = LINK.rigid;
const BREAK = 0.06;
const DRIFT_EFFECT = 0.015; // ход часов, сдвигающий края записи больше чем на 15 мс, стоит выравнивать
const SPLIT_SIZES = [2 ** 31, 2 ** 32]; // рекордеры режут длинную запись на файлы по 2 и 4 ГБ

type LinkKind = keyof typeof LINK;
type Log = (line: string) => void;

interface Item {
  id: string;
  clip: ClipMeta;
  device: string;
  start0: number; // начало клипа после сборки
  length: number;
  free: boolean;
  follower: boolean;
  feat: Features | null;
  coarse: Features | null;
  channel: number;
  segment: number | undefined;
  lane: number;
}

interface Row {
  terms: { key: string; c: number }[];
  rhs: number;
  sigma: number;
  kind: 'meas' | 'fine' | 'link' | 'prior';
  pair?: [Item, Item];
  at?: [number, number]; // моменты внутри клипов пары, где звук совпал
  score?: number;
  link?: { kind: LinkKind; a: Item; b: Item };
  out?: boolean;
}

export interface RefineInput {
  cameras: Camera[];
  coarse: SyncResult;
  corrections: Record<string, number>;
  feats: Map<string, AudioPiece | null>;
  samples: AudioFetch['samples'];
  isEnabled: (cameraId: string) => boolean;
  followers: Set<string>;
  fixedClips: Set<string>; // клипы с жёсткой опорой: контрольный кадр, тайм-код, отмеченный точным, общий тайм-код
  exactClips: Set<string>; // клипы с тайм-кодом по часам устройства — время суток по ним точнее
  log: Log;
  tick?: () => void;
}

export interface RefineResult {
  corrections: Record<string, number>;
  drift: DriftEstimate[];
  issues: Issue[];
  measured: Set<string>; // клипы, место которых подтвердил звук
  accuracy: Record<string, number>; // погрешность места клипа, секунды (без расстояния до сцены)
  deviceAccuracy: Map<string, number>; // типичная погрешность клипов устройства
}

let issueSeq = 0;
function issue(partial: Omit<Issue, 'id'>): Issue {
  issueSeq += 1;
  return { id: `r${issueSeq}`, ...partial };
}

const hasAudio = (c: ClipMeta) => c.audioChannels > 0 && c.captureFps === null;
const yKey = (it: Item) => `y:${it.id}`;
const pKey = (device: string) => `p:${device}`;

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function pool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

// Сравнение отпечатков в узком диапазоне сдвигов: t[i] при нулевом сдвиге соответствует r[i + off].
// Балл — как у широкого поиска (косинус между отпечатками на общей части), сдвиг — с долями кадра.
// echo — высота самого сильного отдельного пика в 20–120 мс от лучшего относительно лучшего: так выглядит эхо зала.
export function narrowCorr(t: Features, r: Features, off: number, maxLag: number, rate: number): { lag: number; score: number; ratio: number; echo: number } | null {
  const n = t.frames;
  const B = t.bands;
  const et = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let b = 0; b < B; b++) s += t.data[i * B + b] ** 2;
    et[i + 1] = et[i] + s;
  }
  const er = new Float64Array(r.frames + 1);
  for (let j = 0; j < r.frames; j++) {
    let s = 0;
    for (let b = 0; b < B; b++) s += r.data[j * B + b] ** 2;
    er[j + 1] = er[j] + s;
  }
  const scores = new Float64Array(2 * maxLag + 1).fill(-1);
  for (let k = -maxLag; k <= maxLag; k++) {
    const j0 = off + k;
    const i0 = Math.max(0, -j0);
    const i1 = Math.min(n, r.frames - j0);
    if (i1 - i0 < n * 0.6) continue;
    let dot = 0;
    for (let i = i0; i < i1; i++) {
      const ti = i * B;
      const rj = (i + j0) * B;
      for (let b = 0; b < B; b++) dot += t.data[ti + b] * r.data[rj + b];
    }
    const st = et[i1] - et[i0];
    const sr = er[i1 + j0] - er[i0 + j0];
    if (st > 0 && sr > 0) scores[k + maxLag] = dot / Math.sqrt(st * sr);
  }
  let bi = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bi]) bi = i;
  const best = scores[bi];
  if (best <= 0) return null;
  const guard = Math.max(1, Math.round(NEIGHBOUR * rate));
  let rival = 1e-6;
  for (let i = 0; i < scores.length; i++) if (Math.abs(i - bi) > guard && scores[i] > rival) rival = scores[i];
  let frac = 0;
  if (bi > 0 && bi < scores.length - 1 && scores[bi - 1] > -1 && scores[bi + 1] > -1) {
    const d = scores[bi - 1] - 2 * best + scores[bi + 1];
    if (d < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (scores[bi - 1] - scores[bi + 1])) / d));
  }
  const near = Math.max(2, Math.round(0.02 * rate));
  const far = Math.round(ECHO_SPAN * rate);
  let echo = 0;
  for (let i = Math.max(1, bi - far); i <= Math.min(scores.length - 2, bi + far); i++) {
    if (Math.abs(i - bi) < near) continue;
    if (scores[i] > echo && scores[i] >= scores[i - 1] && scores[i] >= scores[i + 1]) echo = scores[i];
  }
  return { lag: bi - maxLag + frac, score: best, ratio: best / rival, echo: echo / best };
}

// Разложение Холецкого симметричной положительно определённой матрицы (на месте, нижний треугольник).
function cholesky(A: Float64Array, n: number): boolean {
  for (let j = 0; j < n; j++) {
    let d = A[j * n + j];
    for (let k = 0; k < j; k++) d -= A[j * n + k] ** 2;
    if (!(d > 0)) return false;
    d = Math.sqrt(d);
    A[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= A[i * n + k] * A[j * n + k];
      A[i * n + j] = s / d;
    }
  }
  return true;
}

function cholSolve(L: Float64Array, n: number, b: Float64Array): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

// Взвешенный МНК по строкам с итерациями Хьюбера. Неизвестные — free, остальные ключи известны (val).
// Возвращает решение и дисперсию линейной комбинации неизвестных (из обратной матрицы): у разности двух клипов
// она мала, даже когда вся съёмка как целое привязана к месту лишь слабо.
type Variance = (terms: { key: string; c: number }[]) => number;
function solve(free: Set<string>, rows: Row[], val: Map<string, number>): { x: Map<string, number>; variance: Variance } {
  const keys = [...free];
  const idx = new Map(keys.map((k, i) => [k, i]));
  const n = keys.length;
  const x = new Map<string, number>(keys.map((k) => [k, val.get(k) ?? 0]));
  const active = rows.filter((r) => r.terms.some((t) => idx.has(t.key)));
  const rhsOf = (r: Row) => r.rhs - r.terms.reduce((s, t) => s + (idx.has(t.key) ? 0 : t.c * (val.get(t.key) ?? 0)), 0);
  const residual = (r: Row) => r.terms.reduce((s, t) => s + (idx.has(t.key) ? t.c * x.get(t.key)! : 0), 0) - rhsOf(r);
  let L = new Float64Array(0);
  const run = (robustPass: boolean) => {
    for (let it = 0; it < 8; it++) {
      const A = new Float64Array(n * n);
      const b = new Float64Array(n);
      for (const r of active) {
        if (r.out) continue;
        let w = 1 / (r.sigma * r.sigma);
        if ((it > 0 || robustPass) && (r.kind === 'meas' || r.kind === 'fine')) {
          const z = Math.abs(residual(r)) / r.sigma;
          if (z > HUBER) w *= HUBER / z;
        }
        const rhs = rhsOf(r);
        for (const ti of r.terms) {
          const i = idx.get(ti.key);
          if (i === undefined) continue;
          b[i] += w * ti.c * rhs;
          for (const tj of r.terms) {
            const j = idx.get(tj.key);
            if (j !== undefined) A[i * n + j] += w * ti.c * tj.c;
          }
        }
      }
      if (!cholesky(A, n)) break;
      L = A;
      const sol = cholSolve(A, n, b);
      let moved = 0;
      keys.forEach((k, i) => {
        moved = Math.max(moved, Math.abs(sol[i] - x.get(k)!));
        x.set(k, sol[i]);
      });
      if (moved < 1e-7) break;
    }
  };
  if (n === 0) return { x, variance: () => 0 };
  run(false);
  // Явные выбросы — совсем мимо общего решения — убираем и решаем ещё раз.
  let dropped = 0;
  for (const r of active) {
    if (r.out || (r.kind !== 'meas' && r.kind !== 'fine')) continue;
    if (Math.abs(residual(r)) / r.sigma > OUTLIER) {
      r.out = true;
      dropped++;
    }
  }
  if (dropped) run(true);
  return {
    x,
    variance: (terms) => {
      if (L.length !== n * n) return 0;
      const v = new Float64Array(n);
      for (const tm of terms) {
        const i = idx.get(tm.key);
        if (i !== undefined) v[i] += tm.c;
      }
      const z = cholSolve(L, n, v);
      return v.reduce((s, vi, i) => s + vi * z[i], 0);
    },
  };
}

export async function refineClips(input: RefineInput): Promise<RefineResult> {
  const { cameras, coarse, corrections, log } = input;
  const clipById = new Map<string, ClipMeta>();
  for (const cam of cameras) for (const c of cam.clips) clipById.set(c.id, c);

  // Клипы с их местами после сборки.
  const items: Item[] = [];
  for (const p of coarse.placements) {
    const clip = clipById.get(p.clipId);
    if (!clip) continue;
    const device = p.timeCameraId ?? p.cameraId;
    const a = input.feats.get(clip.id);
    const feat = a && a.peakDb >= SILENCE_DB && hasAudio(clip) ? a.feat : null;
    items.push({
      id: clip.id,
      clip,
      device,
      start0: p.start + (corrections[clip.id] ?? 0),
      length: clip.durationSec,
      free: input.isEnabled(device) && !input.fixedClips.has(clip.id),
      follower: input.followers.has(device),
      feat,
      coarse: feat ? poolFeatures(feat, PASSES[0].pool) : null,
      channel: a?.channel ?? 0,
      segment: p.segment,
      lane: p.lane,
    });
  }
  const devices = new Map<string, Item[]>();
  for (const it of items) devices.set(it.device, [...(devices.get(it.device) ?? []), it]);
  const nameOf = (id: string) => cameras.find((c) => c.id === id)?.name ?? id;

  // Ход часов — неизвестное у звуковых устройств. Шкала времени — видео; если видео нет, — самое длинное звуковое.
  const rated = new Set<string>();
  for (const [id, list] of devices) {
    if (list.every((it) => !it.clip.hasVideo) && list.some((it) => it.feat && it.free)) rated.add(id);
  }
  const timebase = [...devices.entries()].filter(([id, list]) => !rated.has(id) && list.some((it) => it.feat));
  if (!timebase.length && rated.size) {
    const longest = [...rated].sort((a, b) => devices.get(b)!.reduce((s, it) => s + it.length, 0) - devices.get(a)!.reduce((s, it) => s + it.length, 0))[0];
    rated.delete(longest);
  }
  const followerItems = new Set(items.filter((it) => it.follower).map((it) => it.id));
  const followerKey = (key: string) => (key.startsWith('p:') ? input.followers : followerItems).has(key.slice(2));

  // Связи соседних клипов одного устройства.
  const splitFile = (a: Item, gap: number) => !a.clip.hasVideo && Math.abs(gap) <= 1.5 && SPLIT_SIZES.some((s) => a.clip.sizeBytes <= s && a.clip.sizeBytes >= s * 0.995);
  const links: Row[] = [];
  for (const [device, list] of devices) {
    const groups = new Map<string, Item[]>();
    for (const it of list) {
      const k = it.segment !== undefined ? `s${it.segment}` : `l${it.lane}`;
      groups.set(k, [...(groups.get(k) ?? []), it]);
    }
    for (const g of groups.values()) {
      g.sort((x, y) => x.start0 - y.start0);
      for (let i = 1; i < g.length; i++) {
        const a = g[i - 1];
        const b = g[i];
        const gap = b.start0 - (a.start0 + a.length);
        if (gap < -0.5) continue; // накладываются — разные записи на одной дорожке
        let kind: LinkKind;
        if (a.segment !== undefined && a.segment === b.segment) {
          kind = Math.abs(gap) <= 0.05 || splitFile(a, gap) ? 'rigid' : a.clip.tc?.source === 'bwf' ? 'bwf' : 'tc';
        } else if (Math.abs(gap) <= 1.5) {
          kind = splitFile(a, gap) ? 'rigid' : 'chain';
        } else {
          // Даты файлов при копировании меняются — взаимному месту таких клипов без звука верить нельзя.
          if (a.clip.clock?.source === 'file' || b.clip.clock?.source === 'file') continue;
          kind = 'clock';
        }
        const d0 = b.start0 - a.start0;
        const terms = [{ key: yKey(b), c: 1 }, { key: yKey(a), c: -1 }];
        if (rated.has(device)) terms.push({ key: pKey(device), c: -d0 * 1e-6 });
        links.push({ terms, rhs: 0, sigma: LINK[kind], kind: 'link', link: { kind, a, b } });
      }
    }
  }
  const priors: Row[] = [
    ...items.filter((it) => it.free).map((it): Row => ({ terms: [{ key: yKey(it), c: 1 }], rhs: 0, sigma: PRIOR_START[input.exactClips.has(it.id) ? 'exact' : it.clip.hasVideo ? 'video' : 'audio'], kind: 'prior' })),
    ...[...rated].map((d): Row => ({ terms: [{ key: pKey(d), c: 1 }], rhs: 0, sigma: PRIOR_PPM, kind: 'prior' })),
  ];

  const val = new Map<string, number>();
  const startOf = (it: Item) => it.start0 + (val.get(yKey(it)) ?? 0);
  const rateOf = (it: Item) => 1 + (val.get(pKey(it.device)) ?? 0) * 1e-6;
  const freeKeys = (followers: boolean) => new Set([
    ...items.filter((it) => it.free && it.follower === followers).map(yKey),
    ...[...rated].filter((d) => input.followers.has(d) === followers).map(pKey),
  ]);
  let lastVariance: Variance[] = [];
  const varianceOf = (terms: { key: string; c: number }[]) => lastVariance.reduce((s, f) => s + f(terms), 0);
  const linkDev = (l: Row) => l.terms.reduce((s, t) => s + t.c * (val.get(t.key) ?? 0), 0);
  const holdable = (l: Row) => l.link!.kind === 'tc' || l.link!.kind === 'bwf' || l.link!.kind === 'chain';
  // Сначала ведущие, потом ведомые — по уже поставленным ведущим: ведомая камера не сдвигает остальных.
  const solveStages = (rows: Row[]) => {
    const all = [...rows, ...links, ...priors];
    const lead = solve(freeKeys(false), all.filter((r) => !r.terms.some((t) => followerKey(t.key))), val);
    for (const [k, v] of lead.x) val.set(k, v);
    const fol = solve(freeKeys(true), all.filter((r) => r.terms.some((t) => followerKey(t.key))), val);
    for (const [k, v] of fol.x) val.set(k, v);
    lastVariance = [lead.variance, fol.variance];
  };
  // Сначала связи свободны — видно, где клипы по звуку отходят от тайм-кода и «встык»; где отход мал, связь
  // становится жёсткой, и всё решается ещё раз.
  const solveAll = (rows: Row[]) => {
    for (const l of links) if (holdable(l)) l.sigma = LINK[l.link!.kind];
    solveStages(rows);
    let held = 0;
    for (const l of links) {
      if (!holdable(l)) continue;
      const sd = Math.sqrt(Math.max(0, varianceOf(l.terms)));
      if (Math.abs(linkDev(l)) < Math.max(BREAK, 4 * sd)) {
        l.sigma = HOLD;
        held++;
      }
    }
    if (held) solveStages(rows);
  };

  // Измерения: окна звука между парами клипов, звучащих одновременно.
  const measureRow = (c: Item, d: Item, uc: number, ud: number, sigma: number, kind: 'meas' | 'fine', score: number): Row => {
    const terms = [{ key: yKey(d), c: 1 }, { key: yKey(c), c: -1 }];
    if (rated.has(d.device)) terms.push({ key: pKey(d.device), c: ud * 1e-6 });
    if (rated.has(c.device)) terms.push({ key: pKey(c.device), c: -uc * 1e-6 });
    return { terms, rhs: uc - ud - (d.start0 - c.start0), sigma, kind, pair: [c, d], at: [uc, ud], score };
  };
  const pairs: [Item, Item][] = [];
  const audible = items.filter((it) => it.feat);
  for (let i = 0; i < audible.length; i++) {
    for (let j = i + 1; j < audible.length; j++) {
      const c = audible[i];
      const d = audible[j];
      if (c.device === d.device || (!c.free && !d.free) || (c.follower && d.follower)) continue;
      pairs.push([c, d]);
    }
  }
  const measure = (pass: (typeof PASSES)[number]): Row[] => {
    const out: Row[] = [];
    const R = FEAT_RATE / pass.pool;
    const M = Math.round(pass.search * R);
    let tried = 0;
    for (const [c, d] of pairs) {
      const sc = startOf(c);
      const sd = startOf(d);
      const rc = rateOf(c);
      const rd = rateOf(d);
      const t0 = Math.max(sc, sd);
      const t1 = Math.min(sc + c.length * rc, sd + d.length * rd);
      if (t1 - t0 < MIN_OVERLAP) continue;
      tried++;
      const W = Math.min(pass.win, t1 - t0);
      const n = Math.max(1, Math.min(pass.maxWindows, Math.floor((t1 - t0 - W) / STEP) + 1));
      const step = n > 1 ? (t1 - t0 - W) / (n - 1) : 0;
      const fc = pass.pool > 1 ? c.coarse! : c.feat!;
      const fd = pass.pool > 1 ? d.coarse! : d.feat!;
      const got: { row: Row; T: number; dev: number }[] = [];
      for (let k = 0; k < n; k++) {
        const T = t0 + k * step;
        const i0 = Math.round(((T - sc) / rc) * R);
        const q = ((sc + (i0 / R) * rc - sd) / rd) * R; // где в d при нынешних местах звучит кадр i0 клипа c
        const j0 = Math.round(q) - M;
        const target = sliceFeatures(fc, i0, Math.round(W * R));
        const ref = sliceFeatures(fd, j0, Math.round(W * R) + 2 * M);
        if (!hasAttacks(target) || !hasAttacks(ref)) continue;
        const m = narrowCorr(target, ref, M, M, R);
        if (!m || m.score < CLEAR_SCORE || m.ratio < CLEAR_RATIO) continue;
        const ud = (j0 + M + m.lag) / R;
        got.push({ row: measureRow(c, d, i0 / R, ud, m.echo >= ECHO_COARSE ? 4 * pass.sigma : pass.sigma, 'meas', m.score), T, dev: ud - q / R });
      }
      if (!got.length) continue;
      // Согласие окон пары: ложный пик далёк от остальных. Ход часов даёт наклон — сравниваем с прямой.
      let line = (_T: number) => median(got.map((g) => g.dev));
      if (got.length >= 3) {
        const slopes: number[] = [];
        for (let a = 0; a < got.length; a++) for (let b = a + 1; b < got.length; b++) if (got[b].T - got[a].T > 1) slopes.push((got[b].dev - got[a].dev) / (got[b].T - got[a].T));
        const s = slopes.length ? Math.max(-MAX_PPM * 1e-6, Math.min(MAX_PPM * 1e-6, median(slopes))) : 0;
        const b0 = median(got.map((g) => g.dev - s * g.T));
        line = (T: number) => b0 + s * T;
      }
      const kept = got.filter((g) => Math.abs(g.dev - line(g.T)) <= pass.consistency);
      const short = n <= 2 && kept.length === n && kept.some((g) => g.row.score! >= 0.25);
      if (kept.length >= 2 || short) out.push(...kept.map((g) => g.row));
    }
    log(`уточнение, проход ±${pass.search} с: пар ${tried}, окон ${out.length}`);
    return out;
  };

  let rows: Row[] = [];
  for (const pass of PASSES) {
    rows = measure(pass);
    solveAll(rows);
  }

  // Точная сверка по волне: у каждого клипа — точки в начале, середине и конце.
  const jobs: { c: Item; d: Item; u: number; score: number }[] = [];
  for (const it of audible.filter((x) => x.free)) {
    const own = rows.filter((r) => !r.out && r.pair && (r.pair[0] === it || r.pair[1] === it)).map((r) => {
      const mine = r.pair![0] === it ? 0 : 1;
      return { d: r.pair![1 - mine], u: r.at![mine] + PASSES[1].win / 2, score: r.score! };
    });
    for (let s = 0; s < FINE_PER_CLIP; s++) {
      const lo = (s / FINE_PER_CLIP) * it.length;
      const hi = ((s + 1) / FINE_PER_CLIP) * it.length;
      const best = own.filter((o) => o.u >= lo && o.u < hi).sort((a, b) => b.score - a.score)[0];
      if (best) jobs.push({ c: it, ...best });
    }
  }
  jobs.sort((a, b) => b.score - a.score);
  const fine: Row[] = [];
  const echoOf = new Map<string, number[]>(); // точки по волне, отброшенные из-за эха: на сколько отстоит отражение
  const echoWith = new Map<string, Set<string>>(); // с какими устройствами у клипа было эхо
  const fineOk = new Map<string, number>();
  const off = Math.round(FINE_RANGE * FINE_SR);
  const echoOff = Math.round(ECHO_SPAN * FINE_SR);
  await pool(jobs.slice(0, FINE_TOTAL), 4, async ({ c, d, u }) => {
    const T = startOf(c) + u * rateOf(c);
    const ud = (T - startOf(d)) / rateOf(d);
    const from = u - FINE_LEN / 2;
    const dFrom = ud - FINE_LEN / 2 - ECHO_SPAN;
    if (from < 0 || dFrom < 0 || from + FINE_LEN > c.length || dFrom + FINE_LEN + 2 * ECHO_SPAN > d.length) return;
    const [x, y] = await Promise.all([
      input.samples(c.clip, from, FINE_LEN, c.channel),
      input.samples(d.clip, dFrom, FINE_LEN + 2 * ECHO_SPAN, d.channel),
    ]);
    if (!x || !y || x.length < FINE_SR * FINE_LEN * 0.9 || y.length < FINE_SR * FINE_LEN * 0.9) return;
    // Сдвиг ищется в ±20 мс от уточнённого места, соперник-отражение — в ±120 мс.
    const g = gccPhat(x, y, FINE_SR, echoOff, off, echoOff);
    // x[0] — момент from клипа c, совпадает с y[off + lag] — моментом dFrom + (off + lag)/sr клипа d.
    if (!g || g.confidence < FINE_CONFIDENCE || Math.abs(g.lag) >= off) return;
    if (g.rival >= ECHO_FINE) {
      for (const [it, other] of [[c, d], [d, c]]) {
        echoOf.set(it.id, [...(echoOf.get(it.id) ?? []), Math.abs(g.lag - g.rivalLag) / FINE_SR]);
        echoWith.set(it.id, new Set([...(echoWith.get(it.id) ?? []), other.device]));
      }
      return;
    }
    for (const it of [c, d]) fineOk.set(it.id, (fineOk.get(it.id) ?? 0) + 1);
    // x[0] — момент from клипа c, совпадает с y[echoOff + lag] — моментом dFrom + (echoOff + lag)/sr клипа d.
    fine.push(measureRow(c, d, from, dFrom + (echoOff + g.lag) / FINE_SR, SIGMA_FINE, 'fine', g.confidence));
  });
  audible.forEach(() => input.tick?.());
  log(`уточнение по волне: точек ${fine.length} из ${Math.min(jobs.length, FINE_TOTAL)}`);
  rows = [...rows, ...fine];
  solveAll(rows);

  // Ход часов. Двигать клипы может только надёжно измеренный: точек достаточно, они охватывают запись,
  // сходятся на одной прямой и погрешность на краях записи — в пределах 4 мс. Иначе шум измерений в гулком
  // зале выдал бы себя за ход часов и выстроил бы файлы по наклонной. Такие устройства решаются с ходом ноль.
  const driftStats = () => [...rated].map((device) => {
    const list = devices.get(device)!;
    const ppm = val.get(pKey(device)) ?? 0;
    const sigmaPpm = Math.sqrt(Math.max(0, varianceOf([{ key: pKey(device), c: 1 }])));
    const mine = rows.filter((r) => !r.out && r.pair!.some((it) => it.device === device));
    const longest = Math.max(...list.filter((it) => it.feat).map((it) => it.length));
    const span = Math.max(0, ...list.map((it) => {
      const us = mine.flatMap((r) => r.pair!.map((q, i) => (q === it ? r.at![i] : null))).filter((u): u is number => u !== null);
      return us.length ? Math.max(...us) - Math.min(...us) : 0;
    }));
    const res = mine.filter((r) => r.kind === 'fine').map((r) => r.terms.reduce((s, tm) => s + tm.c * (val.get(tm.key) ?? 0), 0) - r.rhs);
    const residualMs = res.length ? Math.sqrt(res.reduce((s, e) => s + e * e, 0) / res.length) * 1000 : Infinity;
    const edge = (Math.abs(ppm) * 1e-6 * longest) / 2;
    const reliable = mine.length >= 8 && span >= 0.4 * longest && residualMs <= 8 && (3 * sigmaPpm * 1e-6 * longest) / 2 <= Math.max(0.004, edge / 2);
    return { device, ppm, sigmaPpm, points: mine.length, longest, span, residualMs, edge, reliable };
  });
  const firstStats = driftStats();
  const shaky = firstStats.filter((d) => !d.reliable);
  for (const d of shaky) priors.push({ terms: [{ key: pKey(d.device), c: 1 }], rhs: 0, sigma: 0.01, kind: 'prior' });
  if (shaky.length) solveAll(rows);
  const finalStats = driftStats();

  // Итог по клипам.
  const used = rows.filter((r) => !r.out);
  const measuredCount = new Map<string, number>();
  for (const r of used) for (const it of r.pair!) measuredCount.set(it.id, (measuredCount.get(it.id) ?? 0) + 1);
  const measured = new Set([...measuredCount.keys()]);

  // Погрешность места каждого клипа — из трёх частей. Случайная — из общего решения, с поправкой на то, как
  // на деле разбросаны измерения (точки с эхом в нём уже весят меньше). Расхождение партнёров — если клип
  // по-разному встаёт относительно разных записей: эхо, разное расстояние микрофонов до сцены. Ход часов, если
  // звук не выравнивается, — расхождение к краям записи. Само расстояние до сцены по звуку не видно: звук идёт
  // около 3 мс на метр, и камера вдали встаёт по звуку раньше своей картинки — это сюда не входит.
  const residualOf = (r: Row) => r.terms.reduce((s, tm) => s + tm.c * (val.get(tm.key) ?? 0), 0) - r.rhs;
  const freeCount = items.filter((it) => it.free).length + rated.size;
  const chi = used.reduce((s, r) => s + (residualOf(r) / r.sigma) ** 2, 0);
  const scale = Math.sqrt(Math.max(1, chi / Math.max(1, used.length - freeCount)));
  const applied = new Set(firstStats.filter((d) => d.reliable && finalStats.find((f) => f.device === d.device)!.edge > DRIFT_EFFECT).map((d) => d.device));
  const accuracy: Record<string, number> = {};
  const VAR_LIMIT = 600; // точная дисперсия — решение системы на клип; на больших съёмках — для первых 600
  let counted = 0;
  for (const follower of [false, true]) {
    const group = items.filter((it) => it.free && it.follower === follower && measured.has(it.id));
    for (const it of items.filter((x) => x.free && x.follower === follower)) {
      let stat = NaN;
      if (counted++ < VAR_LIMIT) {
        const terms = [{ key: yKey(it), c: 1 }, ...group.filter((g) => g !== it).map((g) => ({ key: yKey(g), c: -1 / Math.max(1, group.length - 1) }))];
        stat = scale * Math.sqrt(Math.max(0, varianceOf(terms)));
      }
      // Куда клипу пришлось бы сдвинуться ради каждого партнёра-устройства.
      const byPartner = new Map<string, { s: number; n: number }>();
      for (const r of used) {
        if (!r.pair!.includes(it)) continue;
        const partner = r.pair![0] === it ? r.pair![1] : r.pair![0];
        const move = (r.pair![0] === it ? 1 : -1) * residualOf(r);
        const acc = byPartner.get(partner.device) ?? { s: 0, n: 0 };
        acc.s += move;
        acc.n += 1;
        byPartner.set(partner.device, acc);
      }
      let partner = 0;
      if (byPartner.size >= 2) {
        const means = [...byPartner.values()].map((a) => ({ m: a.s / a.n, n: a.n }));
        const total = means.reduce((s, x) => s + x.n, 0);
        const avg = means.reduce((s, x) => s + x.m * x.n, 0) / total;
        partner = Math.sqrt(means.reduce((s, x) => s + x.n * (x.m - avg) ** 2, 0) / total);
      }
      const edge = rated.has(it.device) && !applied.has(it.device) ? Math.abs(rateOf(it) - 1) * it.length / 2 : 0;
      // Эхо: если точка по волне чаще упиралась в отражение, чем находила прямой звук, место может стоять где угодно
      // между ними — погрешность в половину задержки отражения. По одной паре не скажешь, у кого из двух эхо:
      // виноват клип, у которого эхо с двумя и больше устройствами, или партнёр всего один, или чистых точек
      // по волне нет ни одной, а у партнёров они с другими записями есть.
      const echoes = echoOf.get(it.id) ?? [];
      const partners = [...(echoWith.get(it.id) ?? [])];
      const cleanElsewhere = partners.every((dev) => items.some((x) => x.device === dev && (fineOk.get(x.id) ?? 0) > 0));
      const blamed = partners.length >= 2 || byPartner.size <= 1 || ((fineOk.get(it.id) ?? 0) === 0 && cleanElsewhere);
      const echo = echoes.length > (fineOk.get(it.id) ?? 0) && blamed ? median(echoes) / 2 : 0;
      if (echo) log(`эхо ${nameOf(it.device)} / ${it.clip.name}: точек по волне с отражением ${echoes.length}, чистых ${fineOk.get(it.id) ?? 0}, отражение через ${(median(echoes) * 1000).toFixed(0)} мс`);
      accuracy[it.id] = Math.sqrt((Number.isFinite(stat) ? stat : 0) ** 2 + partner ** 2 + edge ** 2 + echo ** 2);
    }
  }
  const deviceAccuracy = new Map<string, number>();
  for (const [device, list] of devices) {
    const own = list.filter((it) => it.free && measured.has(it.id)).map((it) => accuracy[it.id]).filter(Number.isFinite);
    if (own.length) deviceAccuracy.set(device, median(own));
  }
  for (const [device, acc] of deviceAccuracy) log(`точность ${nameOf(device)}: ±${(acc * 1000).toFixed(1)} мс`);
  const out: Record<string, number> = { ...corrections };
  let movedMax = 0;
  for (const it of items) {
    if (!it.free) continue;
    // Без растяжения клип ставится по середине: ход часов поровну уходит к началу и к концу.
    const y = val.get(yKey(it)) ?? 0;
    const shift = y + (rateOf(it) - 1) * it.length / 2;
    out[it.id] = (corrections[it.id] ?? 0) + shift;
    movedMax = Math.max(movedMax, Math.abs(shift));
    if (Math.abs(shift) > 0.02) log(`уточнено ${nameOf(it.device)} / ${it.clip.name}: ${(shift * 1000).toFixed(1)} мс${measured.has(it.id) ? '' : ' (без своего звука — по соседям)'}`);
  }
  const resid = used.filter((r) => r.kind === 'fine').map((r) => r.terms.reduce((s, t) => s + t.c * (val.get(t.key) ?? 0), 0) - r.rhs);
  log(`уточнение: наибольшая поправка ${(movedMax * 1000).toFixed(0)} мс, расхождение точек по волне — ${resid.length ? `${(Math.sqrt(resid.reduce((s, e) => s + e * e, 0) / resid.length) * 1000).toFixed(1)} мс` : 'нет точек'}`);

  const issues: Issue[] = [];
  // Сбои структуры, найденные по звуку: тайм-код через паузу, секунды BWF, ложное «встык».
  const nudges = new Map<string, { kind: LinkKind; a: Item; b: Item; dev: number }[]>();
  for (const r of links) {
    const { kind, a, b } = r.link!;
    if (!holdable(r) || r.sigma === HOLD || !measured.has(a.id) || !measured.has(b.id)) continue;
    const dev = linkDev(r);
    if (Math.abs(dev) <= BREAK) continue;
    const key = `${a.device}|${kind}`;
    nudges.set(key, [...(nudges.get(key) ?? []), { kind, a, b, dev }]);
  }
  for (const list of nudges.values()) {
    const { kind, a } = list[0];
    const most = Math.max(...list.map((x) => Math.abs(x.dev)));
    const where = list.slice(0, 5).map((x) => `${x.b.clip.name} — ${formatDurationHuman(Math.abs(x.dev))}`).join(', ') + (list.length > 5 ? '…' : '');
    const title = kind === 'tc'
      ? `«${nameOf(a.device)}»: тайм-код сбивался после пауз — до ${formatDurationHuman(most)} (${pluralRu(list.length, 'место', 'места', 'мест')})`
      : kind === 'bwf'
        ? `«${nameOf(a.device)}»: время в файлах рекордера записано целыми секундами`
        : list.length === 1
          ? `«${nameOf(a.device)}»: ${list[0].a.clip.name} и ${list[0].b.clip.name} — не одна запись`
          : `«${nameOf(a.device)}»: ${pluralRu(list.length, 'стык', 'стыка', 'стыков')} «встык» оказались паузами`;
    const why = kind === 'tc'
      ? 'Так бывает, когда камеру выключали: при включении она пересчитывает тайм-код по часам, а они точны лишь до секунды.'
      : kind === 'bwf'
        ? 'Рекордер пишет время начала по своим часам с точностью до секунды, поэтому по нему записи встают с ошибкой до секунды.'
        : 'По часам камеры, точным до секунды, клипы выглядели одной записью, разрезанной на файлы, но между ними была пауза.';
    issues.push(issue({
      severity: 'info',
      cameraId: a.device,
      clipId: list[0].b.id,
      title,
      details: `${where}. ${why} Клипы поставлены по звуку — он совпал с другими записями.`,
      actions: [{ kind: 'show-clip', clipId: list[0].b.id }],
    }));
  }

  // Клипы без общего звука в устройстве, остальные клипы которого сверены.
  for (const [device, list] of devices) {
    if (!list.some((it) => it.free && measured.has(it.id))) continue;
    const lone = list.filter((it) => it.free && it.feat && !measured.has(it.id));
    if (!lone.length) continue;
    const names = lone.slice(0, 5).map((it) => it.clip.name).join(', ') + (lone.length > 5 ? '…' : '');
    issues.push(issue({
      severity: 'info',
      cameraId: device,
      clipId: lone[0].id,
      title: `«${nameOf(device)}»: ${lone.length === 1 ? 'у клипа нет' : `у ${pluralRu(lone.length, 'клипа', 'клипов', 'клипов')} нет`} общего звука с другими записями`,
      details: `${names}. ${lone.length === 1 ? 'Он стоит' : 'Они стоят'} по тайм-коду и часам соседних клипов этого устройства. Если между ними камеру выключали, место может быть неточным — проверьте по хлопку.`,
      actions: [{ kind: 'show-clip', clipId: lone[0].id }, { kind: 'open-faq', anchor: 'manual-sync' }],
    }));
  }

  // Камеры и рекордеры, чья точность по звуку хуже кадра.
  for (const [device, acc] of deviceAccuracy) {
    if (acc <= FRAME_LIMIT) continue;
    issues.push(issue({
      severity: 'warning',
      cameraId: device,
      title: `«${nameOf(device)}»: точность по звуку ±${formatDurationHuman(acc)}`,
      details: 'Звук этой записи по-разному совпадает с разными записями или в нём сильное эхо — так бывает в гулком зале и у микрофонов далеко от сцены. Место найдено по лучшему совпадению, но проверьте стыковку по картинке.',
      actions: [{ kind: 'open-faq', anchor: 'manual-sync' }],
    }));
  }

  // Ход часов звуковых устройств.
  const drift: DriftEstimate[] = [];
  for (const first of firstStats) {
    const { device, points: count, longest, span, residualMs } = first;
    const fin = finalStats.find((d) => d.device === device)!;
    const { ppm, sigmaPpm, edge } = first.reliable ? fin : { ppm: 0, sigmaPpm: first.sigmaPpm, edge: 0 };
    const apply = first.reliable && edge > DRIFT_EFFECT;
    drift.push({ cameraId: device, ppm, sigmaPpm, points: count, longestSec: longest, edgeErrorSec: edge, apply });
    log(`ход часов ${nameOf(device)}: ${first.ppm.toFixed(1)} ± ${first.sigmaPpm.toFixed(1)} ppm, точек ${count}, охват ${span.toFixed(0)} с из ${longest.toFixed(0)}, расхождение по волне ${Number.isFinite(residualMs) ? residualMs.toFixed(1) + ' мс' : '—'}, к краям ±${(first.edge * 1000).toFixed(0)} мс — ${!first.reliable ? 'ненадёжно, решено с ходом ноль' : apply ? 'выравнивать' : 'в пределах кадра'}`);
    if (apply) {
      issues.push(issue({
        severity: 'info',
        cameraId: device,
        title: `«${nameOf(device)}»: часы ${ppm > 0 ? 'отстают' : 'спешат'} на ${Math.abs(ppm).toFixed(0)} ppm — звук будет выровнен`,
        details: `Ход часов измерен по звуку в ${pluralRu(count, 'точке', 'точках', 'точках')}, погрешность ±${Math.max(1, sigmaPpm).toFixed(0)} ppm. За ${formatDurationHuman(longest)} записи это ${formatDurationHuman(2 * edge)}. При экспорте программа создаст выровненную копию звука — оригинал не меняется. Без неё запись стоит по середине: к краям расхождение до ±${formatDurationHuman(edge)}.`,
        actions: [],
      }));
    } else if (!first.reliable && first.edge > DRIFT_EFFECT) {
      issues.push(issue({
        severity: 'warning',
        cameraId: device,
        title: `«${nameOf(device)}»: ход часов не удалось измерить надёжно`,
        details: `По звуку похоже на расхождение до ±${formatDurationHuman(first.edge)} к краям записи, но точек сверки мало или они не сходятся на одной прямой — выравнивать звук по такой оценке нельзя. Записи стоят без поправки хода; проверьте начало и конец по хлопку.`,
        actions: [{ kind: 'open-faq', anchor: 'manual-sync' }],
      }));
    }
  }
  return { corrections: out, drift, issues, measured, accuracy, deviceAccuracy };
}
