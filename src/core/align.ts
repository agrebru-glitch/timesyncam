// Сверка по звуку: все дорожки со всеми.
//
// Единица сверки — «кусок»: клипы, которые стоят друг относительно друга точно и сдвигаются только вместе.
//   • отрезок непрерывного тайм-кода камеры (Free Run или точный тайм-код) — промежутки точны до кадра;
//   • запись, разбитая на файлы встык (петличка кусками по 30 минут, рекордер, главы GoPro);
//   • отдельный клип камеры без тайм-кода — у каждого такого клипа часы ошибаются по-своему.
//
// 1. Каждая пара кусков сравнивается по всей длине записи, без опоры на часы: часы могут врать на минуты
//    и годы. Берутся несколько лучших сдвигов-кандидатов.
// 2. Каждый кандидат проверяется по всей общей части — окна по 20 секунд. Настоящий сдвиг совпадает почти
//    во всех окнах; случайный (в музыке, которая повторяется) — только в части. Это главная защита.
// 3. Сдвиги всех пар сводятся вместе и должны сходиться по кругу: камера 1 → 2 → рекордер → 1.
//    Противоречия разрешаются в пользу более подтверждённых совпадений.
// 4. Где сборка стоит во времени, решают часы устройств, согласных о дате; контрольный кадр и точный
//    тайм-код держат своё место жёстко.
// 5. Сдвиг каждой пары уточняется по самой волне на 48 кГц — до долей миллисекунды.
import type { Camera, ClipMeta, Issue, IssueAction, Placement, SyncResult } from './types.ts';
import { FEAT_RATE, FINE_SR, gccPhat, xcorrFeatures } from './audioFeatures.ts';
import type { Features } from './audioFeatures.ts';
import { correlate, SILENCE_DB } from './audioSync.ts';
import type { AudioAnchor, AudioCameraResult, AudioFetch, AudioOptions, AudioPiece, AudioSyncResult } from './audioSync.ts';
import { formatDurationHuman } from './format.ts';

const RATE = FEAT_RATE; // кадров отпечатка в секунду
const POOL = 4; // грубый поиск — 25 кадров в секунду
const MIN_OVERLAP = 12; // секунд общего звука, меньше — пару не сравниваем
const CANDIDATES = 6; // сколько лучших сдвигов пары проверять
const PEAK_GUARD = 1.5; // кандидаты ближе 1,5 с друг к другу — один и тот же
const WIN = 20; // секунд звука в окне проверки
const STEP = 30; // шаг окон проверки
const MAX_WINDOWS = 40;
const SEARCH = 1; // окно проверки ищет совпадение в пределах ±1 с от кандидата
const AGREE = 0.25; // окно согласно с кандидатом, если нашло его в пределах ±0,25 с
const CLEAR_SCORE = 0.1;
const CLEAR_RATIO = 1.35;
const RIVAL = 0.6; // второй кандидат с поддержкой больше 60% от лучшего — неоднозначно
const TOLERANCE = 0.12; // сдвиги пар сходятся по кругу с точностью ±3 кадра
const DRIFT_PER_SEC = 60e-6; // штатный ход часов рекордера: до 0,2 с за час
const CHAIN_GAP = 1.5; // файлы одного устройства встык: промежуток по часам не больше 1,5 с
const FINE_LEN = 8; // секунд волны: в гулком зале точной сверке нужно больше звука
const FINE_RANGE = 0.03;
const FINE_CONFIDENCE = 10;
const FINE_WINDOWS = 5;

type Trust = 'anchor' | 'clock' | 'weak' | 'none';

// Подробный журнал сравнения пар — для разбора сложных съёмок (переменная окружения TSC_ALIGN_DEBUG=1).
const DEBUG = typeof process !== 'undefined' && !!process.env?.TSC_ALIGN_DEBUG;

interface Member {
  p: Placement;
  clip: ClipMeta;
  at: number; // начало клипа внутри куска, секунды
}

interface Piece {
  id: number;
  cameraId: string;
  members: Member[];
  prior: number; // начало куска по часам (после согласия дат)
  length: number;
  trust: Trust;
  clockOnly: boolean;
  recorder: boolean;
  follower: boolean;
  feat: Features | null;
  coarse: Features | null;
  channel: Map<string, number>; // канал каждого клипа для точной сверки
  peakDb: number;
}

interface Check {
  at: number; // начало окна внутри куска a
  local: number; // сдвиг, который нашло окно
  score: number;
  ratio: number;
  agree: boolean;
}

interface Edge {
  a: number;
  b: number;
  d: number; // начало b минус начало a, секунды
  weight: number;
  support: number;
  tested: number;
  checks: Check[];
  fine: boolean;
  fineConfidence: number;
  slope: number; // ход часов: на сколько секунд в секунду меняется сдвиг по ходу записи (у рекордера)
  mid: number; // момент куска a, к которому отнесён сдвиг d, — середина общей части
  span: number; // сколько секунд общей записи между крайними согласными окнами
  hard?: boolean; // связь по контрольным кадрам и точному тайм-коду, не по звуку
}

let issueSeq = 0;
function issue(partial: Omit<Issue, 'id'>): Issue {
  issueSeq += 1;
  return { id: `g${issueSeq}`, ...partial };
}

const hasAudio = (c: ClipMeta) => c.audioChannels > 0 && c.captureFps === null;

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

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function weightedMedian(items: { v: number; w: number }[]): number {
  const s = [...items].sort((a, b) => a.v - b.v);
  const total = s.reduce((n, x) => n + x.w, 0);
  let acc = 0;
  for (let i = 0; i < s.length; i++) {
    acc += s[i].w;
    if (Math.abs(acc - total / 2) < 1e-9 && i + 1 < s.length) return (s[i].v + s[i + 1].v) / 2;
    if (acc > total / 2) return s[i].v;
  }
  return s[s.length - 1].v;
}

// Кусок отпечатка с кадра from длиной len (за краями — тишина).
function slice(f: Features, from: number, len: number): Features {
  const out = new Float32Array(len * f.bands);
  const s = Math.max(0, from);
  const e = Math.min(f.frames, from + len);
  if (e > s) out.set(f.data.subarray(s * f.bands, e * f.bands), (s - from) * f.bands);
  return { frames: len, bands: f.bands, data: out };
}

// Есть ли в куске отпечатка атаки звука, а не только тишина и ровный шум.
function active(f: Features): boolean {
  let n = 0;
  for (let i = 0; i < f.data.length; i++) if (f.data[i] > 1) n++;
  return n >= f.frames * 0.01;
}

// Грубый отпечаток: максимум по POOL кадрам — атаки не теряются.
function pooled(f: Features): Features {
  const n = Math.ceil(f.frames / POOL);
  const out = new Float32Array(n * f.bands);
  for (let t = 0; t < n; t++) {
    for (let b = 0; b < f.bands; b++) {
      let m = -Infinity;
      for (let k = t * POOL; k < Math.min(f.frames, (t + 1) * POOL); k++) m = Math.max(m, f.data[k * f.bands + b]);
      out[t * f.bands + b] = m;
    }
  }
  return { frames: n, bands: f.bands, data: out };
}

// Лучшие сдвиги по таблице сравнения: локальные пики, не ближе guard друг к другу. На краю, где записи
// перекрываются на считанные секунды, случайная похожесть всегда высокая — поэтому похожесть взвешивается
// длиной общей части: полный вес — от двух минут общего звука (или всей длины короткой записи).
function peaks(table: { lo: number; scores: Float64Array }, n: number, m: number, k: number, guard: number): number[] {
  const full = Math.min(n, m, (120 * RATE) / POOL);
  const weighted = table.scores.map((s, i) => {
    const lag = i + table.lo;
    const overlap = Math.min(n, m - lag) - Math.max(0, -lag);
    return s * Math.min(1, overlap / full);
  });
  const order = Array.from(weighted.keys()).sort((x, y) => weighted[y] - weighted[x]);
  const out: number[] = [];
  for (const i of order) {
    if (weighted[i] <= 0.03 || out.length >= k) break;
    if (out.some((j) => Math.abs(j - i) < guard)) continue;
    out.push(i);
  }
  return out.map((i) => i + table.lo);
}

// Куски каждой камеры.
function buildPieces(cameras: Camera[], coarse: SyncResult, opts: AudioOptions): Piece[] {
  const clipById = new Map<string, ClipMeta>();
  for (const cam of cameras) for (const c of cam.clips) clipById.set(c.id, c);
  const sync = new Map(coarse.cameras.map((c) => [c.cameraId, c]));
  const pieces: Piece[] = [];
  for (const cam of cameras) {
    // Клип другой камеры на этой дорожке сверяется со своей камерой — время ему задаёт она.
    const pls = coarse.placements.filter((p) => (p.timeCameraId ?? p.cameraId) === cam.id).sort((a, b) => a.start - b.start);
    if (!pls.length) continue;
    const cs = sync.get(cam.id);
    const groups: Placement[][] = [];
    const bySegment = new Map<number, Placement[]>();
    let chain: Placement[] = [];
    for (const p of pls) {
      if (p.segment !== undefined && !p.timeCameraId) {
        const g = bySegment.get(p.segment) ?? [];
        if (!g.length) groups.push(g);
        g.push(p);
        bySegment.set(p.segment, g);
        continue;
      }
      // Без тайм-кода: файлы встык — одна запись, иначе каждый клип отдельно.
      const prev = chain[chain.length - 1];
      if (prev && Math.abs(p.start - (prev.start + clipById.get(prev.clipId)!.recordedSec)) <= CHAIN_GAP) {
        chain.push(p);
      } else {
        chain = [p];
        groups.push(chain);
      }
    }
    // Поправки по контрольным кадрам применяются до сверки по звуку: такие клипы уже стоят точно.
    const pre = (p: Placement) => p.start + (opts.pre?.[p.clipId] ?? 0);
    for (const g of groups) {
      const first = g[0];
      const isChain = first.segment === undefined || !!first.timeCameraId;
      const members: Member[] = [];
      let at = 0;
      for (const p of g) {
        const clip = clipById.get(p.clipId)!;
        // В записи встык клип начинается ровно там, где кончился предыдущий; по тайм-коду — где показывает тайм-код.
        members.push({ p, clip, at: isChain ? at : pre(p) - pre(first) });
        at += clip.recordedSec;
      }
      const length = Math.max(...members.map((m) => m.at + m.clip.durationSec));
      const fileOnly = members.every((m) => m.clip.clock?.source === 'file');
      // Жёстко стоят: камера с контрольным кадром (её тайм-код держит все клипы), клип с экраном у камеры
      // без тайм-кода и камера с точным тайм-кодом — если её дата согласна с остальными.
      const trust: Trust = opts.fixed?.has(cam.id) || members.some((m) => opts.controlClips?.has(m.clip.id))
        ? 'anchor'
        : cs?.dateOutlierSec !== null && cs?.dateOutlierSec !== undefined
          ? 'none'
          : cs?.timeSource === 'timecode'
            ? 'anchor'
            : fileOnly ? 'weak' : 'clock';
      pieces.push({
        id: pieces.length,
        cameraId: cam.id,
        members,
        prior: pre(first),
        length,
        trust,
        clockOnly: cs?.timeSource === 'clock',
        recorder: members.every((m) => !m.clip.hasVideo),
        follower: !!opts.followers?.has(cam.id),
        feat: null,
        coarse: null,
        channel: new Map(),
        peakDb: -200,
      });
    }
  }
  return pieces;
}

// Проверка сдвига d (начало b минус начало a) по всей общей части окнами.
function verify(a: Piece, b: Piece, d: number): Check[] {
  const fa = a.feat!;
  const fb = b.feat!;
  const from = Math.max(0, d);
  const to = Math.min(a.length, d + b.length);
  const span = to - from;
  if (span < MIN_OVERLAP) return [];
  const count = Math.max(1, Math.min(MAX_WINDOWS, Math.floor((span - WIN) / STEP) + 1));
  const step = count > 1 ? (span - Math.min(WIN, span)) / (count - 1) : 0;
  const win = Math.min(WIN, span);
  const checks: Check[] = [];
  for (let k = 0; k < count; k++) {
    const u = from + k * step;
    const t = slice(fa, Math.round(u * RATE), Math.round(win * RATE));
    const r = slice(fb, Math.round((u - d - SEARCH) * RATE), Math.round((win + 2 * SEARCH) * RATE));
    if (!active(t) || !active(r)) continue;
    const m = correlate(t, r, Math.round(SEARCH * RATE), Math.round(SEARCH * RATE));
    if (!m) {
      checks.push({ at: u, local: d, score: 0, ratio: 0, agree: false });
      continue;
    }
    // t[i] совпадает с r[i + SEARCH + lag]: момент u куска a — это момент u − d + lag куска b, то есть сдвиг d − lag.
    const local = d - m.lag / RATE;
    const clear = m.score >= CLEAR_SCORE && m.ratio >= CLEAR_RATIO;
    checks.push({ at: u, local, score: m.score, ratio: m.ratio, agree: clear && Math.abs(m.lag / RATE) <= AGREE });
  }
  return checks;
}

// Очная проверка двух сдвигов-кандидатов на одних и тех же местах записи. Когда музыка повторяется,
// окна совпадают при обоих сдвигах — отличают только неповторяющиеся звуки (кашель зала, другая часть пьесы).
// Короткие окна по всей части, где оба сдвига дают общий звук: в каждом сравнивается, при каком сдвиге
// звук совпадает лучше. Там, где музыка одинаковая, разница — просто шум, поэтому решает устойчивость
// перевеса по всем окнам (t-критерий парных разностей) и явные победы — с перевесом больше шума.
// winner: 1 — первый сдвиг лучше, 2 — второй, 0 — не различить.
function headToHead(a: Piece, b: Piece, d1: number, d2: number): { winner: 0 | 1 | 2; t: number; clear1: number; clear2: number } {
  const from = Math.max(0, d1, d2);
  const to = Math.min(a.length, d1 + b.length, d2 + b.length);
  const H = 5; // секунд: в коротком окне редкий неповторяющийся звук весит заметнее
  const diffs: number[] = [];
  for (let u = from; u + H <= to; u += H) {
    const t = slice(a.feat!, Math.round(u * RATE), H * RATE);
    if (!active(t)) continue;
    const at = (d: number) => {
      const r = slice(b.feat!, Math.round((u - d) * RATE) - 3, H * RATE + 6);
      return correlate(t, r, 3, 3)?.score ?? 0;
    };
    diffs.push(at(d1) - at(d2));
  }
  const n = diffs.length;
  const clear1 = diffs.filter((x) => x > 0.03).length;
  const clear2 = diffs.filter((x) => x < -0.03).length;
  if (n < 4) return { winner: 0, t: 0, clear1, clear2 };
  const mean = diffs.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(diffs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) || 1e-9;
  const tt = mean / (sd / Math.sqrt(n));
  const winner = tt >= 3 && clear1 >= 2 && clear2 * 3 <= clear1 ? 1 : tt <= -3 && clear2 >= 2 && clear1 * 3 <= clear2 ? 2 : 0;
  return { winner, t: tt, clear1, clear2 };
}

// Ход часов. У длинной записи рекордера сдвиг меняется по ходу записи: его кварц спешит или отстаёт
// на десятки миллионных. Прямая через согласные окна; сдвиг берётся в середине общей части —
// тогда к началу и к концу расхождение одинаковое и наименьшее. Наклон — не больше штатного хода часов.
function centered(a: Piece, b: Piece, checks: Check[], d: number): { d: number; slope: number; mid: number; span: number } {
  const from = Math.max(0, d);
  const to = Math.min(a.length, d + b.length);
  const mid = (from + to) / 2;
  const ok = checks.filter((c) => c.agree);
  const xs = ok.map((c) => c.at + WIN / 2);
  const span = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  if (!(a.recorder || b.recorder) || ok.length < 3 || span < 600) return { d, slope: 0, mid, span };
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const my = ok.reduce((s, c) => s + c.local, 0) / ok.length;
  let sxx = 0;
  let sxy = 0;
  ok.forEach((c, i) => {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (c.local - my);
  });
  const limit = DRIFT_PER_SEC * 1.5;
  const slope = Math.max(-limit, Math.min(limit, sxx > 0 ? sxy / sxx : 0));
  return { d: my + slope * (mid - mx), slope, mid, span };
}

// Сравнение пары кусков: лучший проверенный сдвиг или null.
function measurePair(a: Piece, b: Piece): { edge: Edge | null; ambiguous: boolean } {
  const table = xcorrFeatures(a.coarse!, b.coarse!, Math.round((MIN_OVERLAP * RATE) / POOL));
  if (!table) return { edge: null, ambiguous: false };
  // table: a[0] совпадает с b[k] — значит, начало b на k кадров раньше начала a.
  const cands = peaks(table, a.coarse!.frames, b.coarse!.frames, CANDIDATES, (PEAK_GUARD * RATE) / POOL).map((k) => (-k * POOL) / RATE);
  const tried = cands.map((d) => {
    const checks = verify(a, b, d);
    const ok = checks.filter((c) => c.agree);
    const refined = ok.length ? median(ok.map((c) => c.local)) : d;
    return { d: refined, checks, support: ok.length, tested: checks.length, score: ok.length ? ok.reduce((n, c) => n + c.score, 0) / ok.length : 0 };
  }).sort((x, y) => y.support - x.support || y.score - x.score);
  const best = tried[0];
  const second = tried.find((x) => x !== best && Math.abs(x.d - best.d) > PEAK_GUARD);
  if (DEBUG) {
    console.log(`пара ${a.cameraId}#${a.id} — ${b.cameraId}#${b.id}:`);
    for (const x of tried) console.log(`    сдвиг ${x.d.toFixed(2)} с: совпало ${x.support} из ${x.tested}, балл ${x.score.toFixed(2)}`);
  }
  if (!best || best.support === 0) return { edge: null, ambiguous: false };
  // Соперники — кандидаты, подтверждённые почти так же. Лучший должен выиграть у каждого очно: на тех же
  // местах записи совпасть лучше хотя бы в трёх окнах и не проиграть заметно. Иначе — неоднозначно, не угадываем.
  let winner = best;
  let undecided = false;
  for (const c of tried) {
    if (c === winner || Math.abs(c.d - winner.d) <= PEAK_GUARD || c.support < winner.support * RIVAL) continue;
    const h = headToHead(a, b, winner.d, c.d);
    if (DEBUG) console.log(`    очно ${winner.d.toFixed(2)} против ${c.d.toFixed(2)}: t=${h.t.toFixed(1)}, явных побед ${h.clear1} : ${h.clear2}`);
    if (h.winner === 1) continue;
    if (h.winner === 2) winner = c;
    else undecided = true;
  }
  if (undecided) return { edge: null, ambiguous: true };
  const share = winner.support / Math.max(1, winner.tested);
  // Уверенно: совпало хотя бы в трёх окнах и в большинстве проверенных. Короткая общая часть (одно-два
  // окна): все окна согласны и соперника нет.
  const strong = winner.support >= 3 && share >= 0.5;
  const short = winner.tested <= 2 && winner.support === winner.tested && (!second || second.support === 0 || winner !== best) && winner.score >= 0.25;
  if (!strong && !short) return { edge: null, ambiguous: false };
  const chosen = winner;
  // Проверочные окна заново — уже вокруг уточнённого сдвига, чтобы точки сверки стояли точно.
  const checks = verify(a, b, chosen.d);
  const c = centered(a, b, checks, chosen.d);
  return {
    edge: { a: a.id, b: b.id, d: c.d, weight: chosen.support * chosen.score * (strong ? 1 : 0.3), support: chosen.support, tested: chosen.tested, checks, fine: false, fineConfidence: 0, slope: c.slope, mid: c.mid, span: c.span },
    ambiguous: false,
  };
}

// Допуск сходимости по кругу: у записей рекордера часы штатно уходят — допуск растёт с длиной.
function tolerance(e: Edge, pieces: Piece[]): number {
  const pa = pieces[e.a];
  const pb = pieces[e.b];
  return TOLERANCE + (pa.recorder || pb.recorder ? DRIFT_PER_SEC * Math.max(pa.length, pb.length) : 0);
}

// Сводим сдвиги пар в положения кусков. Связи берутся от самых подтверждённых; связь, которая противоречит
// уже собранному, сравнивается со слабейшим звеном пути, с которым спорит, — проигравший отбрасывается.
function solve(nodes: number[], edges: Edge[], pieces: Piece[]): { pos: Map<number, number>; used: Edge[]; dropped: Edge[] } {
  const dropped = new Set<Edge>();
  let result = { pos: new Map<number, number>(), used: [] as Edge[] };
  for (let round = 0; round < 30; round++) {
    const parent = new Map<number, number>(nodes.map((n) => [n, n]));
    const offset = new Map<number, number>(nodes.map((n) => [n, 0])); // положение узла относительно его корня
    const find = (x: number): number => {
      let r = x;
      let off = 0;
      while (parent.get(r) !== r) {
        off += offset.get(r)!;
        r = parent.get(r)!;
      }
      // сжатие пути
      let y = x;
      let acc = off;
      while (parent.get(y) !== r) {
        const next = parent.get(y)!;
        const o = offset.get(y)!;
        parent.set(y, r);
        offset.set(y, acc);
        acc -= o;
        y = next;
      }
      return r;
    };
    const posInRoot = (x: number) => {
      find(x);
      return parent.get(x) === x ? 0 : offset.get(x)!;
    };
    const tree: Edge[] = [];
    const conflicts: Edge[] = [];
    const sorted = edges.filter((e) => !dropped.has(e)).sort((x, y) => (y.hard ? 1 : 0) - (x.hard ? 1 : 0) || y.weight - x.weight);
    const consistent: Edge[] = [];
    for (const e of sorted) {
      const ra = find(e.a);
      const rb = find(e.b);
      if (ra !== rb) {
        // b = a + d → корень rb кладём относительно ra
        const pa = posInRoot(e.a);
        const pb = posInRoot(e.b);
        parent.set(rb, ra);
        offset.set(rb, pa + e.d - pb);
        tree.push(e);
      } else if (Math.abs(posInRoot(e.b) - posInRoot(e.a) - e.d) <= tolerance(e, pieces)) {
        consistent.push(e);
      } else {
        conflicts.push(e);
      }
    }
    const pos = new Map<number, number>(nodes.map((n) => [n, posInRoot(n)]));
    result = { pos, used: [...tree, ...consistent] };
    if (!conflicts.length) break;
    // Самое сильное противоречие: со слабейшим звеном пути по дереву между его концами.
    const c = conflicts[0];
    const adj = new Map<number, Edge[]>();
    for (const e of tree) {
      adj.set(e.a, [...(adj.get(e.a) ?? []), e]);
      adj.set(e.b, [...(adj.get(e.b) ?? []), e]);
    }
    const prev = new Map<number, Edge>();
    const queue = [c.a];
    const seen = new Set([c.a]);
    while (queue.length) {
      const x = queue.shift()!;
      if (x === c.b) break;
      for (const e of adj.get(x) ?? []) {
        const y = e.a === x ? e.b : e.a;
        if (seen.has(y)) continue;
        seen.add(y);
        prev.set(y, e);
        queue.push(y);
      }
    }
    const path: Edge[] = [];
    for (let x = c.b; x !== c.a && prev.has(x);) {
      const e = prev.get(x)!;
      path.push(e);
      x = e.a === x ? e.b : e.a;
    }
    const weakest = path.filter((e) => !e.hard).sort((x, y) => x.weight - y.weight)[0];
    if (!c.hard && (!weakest || c.weight <= weakest.weight)) dropped.add(c);
    else dropped.add(weakest);
  }
  // Уточнение по всем согласным связям: каждое положение — средневзвешенное по соседям (жёсткие связи не двигаются).
  const used = result.used;
  const pos = result.pos;
  for (let iter = 0; iter < 50; iter++) {
    let moved = 0;
    for (const n of nodes) {
      let sw = 0;
      let s = 0;
      for (const e of used) {
        if (e.a !== n && e.b !== n) continue;
        const w = e.hard ? 1e6 : e.weight;
        s += w * (e.a === n ? pos.get(e.b)! - e.d : pos.get(e.a)! + e.d);
        sw += w;
      }
      if (!sw) continue;
      const v = s / sw;
      moved = Math.max(moved, Math.abs(v - pos.get(n)!));
      pos.set(n, v);
    }
    if (moved < 1e-5) break;
  }
  return { pos, used, dropped: [...dropped] };
}

// Связные группы кусков по использованным связям.
function components(nodes: number[], edges: Edge[]): number[][] {
  const adj = new Map<number, number[]>(nodes.map((n) => [n, []]));
  for (const e of edges) {
    adj.get(e.a)?.push(e.b);
    adj.get(e.b)?.push(e.a);
  }
  const seen = new Set<number>();
  const out: number[][] = [];
  for (const n of nodes) {
    if (seen.has(n)) continue;
    const comp: number[] = [];
    const stack = [n];
    seen.add(n);
    while (stack.length) {
      const x = stack.pop()!;
      comp.push(x);
      for (const y of adj.get(x) ?? []) if (!seen.has(y)) {
        seen.add(y);
        stack.push(y);
      }
    }
    out.push(comp);
  }
  return out;
}

// Член куска, который звучит в момент u (секунды от начала куска).
function memberAt(p: Piece, u: number, len: number): Member | null {
  return p.members.find((m) => hasAudio(m.clip) && u >= m.at - 1e-6 && u + len <= m.at + m.clip.durationSec + 1e-6) ?? null;
}

export async function alignByAudio(cameras: Camera[], coarse: SyncResult, audio: AudioFetch & { whole?: (clip: ClipMeta) => Promise<AudioPiece | null> }, opts: AudioOptions): Promise<AudioSyncResult> {
  const pieces = buildPieces(cameras, coarse, opts);
  const issues: Issue[] = [];
  const nameOf = (id: string) => cameras.find((c) => c.id === id)?.name ?? '';
  const whole = audio.whole ?? ((c: ClipMeta) => audio.features(c, 0, c.durationSec));

  // Ход работы: чтение звука, сравнение пар, точная сверка. Оценка оставшегося только уменьшается.
  const audible = pieces.filter((p) => opts.isEnabled(p.cameraId) && p.members.some((m) => hasAudio(m.clip)));
  const clipsToRead = audible.flatMap((p) => p.members.filter((m) => hasAudio(m.clip)));
  let done = 0;
  let left = clipsToRead.length + (audible.length * (audible.length - 1)) / 2 + audible.length * 2;
  const tick = (n = 1) => {
    done += n;
    left = Math.max(0, left - n);
    opts.onProgress?.(done, done + left);
  };

  // 1. Отпечаток каждого куска по всей длине.
  const read = await pool(clipsToRead, 3, async (m) => {
    const piece = await whole(m.clip);
    tick();
    return { m, piece };
  });
  const got = new Map(read.map((r) => [r.m.clip.id, r.piece]));
  for (const p of audible) {
    const frames = Math.ceil(p.length * RATE) + 1;
    const data = new Float32Array(frames * 12);
    let any = false;
    for (const m of p.members) {
      const a = got.get(m.clip.id);
      if (!a) continue;
      p.peakDb = Math.max(p.peakDb, a.peakDb);
      p.channel.set(m.clip.id, a.channel);
      if (a.peakDb < SILENCE_DB) continue;
      const at = Math.round(m.at * RATE);
      const n = Math.min(a.feat.frames, frames - at);
      if (n > 0) data.set(a.feat.data.subarray(0, n * a.feat.bands), at * a.feat.bands);
      any = true;
    }
    if (any) {
      p.feat = { frames, bands: 12, data };
      p.coarse = pooled(p.feat);
    }
  }

  // 2. Пары: каждый кусок с каждым, кроме кусков одной камеры (одна камера не снимает два клипа сразу).
  const live = audible.filter((p) => p.feat);
  const edges: Edge[] = [];
  const ambiguousOf = new Set<number>();
  const triedOf = new Set<number>();
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      tick();
      if (a.cameraId === b.cameraId || (a.follower && b.follower)) continue;
      triedOf.add(a.id);
      triedOf.add(b.id);
      const r = measurePair(a, b);
      if (r.edge) edges.push(r.edge);
      if (r.ambiguous) {
        ambiguousOf.add(a.id);
        ambiguousOf.add(b.id);
      }
    }
  }

  // Жёсткие связи: куски с контрольным кадром и точным тайм-кодом держат свои места по часам.
  const anchors = pieces.filter((p) => p.trust === 'anchor');
  for (let i = 1; i < anchors.length; i++) {
    edges.push({ a: anchors[0].id, b: anchors[i].id, d: anchors[i].prior - anchors[0].prior, weight: Infinity, support: 0, tested: 0, checks: [], fine: false, fineConfidence: 0, slope: 0, mid: 0, span: 0, hard: true });
  }

  // 5 (до сборки). Точная сверка по волне для каждой найденной пары.
  for (const e of edges) {
    if (e.hard) continue;
    const a = pieces[e.a];
    const b = pieces[e.b];
    const best = e.checks.filter((c) => c.agree).sort((x, y) => y.score - x.score).slice(0, FINE_WINDOWS);
    const fineDs: { d: number; conf: number }[] = [];
    for (const c of best) {
      const u = c.at + (WIN - FINE_LEN) / 2;
      const ma = memberAt(a, u, FINE_LEN);
      const mb = memberAt(b, u - c.local - FINE_RANGE, FINE_LEN + 2 * FINE_RANGE);
      if (!ma || !mb) continue;
      const [x, y] = await Promise.all([
        audio.samples(ma.clip, u - ma.at, FINE_LEN, a.channel.get(ma.clip.id) ?? 0),
        audio.samples(mb.clip, u - c.local - FINE_RANGE - mb.at, FINE_LEN + 2 * FINE_RANGE, b.channel.get(mb.clip.id) ?? 0),
      ]);
      if (!x || !y || x.length < FINE_SR * 0.5) continue;
      const off = Math.round(FINE_RANGE * FINE_SR);
      const g = gccPhat(x, y, FINE_SR, off, off);
      // x[0] — момент u куска a, совпадает с y[off + lag] — моментом u − local − range + (off + lag)/sr куска b.
      // Точка по волне относится к своему месту записи; с учётом хода часов переносим её в середину общей части.
      if (g && g.confidence >= FINE_CONFIDENCE && Math.abs(g.lag) < off) fineDs.push({ d: c.local - g.lag / FINE_SR + e.slope * (e.mid - (u + FINE_LEN / 2)), conf: g.confidence });
    }
    if (DEBUG) console.log(`точно ${a.cameraId} — ${b.cameraId}: грубо ${e.d.toFixed(3)}, по волне ${fineDs.map((f) => `${f.d.toFixed(3)} (${f.conf.toFixed(0)})`).join(', ') || 'нет'}`);
    if (fineDs.length) {
      e.d = median(fineDs.map((f) => f.d));
      e.fine = true;
      e.fineConfidence = median(fineDs.map((f) => f.conf));
    }
  }
  tick(audible.length);

  // 3. Сборка: сначала ведущие куски, ведомые — потом и только по ним.
  const leaders = live.filter((p) => !p.follower).map((p) => p.id);
  const leaderEdges = edges.filter((e) => !pieces[e.a].follower && !pieces[e.b].follower);
  for (const p of anchors) if (!leaders.includes(p.id)) leaders.push(p.id);
  const { pos, used, dropped } = solve(leaders, leaderEdges, pieces);
  const comps = components(leaders, used);

  // 4. Где стоит каждая группа: контрольный кадр и точный тайм-код — жёстко, иначе — по часам согласных о дате.
  const placed = new Map<number, number>(); // начало куска на таймлинии
  const trustedStarts = pieces.filter((p) => p.trust !== 'none').map((p) => p.prior);
  const sessionStart = trustedStarts.length ? Math.min(...trustedStarts) : coarse.start;
  for (const comp of comps) {
    const ps = comp.map((n) => pieces[n]);
    const hard = ps.filter((p) => p.trust === 'anchor');
    const voters = hard.length ? hard : ps.filter((p) => p.trust === 'clock' || p.trust === 'weak');
    let shift: number;
    if (voters.length) {
      shift = weightedMedian(voters.map((p) => ({ v: p.prior - pos.get(p.id)!, w: p.trust === 'weak' ? 1 : 3 })));
    } else if (comp.length > 1 || triedOf.has(comp[0])) {
      // Группа только из устройств с неверной датой: кладём в начало съёмки.
      shift = sessionStart - Math.min(...comp.map((n) => pos.get(n)!));
    } else {
      continue;
    }
    for (const n of comp) if (comp.length > 1 || pieces[n].trust === 'anchor') placed.set(n, pos.get(n)! + shift);
  }

  // Ведомые: по своим связям с уже поставленными ведущими.
  for (const p of live.filter((x) => x.follower)) {
    const votes: { v: number; w: number }[] = [];
    for (const e of edges) {
      if (e.a === p.id && placed.has(e.b) && !pieces[e.b].follower) votes.push({ v: placed.get(e.b)! - e.d, w: e.weight });
      if (e.b === p.id && placed.has(e.a) && !pieces[e.a].follower) votes.push({ v: placed.get(e.a)! + e.d, w: e.weight });
    }
    if (votes.length) placed.set(p.id, weightedMedian(votes));
  }

  // Поправки клипов: от раскладки по часам до найденного места.
  const corrections: Record<string, number> = { ...(opts.pre ?? {}) };
  const pieceCorr = new Map<number, number>();
  for (const p of pieces) {
    if (!placed.has(p.id) || !opts.isEnabled(p.cameraId)) continue;
    const c = placed.get(p.id)! - p.prior;
    pieceCorr.set(p.id, c);
    for (const m of p.members) corrections[m.clip.id] = placed.get(p.id)! + m.at - m.p.start;
  }
  // Кусок, не нашедший пары по звуку, берёт поправку соседей своей камеры: между двумя — по времени от одного
  // к другому, с одной стороны — как у ближайшего. Часы камеры ошибаются примерно одинаково весь день.
  for (const cam of cameras) {
    if (!opts.isEnabled(cam.id)) continue;
    const own = pieces.filter((p) => p.cameraId === cam.id);
    const known = own.filter((p) => pieceCorr.has(p.id)).sort((a, b) => a.prior - b.prior);
    if (!known.length) continue;
    for (const p of own) {
      if (pieceCorr.has(p.id)) continue;
      const before = [...known].reverse().find((k) => k.prior <= p.prior);
      const after = known.find((k) => k.prior > p.prior);
      let c: number;
      if (before && after) {
        const f = (p.prior - before.prior) / (after.prior - before.prior);
        c = pieceCorr.get(before.id)! + f * (pieceCorr.get(after.id)! - pieceCorr.get(before.id)!);
      } else c = pieceCorr.get((before ?? after)!.id)!;
      for (const m of p.members) corrections[m.clip.id] = p.prior + c + m.at - m.p.start;
    }
  }

  // Точки сверки для таймлинии: окна, где звук совпал.
  const anchorsOf = new Map<string, AudioAnchor[]>();
  const usedSet = new Set(used);
  const addAnchor = (piece: Piece, other: Piece, u: number, c: Check, role: AudioAnchor['role'], e: Edge) => {
    const m = memberAt(piece, u, 0) ?? piece.members[0];
    const om = memberAt(other, u - (piece.id === e.a ? e.d : -e.d), 0) ?? other.members[0];
    const list = anchorsOf.get(piece.cameraId) ?? [];
    if (list.length >= 60) return;
    list.push({
      cameraId: piece.cameraId,
      clipId: m.clip.id,
      refCameraId: other.cameraId,
      refClipId: om.clip.id,
      at: (placed.get(piece.id) ?? piece.prior) + u,
      correction: corrections[m.clip.id] ?? 0,
      score: c.score,
      ratio: c.ratio,
      accepted: role !== 'ignored',
      role,
      fine: e.fine,
      fineConfidence: e.fineConfidence,
      drift: piece.recorder || other.recorder,
    });
    anchorsOf.set(piece.cameraId, list);
  };
  for (const e of edges) {
    if (e.hard) continue;
    const role: AudioAnchor['role'] = usedSet.has(e) ? 'confirm' : 'ignored';
    const a = pieces[e.a];
    const b = pieces[e.b];
    for (const c of e.checks.filter((x) => x.agree)) {
      addAnchor(a, b, c.at + WIN / 2, c, role, e);
      addAnchor(b, a, c.at + WIN / 2 - e.d, c, role, e);
    }
  }

  // Итог по камерам.
  const results: AudioCameraResult[] = cameras.map((cam) => {
    const own = pieces.filter((p) => p.cameraId === cam.id);
    const anchorsList = anchorsOf.get(cam.id) ?? [];
    const base = { cameraId: cam.id, steps: [] as { from: number; correction: number }[], anchors: anchorsList };
    if (!own.length || !own.some((p) => p.members.some((m) => hasAudio(m.clip)))) return { ...base, status: cam.clips.length ? 'no-audio' as const : 'no-overlap' as const, model: null, correction: null };
    if (!opts.isEnabled(cam.id)) return { ...base, status: 'disabled' as const, model: null, correction: null };
    const withSound = own.filter((p) => p.feat);
    if (!withSound.length) return { ...base, status: 'silent' as const, model: null, correction: null };
    const solved = own.filter((p) => pieceCorr.has(p.id));
    const model = own[0].clockOnly || own.length > 1 && own.every((p) => p.recorder) ? 'per-clip' as const : own.length > 1 ? 'per-anchor' as const : 'single' as const;
    if (own.every((p) => p.trust === 'anchor')) return { ...base, status: 'reference' as const, model: null, correction: null };
    if (!solved.length) {
      const status = own.some((p) => ambiguousOf.has(p.id)) || own.some((p) => triedOf.has(p.id) && edges.some((e) => e.a === p.id || e.b === p.id)) ? 'no-match' as const : 'no-overlap' as const;
      return { ...base, status, model: null, correction: null };
    }
    const first = solved.sort((a, b) => a.prior - b.prior)[0];
    const corr = pieceCorr.get(first.id)!;
    const steps = model === 'per-anchor' ? solved.map((p) => ({ from: p.prior, correction: pieceCorr.get(p.id)! })) : [];
    const far = Math.abs(corr) > 60 || own.some((p) => p.trust === 'none');
    return {
      ...base,
      steps,
      status: Math.max(...solved.map((p) => Math.abs(pieceCorr.get(p.id)!))) > 0.04 ? 'applied' as const : 'confirmed' as const,
      model: steps.length > 1 && Math.max(...steps.map((s) => s.correction)) - Math.min(...steps.map((s) => s.correction)) > TOLERANCE ? 'per-anchor' as const : model === 'per-anchor' ? 'single' as const : model,
      correction: corr,
      wideShift: far ? corr : null,
    };
  });

  // Сообщения.
  for (const r of results) {
    const cam = cameras.find((c) => c.id === r.cameraId)!;
    const own = pieces.filter((p) => p.cameraId === cam.id);
    const actions: IssueAction[] = own[0]?.members[0] ? [{ kind: 'show-clip', clipId: own[0].members[0].clip.id }] : [];
    const confirmed = r.anchors.filter((a) => a.role === 'confirm').length;
    if (r.status === 'applied' && r.correction !== null && Math.abs(r.correction) > 2 && !own.some((p) => p.trust === 'none')) {
      const tz = Math.abs(Math.abs(r.correction) / 3600 - Math.round(Math.abs(r.correction) / 3600)) < 0.25 && Math.abs(r.correction) > 1800;
      issues.push(issue({
        severity: 'warning',
        cameraId: cam.id,
        title: `«${cam.name}» найдена по звуку на ${formatDurationHuman(Math.abs(r.correction))} ${r.correction > 0 ? 'позже' : 'раньше'}, чем показывают её часы`,
        details: `Часы этой камеры были сбиты${tz ? ' — похоже, на ней другой часовой пояс' : ''}. Звук совпал с другими камерами в ${confirmed} местах по всей общей записи — это не случайность. Проверьте стыковку по картинке; отключить поправку можно в карточке камеры.`,
        actions,
      }));
    } else if ((r.status === 'applied' || r.status === 'confirmed') && own.some((p) => p.trust === 'none')) {
      issues.push(issue({
        severity: 'info',
        cameraId: cam.id,
        title: `«${cam.name}» встала по звуку`,
        details: `Дате на устройстве программа не верит, поэтому место найдено только по звуку: совпадение подтверждено в ${confirmed} местах по всей общей записи.`,
        actions,
      }));
    } else if (r.status === 'no-match') {
      const ambiguous = own.some((p) => ambiguousOf.has(p.id));
      issues.push(issue({
        severity: 'warning',
        cameraId: cam.id,
        title: ambiguous ? `«${cam.name}»: звук похож на несколько мест съёмки` : `«${cam.name}» не нашлась по звуку`,
        details: ambiguous
          ? 'Музыка или речь повторяется, и звук этой камеры одинаково хорошо совпадает с разными местами. Программа не угадывает: камера осталась по своим часам. Отметьте контрольный кадр или подгоните её по хлопку.'
          : 'Общий звук с другими камерами есть, но уверенного совпадения по всей записи не нашлось. Камера осталась по своим часам — проверьте её по хлопку.',
        actions: [...actions, { kind: 'open-faq', anchor: 'manual-sync' }],
      }));
    } else if (r.status === 'no-overlap' && own.some((p) => p.trust === 'none')) {
      issues.push(issue({
        severity: 'warning',
        cameraId: cam.id,
        title: `«${cam.name}»: место не найдено`,
        details: 'Дате устройства верить нельзя, а общего звука с другими камерами не нашлось. Запись лежит в начале съёмки — поставьте её вручную по хлопку или отметьте контрольный кадр.',
        actions: [...actions, { kind: 'open-faq', anchor: 'manual-sync' }],
      }));
    } else if (r.status === 'silent') {
      issues.push(issue({
        severity: 'warning',
        cameraId: cam.id,
        title: `«${cam.name}»: в звуке тишина — сверить по звуку нельзя`,
        details: 'Звуковая дорожка есть, но в ней ничего не записано: встроенный микрофон был выключен или уровень записи стоял на нуле. Камера осталась по тайм-коду и часам. На следующих съёмках включите запись звука на каждой камере.',
        actions: [{ kind: 'open-faq', anchor: 'audio' }],
      }));
    }
  }
  // Две камеры с точным тайм-кодом или контрольным кадром расходятся по звуку — сообщаем, раскладку не трогаем.
  for (const e of edges) {
    if (e.hard) continue;
    const a = pieces[e.a];
    const b = pieces[e.b];
    if (a.trust !== 'anchor' || b.trust !== 'anchor') continue;
    const gap = e.d - (b.prior - a.prior);
    if (Math.abs(gap) > 0.06 + (a.recorder || b.recorder ? DRIFT_PER_SEC * Math.max(a.length, b.length) : 0)) {
      issues.push(issue({
        severity: 'info',
        cameraId: b.cameraId,
        title: `По звуку «${nameOf(b.cameraId)}» расходится с «${nameOf(a.cameraId)}» на ${formatDurationHuman(Math.abs(gap))}`,
        details: 'У обеих камер точное время — тайм-код или контрольный кадр, поэтому раскладка не менялась. Скорее всего, камеры стояли далеко друг от друга: звук идёт около 340 м/с. Проверьте стыковку по картинке.',
        actions: [{ kind: 'open-faq', anchor: 'manual-sync' }],
      }));
    }
  }
  // Ход часов рекордера за запись — в пределах нормы, но если заметен, говорим, как поставлена запись.
  for (const e of used) {
    const drift = Math.abs(e.slope) * e.span;
    const rec = pieces[e.a].recorder ? pieces[e.a] : pieces[e.b].recorder ? pieces[e.b] : null;
    if (!rec || drift <= 0.08 || issues.some((i) => i.cameraId === rec.cameraId && /часы рекордера ушли/.test(i.title))) continue;
    issues.push(issue({
      severity: 'info',
      cameraId: rec.cameraId,
      title: `«${nameOf(rec.cameraId)}»: за ${formatDurationHuman(e.span)} записи часы рекордера ушли на ${Math.round(drift * 1000)} мс — это в пределах погрешности`,
      details: `Часы рекордера и камер идут чуть по-разному — для длинной записи это нормально. Запись поставлена по своей середине: к началу и к концу звук может отличаться от видео примерно на ±${Math.round(drift * 500)} мс. Если нужна точность до кадра по всей длине, подгоните отдельные места по хлопку в монтажке.`,
      actions: [],
    }));
  }
  if (dropped.some((e) => !e.hard && e.support >= 3)) {
    issues.push(issue({
      severity: 'info',
      cameraId: null,
      title: 'Сверка по звуку нашла противоречие и разрешила его',
      details: 'Совпадения звука разных пар камер не сходились между собой. Программа оставила те, что подтверждены в большем числе мест по всей записи, а слабые отбросила.',
      actions: [],
    }));
  }

  opts.onProgress?.(done + left, done + left);
  return { cameras: results, corrections, issues };
}
