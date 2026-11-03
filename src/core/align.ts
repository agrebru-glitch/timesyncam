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
// 4. Где сборка стоит во времени, решают часы устройств, согласных о дате; контрольный кадр и тайм-код,
//    который оператор отметил точным или звук подтвердил общим, держат своё место жёстко.
// 5. Сдвиг каждой пары уточняется по самой волне на 48 кГц — до долей миллисекунды.
import type { Camera, ClipMeta, Issue, IssueAction, Placement, SyncResult } from './types.ts';
import { FEAT_RATE, FINE_SR, gccPhat, hasAttacks as active, poolFeatures, sliceFeatures as slice, xcorrFeatures } from './audioFeatures.ts';
import type { Features } from './audioFeatures.ts';
import { correlate, SILENCE_DB } from './audioSync.ts';
import type { AudioAnchor, AudioCameraResult, AudioFetch, AudioOptions, AudioPiece, AudioSyncResult } from './audioSync.ts';
import { formatDurationHuman, pluralRu } from './format.ts';
import { refineClips } from './refine.ts';

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
const SHARED_TC = 0.1; // тайм-коды двух устройств общие, если звук совпал с ними до 0,1 с
const LOOSE_CLOCKS = 600; // часы, выставленные вручную, расходятся на минуты; на часы и сутки — уже сбиты

type Trust = 'anchor' | 'clock' | 'weak' | 'none';

// Журнал решений: какие сдвиги проверялись, сколько окон совпало, что выбрано и почему. Уходит в отчёт
// для разработчика; с переменной окружения TSC_ALIGN_DEBUG=1 ещё и печатается.
const DEBUG = typeof process !== 'undefined' && !!process.env?.TSC_ALIGN_DEBUG;
type Log = (line: string) => void;

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
  // Тайм-код совпадает с часами устройства: место по часам точно до кадра, но сами часы могли быть
  // выставлены неточно — звук его поправляет.
  exact: boolean;
  fileClock: boolean; // время только из даты файла: при копировании она меняется
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
  sound?: number; // общий тайм-код: сдвиг, который показал звук (d — по тайм-коду)
  slips?: Map<string, number>; // сбои тайм-кода внутри куска, найденные по клипам: клип → на сколько перенести
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

// Ошибка часов устройства в момент at по известным местам его кусков: между двумя — по прямой,
// с края — как у ближайшего.
function clockErrorAt(known: { at: number; c: number }[], at: number): number {
  const s = [...known].sort((a, b) => a.at - b.at);
  const before = [...s].reverse().find((k) => k.at <= at);
  const after = s.find((k) => k.at > at);
  if (before && after) return before.c + ((at - before.at) / (after.at - before.at)) * (after.c - before.c);
  return (before ?? after)!.c;
}

// Поправка куска по звуку (c) — насколько часы устройства ошиблись в начале записи. len — длина записи для
// одиночного клипа без тайм-кода (только по таким видно, что значат часы).
interface ClockError {
  at: number;
  c: number;
  len: number | null;
}

const soloLength = (p: Piece) => (p.clockOnly && !p.fileClock && p.members.length === 1 ? p.members[0].clip.recordedSec : null);

// Часы устройства отмечают конец записи, а не начало: так пишет стоковый Android (время — при остановке), и по имени
// файла это видно не всегда. Тогда у клипов разной длины, вставших по звуку, одинакова не поправка c, а c + длина.
// Решается только с большим запасом, чтобы ответ не скакал у порога: ≥ 3 клипа, длины расходятся хотя бы на 10 с,
// разброс «конца» ≤ 1 с и в 5 раз меньше разброса «начала». Ответ — общая ошибка часов (c + длина), иначе null.
function endOfRecording(errors: ClockError[]): number | null {
  const solo = errors.filter((e) => e.len !== null) as (ClockError & { len: number })[];
  if (solo.length < 3) return null;
  const lens = solo.map((e) => e.len);
  if (Math.max(...lens) - Math.min(...lens) < 10) return null;
  const spread = (v: number[]) => {
    const m = median(v);
    return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
  };
  const ends = solo.map((e) => e.c + e.len);
  const asEnd = spread(ends);
  return asEnd <= 1 && spread(solo.map((e) => e.c)) >= 5 * Math.max(asEnd, 0.3) ? median(ends) : null;
}

// Поправка куска по ошибке часов его устройства: по соседям во времени, а если часы отмечают конец записи —
// общая ошибка минус длина самого клипа.
function expectedCorrection(errors: ClockError[], p: Piece): number {
  const end = endOfRecording(errors);
  const len = soloLength(p);
  return end !== null && len !== null ? end - len : clockErrorAt(errors, p.prior);
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
      const outlier = cs?.dateOutlierSec !== null && cs?.dateOutlierSec !== undefined;
      // Жёстко стоят: камера с контрольным кадром (её тайм-код держит все клипы), клип с экраном у камеры
      // без тайм-кода и камера, чей тайм-код оператор отметил точным. Тайм-код, который просто совпадает
      // с часами камеры, — это те же часы: две камеры с неточно выставленными часами так разошлись бы на секунды.
      const trust: Trust = opts.fixed?.has(cam.id) || members.some((m) => opts.controlClips?.has(m.clip.id)) || (cam.timecodeTrust === 'absolute' && cs?.timeSource === 'timecode')
        ? 'anchor'
        : outlier ? 'none' : fileOnly ? 'weak' : 'clock';
      pieces.push({
        id: pieces.length,
        cameraId: cam.id,
        members,
        prior: pre(first),
        length,
        trust,
        // BWF-время целыми секундами у всех файлов — это часы рекордера, округлённые до секунды (Zoom H-серии),
        // а не тайм-код генератора: точным оно не бывает и общим тайм-кодом с камерой может совпасть лишь случайно.
        exact: trust === 'clock' && cs?.timeSource === 'timecode' && !members.every((m) => m.clip.tc?.source === 'bwf' && Math.abs(m.clip.tc.seconds - Math.round(m.clip.tc.seconds)) < 1e-6),
        fileClock: fileOnly,
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

// Проверка сдвига по клипам. Слабое, но настоящее совпадение — трансляция с голосами комментаторов против
// микрофона камеры на трибуне — окна по 20 с почти не проходят порог, а у камеры из сотни коротких клипов
// большинство окон попадает в паузы и на стыки. Зато каждый клип в отдельности находится на своём месте:
// клип ищется в ±30 с вокруг места по кандидату, и случайно в ±1 с пик попадает с вероятностью около 3%.
// Пять и больше попаданий из большинства клипов — не случайность (на матче пользователя — 23 из 27).
const MEMBER_SEARCH = 30;
const MEMBER_AGREE = 1;
const MEMBER_PROBES = 20;
function memberAgreement(a: Piece, b: Piece, d: number): { hits: number; tested: number; d: number } {
  const locals: number[] = [];
  let tested = 0;
  // Клипы куска p ищутся в куске q; sign — как найденное отклонение переводится в сдвиг «начало b минус начало a».
  const probe = (p: Piece, q: Piece, toQ: (u: number) => number, sign: number) => {
    const longest = [...p.members].sort((x, y) => y.clip.durationSec - x.clip.durationSec).slice(0, MEMBER_PROBES);
    for (const m of longest) {
      const L = Math.min(m.clip.durationSec, 60);
      if (L < 10) continue;
      const pos = toQ(m.at);
      if (pos - MEMBER_SEARCH < 0 || pos + L + MEMBER_SEARCH > q.length) continue;
      const t = slice(p.feat!, Math.round(m.at * RATE), Math.round(L * RATE));
      const r = slice(q.feat!, Math.round((pos - MEMBER_SEARCH) * RATE), Math.round((L + 2 * MEMBER_SEARCH) * RATE));
      if (!active(t) || !active(r)) continue;
      const mm = correlate(t, r, MEMBER_SEARCH * RATE, MEMBER_SEARCH * RATE);
      if (!mm) continue;
      tested++;
      if (Math.abs(mm.lag / RATE) <= MEMBER_AGREE) locals.push(d + (sign * mm.lag) / RATE);
    }
  };
  if (a.members.length >= b.members.length) probe(a, b, (u) => u - d, -1);
  else probe(b, a, (u) => u + d, 1);
  return { hits: locals.length, tested, d: locals.length ? median(locals) : d };
}

// Сбои тайм-кода внутри куска по клипам. Камера держит тайм-код между клипами, но после выключения (смена
// аккумулятора) пересчитывает его по часам — и дальше все клипы сдвинуты на доли или целые секунды. Обычно это
// находит уточнение, но при слабом общем звуке (трансляция с комментаторами) короткие клипы его порог не проходят.
// Здесь каждый клип ищется сам в ±30 с, и ряд их сдвигов делится на участки — сбой виден как ступенька,
// подтверждённая несколькими клипами подряд. Одиночное несогласие — шум, его не слушаем.
// На матче пользователя: до 78-й минуты 0, потом +0,38 с, со 101-й — +2,3 с.
function memberSlips(a: Piece, b: Piece, d: number): Map<string, number> {
  const multi = a.members.length >= b.members.length ? a : b;
  const other = multi === a ? b : a;
  const toOther = (u: number) => (multi === a ? u - d : u + d);
  const found: { i: number; lag: number }[] = [];
  multi.members.forEach((m, i) => {
    const L = Math.min(m.clip.durationSec, 60);
    if (L < 8) return;
    const pos = toOther(m.at);
    if (pos - MEMBER_SEARCH < 0 || pos + L + MEMBER_SEARCH > other.length) return;
    const t = slice(multi.feat!, Math.round(m.at * RATE), Math.round(L * RATE));
    const r = slice(other.feat!, Math.round((pos - MEMBER_SEARCH) * RATE), Math.round((L + 2 * MEMBER_SEARCH) * RATE));
    if (!active(t) || !active(r)) return;
    const mm = correlate(t, r, MEMBER_SEARCH * RATE, MEMBER_SEARCH * RATE);
    if (!mm || mm.score < 0.035 || Math.abs(mm.lag / RATE) > MEMBER_SEARCH - 1.5) return;
    found.push({ i, lag: mm.lag / RATE });
  });
  // Ряд сдвигов по порядку клипов делится на участки с постоянным сдвигом (динамическое программирование):
  // каждый лишний участок стоит штраф, отклонение точки от медианы участка учитывается не больше 0,3 с. Так
  // новый участок появляется, только если его подтверждают несколько клипов подряд (каждый сберегает до 0,3,
  // а штраф — 1), а одиночные ложные пики остаются выбросами внутри своего участка.
  const n = found.length;
  const shifts = new Map<string, number>();
  if (n < 4) return shifts;
  const CAP = 0.3;
  const PENALTY = 1;
  const segCost = (j: number, k: number) => {
    const med = median(found.slice(j, k + 1).map((f) => f.lag));
    let c = 0;
    for (let x = j; x <= k; x++) c += Math.min(Math.abs(found[x].lag - med), CAP);
    return { c, med };
  };
  const best = new Array<number>(n + 1).fill(Infinity);
  const from = new Array<number>(n + 1).fill(0);
  best[0] = 0;
  for (let k = 1; k <= n; k++) {
    for (let j = 0; j < k; j++) {
      const v = best[j] + segCost(j, k - 1).c + (j > 0 ? PENALTY : 0);
      if (v < best[k]) [best[k], from[k]] = [v, j];
    }
  }
  const segs: { j: number; k: number; med: number }[] = [];
  for (let k = n; k > 0; k = from[k]) segs.unshift({ j: from[k], k: k - 1, med: segCost(from[k], k - 1).med });
  // Граница между участками — на самой длинной паузе между их крайними клипами: там камеру и выключали.
  const cut: number[] = [];
  for (let s2 = 1; s2 < segs.length; s2++) {
    const lo = found[segs[s2 - 1].k].i;
    const hi = found[segs[s2].j].i;
    let at = hi;
    let gap = -1;
    for (let i = lo + 1; i <= hi; i++) {
      const g = multi.members[i].at - (multi.members[i - 1].at + multi.members[i - 1].clip.durationSec);
      if (g > gap) [gap, at] = [g, i];
    }
    cut.push(at);
  }
  const assigned = multi.members.map((_, i) => {
    let s2 = 0;
    while (s2 < cut.length && i >= cut[s2]) s2++;
    return segs[s2].med;
  });
  // Клипы между двумя долгими паузами (камеру выключали — тайм-код между ними непрерывен) ищутся вместе одним
  // длинным окном: так совпадение сильнее, чем у каждого клипа в отдельности. Если весь такой участок ясно стоит
  // в другом месте, чем ему досталось по разбиению, — он переносится. На матче: последние клипы после паузы 83 с,
  // где трансляция почти кончилась и поодиночке клипы совпадали слабо, — 2 с мимо.
  const LONG_PAUSE = 60;
  let runStart = 0;
  for (let i = 1; i <= multi.members.length; i++) {
    const m = multi.members[i];
    const prev = multi.members[i - 1];
    if (i < multi.members.length && m.at - (prev.at + prev.clip.durationSec) <= LONG_PAUSE) continue;
    const first = multi.members[runStart];
    const last = prev;
    const from = first.at;
    const pos = toOther(from);
    const L = Math.min(last.at + last.clip.durationSec - from, other.length - pos - MEMBER_SEARCH);
    if (L >= 30 && pos - MEMBER_SEARCH >= 0) {
      const t = slice(multi.feat!, Math.round(from * RATE), Math.round(L * RATE));
      const r = slice(other.feat!, Math.round((pos - MEMBER_SEARCH) * RATE), Math.round((L + 2 * MEMBER_SEARCH) * RATE));
      const mm = active(t) && active(r) ? correlate(t, r, MEMBER_SEARCH * RATE, MEMBER_SEARCH * RATE) : null;
      const here = assigned[runStart];
      const joint = mm ? mm.lag / RATE : NaN;
      // Свои клипы участка: если ни один не подтверждает доставшийся сдвиг, а совместный поиск согласен с ними,
      // хватает и слабого совпадения — оно подтверждено дважды (на матче: клип +0,09 с, участок целиком +0,19 с).
      const own = found.filter((f) => f.i >= runStart && f.i < i).map((f) => f.lag);
      const ownSays = own.length > 0 && own.every((v) => Math.abs(v - here) > 1) && Math.abs(joint - median(own)) <= 0.3;
      if (mm && Math.abs(joint - here) > 0.5 && ((mm.score >= 0.04 && mm.ratio >= 1.3) || (ownSays && mm.score >= 0.02 && mm.ratio >= 1.25))) {
        for (let k = runStart; k < i; k++) assigned[k] = joint;
      }
    }
    runStart = i;
  }
  multi.members.forEach((m, i) => {
    if (Math.abs(assigned[i]) > 0.1) shifts.set(m.clip.id, assigned[i]);
  });
  return shifts;
}

// Сравнение пары кусков: лучший проверенный сдвиг или null.
function measurePair(a: Piece, b: Piece, log: Log): { edge: Edge | null; ambiguous: boolean } {
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
  log(`пара ${a.cameraId}#${a.id} — ${b.cameraId}#${b.id}:`);
  for (const x of tried) log(`    сдвиг ${x.d.toFixed(2)} с: совпало ${x.support} из ${x.tested}, балл ${x.score.toFixed(2)}`);
  if (!best || best.support === 0) return { edge: null, ambiguous: false };
  // Соперники — кандидаты, подтверждённые почти так же. Лучший должен выиграть у каждого очно: на тех же
  // местах записи совпасть лучше хотя бы в трёх окнах и не проиграть заметно. Иначе — неоднозначно, не угадываем.
  let winner = best;
  let undecided = false;
  for (const c of tried) {
    if (c === winner || Math.abs(c.d - winner.d) <= PEAK_GUARD || c.support < winner.support * RIVAL) continue;
    const h = headToHead(a, b, winner.d, c.d);
    log(`    очно ${winner.d.toFixed(2)} против ${c.d.toFixed(2)}: t=${h.t.toFixed(1)}, явных побед ${h.clear1} : ${h.clear2}`);
    if (h.winner === 1) continue;
    if (h.winner === 2) winner = c;
    else undecided = true;
  }
  if (undecided) {
    log('    итог: неоднозначно — звук похож на несколько мест');
    return { edge: null, ambiguous: true };
  }
  const share = winner.support / Math.max(1, winner.tested);
  const runnerUp = Math.max(0, ...tried.filter((x) => x !== winner && Math.abs(x.d - winner.d) > PEAK_GUARD).map((x) => x.support));
  // Уверенно: совпало хотя бы в трёх окнах и в большинстве проверенных — или хотя бы в восьми и вдвое чаще
  // любого другого сдвига (устройство часть времени не слышит зал: человек с петличкой вышел, и такие окна
  // совпасть не могут). Короткая общая часть (одно-два окна): все окна согласны и соперника нет.
  const strong = winner.support >= 3 && (share >= 0.5 || (winner.support >= 8 && winner.support >= 2 * runnerUp));
  const short = winner.tested <= 2 && winner.support === winner.tested && (!second || second.support === 0 || winner !== best) && winner.score >= 0.25;
  if (!strong && !short) {
    // Окна не подтвердили — проверка по клипам: у кого из кандидатов клипы сами находятся на своих местах.
    const byMembers = tried.map((x) => ({ x, ...memberAgreement(a, b, x.d) })).sort((p, q) => q.hits - p.hits);
    const top = byMembers[0];
    const next = byMembers.find((m) => Math.abs(m.d - top.d) > PEAK_GUARD);
    for (const m of byMembers) if (m.tested) log(`    по клипам ${m.x.d.toFixed(2)}: на своём месте ${m.hits} из ${m.tested}`);
    if (top && top.hits >= 5 && top.hits >= 0.5 * top.tested && (!next || next.hits * 2 <= top.hits)) {
      log(`    итог: ${top.d.toFixed(3)} с (по клипам)`);
      const checks = verify(a, b, top.d);
      const c = centered(a, b, checks, top.d);
      return {
        edge: { a: a.id, b: b.id, d: c.d, weight: top.hits * 0.05, support: top.hits, tested: top.tested, checks, fine: false, fineConfidence: 0, slope: c.slope, mid: c.mid, span: c.span, slips: memberSlips(a, b, top.d) },
        ambiguous: false,
      };
    }
    log('    итог: уверенного совпадения нет');
    return { edge: null, ambiguous: false };
  }
  const chosen = winner;
  log(`    итог: ${chosen.d.toFixed(3)} с${strong ? '' : ' (короткая общая часть)'}`);
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

// Время суток для группы, сведённой по звуку. Каждое устройство своими часами предлагает, где стоит группа.
// Часы бывают сбиты, поэтому не усредняем всех подряд: берём самую весомую компанию устройств, чьи
// предложения согласны в пределах точности часов (1,5 с, с датой файла — 3,5 с), и её середину; если в ней
// есть тайм-код по часам — его, он точнее секунды. Когда согласных нет (у каждого свои часы), — компанию тех,
// кто расходится на минуты, а не на часы и сутки, и часы средней из них. Ответ не зависит от порядка дорожек.
// Вес устройства делится на число его кусков — камера с полсотней клипов не перевешивает остальных.
export function agreeingClocks(votes: { device: string; v: number; weak: boolean; exact?: boolean }[]): number {
  if (!votes.length) return 0;
  const perDevice = new Map<string, number>();
  for (const x of votes) perDevice.set(x.device, (perDevice.get(x.device) ?? 0) + 1);
  const w = (x: { device: string; weak: boolean }) => (x.weak ? 1 : 3) / perDevice.get(x.device)!;
  const mid = (group: typeof votes) => weightedMedian(group.map((y) => ({ v: y.v, w: w(y) })));
  const strongest = (near: (x: (typeof votes)[number], y: (typeof votes)[number]) => boolean, apart: number) => {
    const groups = votes.map((x) => {
      const group = votes.filter((y) => near(x, y));
      return { group, w: group.reduce((s, y) => s + w(y), 0), devices: new Set(group.map((y) => y.device)).size, at: mid(group) };
    }).sort((a, b) => b.w - a.w || b.devices - a.devices || b.at - a.at);
    const top = groups[0];
    // Другая компания того же веса стоит отдельно — согласия нет.
    const rival = groups.some((g) => Math.abs(g.w - top.w) <= 1e-9 && g.devices === top.devices && Math.abs(g.at - top.at) > apart);
    return { top, rival };
  };
  const tight = strongest((x, y) => Math.abs(y.v - x.v) <= (x.weak || y.weak ? 3.5 : 1.5), 1.5);
  if (!tight.rival) {
    const precise = tight.top.group.filter((y) => y.exact);
    return mid(precise.length ? precise : tight.top.group);
  }
  // Середина без усреднения — часы одного из устройств: среднее двух сбитых часов не верно ни для кого.
  const group = [...strongest((x, y) => Math.abs(y.v - x.v) <= LOOSE_CLOCKS, LOOSE_CLOCKS).top.group].sort((a, b) => a.v - b.v);
  const total = group.reduce((s, y) => s + w(y), 0);
  let acc = 0;
  return group.find((y) => (acc += w(y)) >= total / 2 - 1e-9)!.v;
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
  const lines: string[] = [];
  const log: Log = (line) => {
    lines.push(line);
    if (DEBUG) console.log(line);
  };
  for (const p of pieces) {
    log(`кусок ${p.cameraId}#${p.id}: ${p.members.length} клип(ов), ${p.length.toFixed(1)} с, доверие ${p.trust}${p.recorder ? ', только звук' : ''}${p.follower ? ', ведомый' : ''}: ${p.members.map((m) => `${m.clip.name}@${m.at.toFixed(2)}`).join(', ')}`);
  }
  const nameOf = (id: string) => cameras.find((c) => c.id === id)?.name ?? '';
  const whole = audio.whole ?? ((c: ClipMeta) => audio.features(c, 0, c.durationSec));

  // Ход работы: чтение звука, сравнение пар, точная сверка. Оценка оставшегося только уменьшается.
  const audible = pieces.filter((p) => opts.isEnabled(p.cameraId) && p.members.some((m) => hasAudio(m.clip)));
  const clipsToRead = audible.flatMap((p) => p.members.filter((m) => hasAudio(m.clip)));
  let done = 0;
  let left = 2 * clipsToRead.length + (audible.length * (audible.length - 1)) / 2 + audible.length * 2;
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
      p.coarse = poolFeatures(p.feat, POOL);
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
      const r = measurePair(a, b, log);
      if (r.edge) edges.push(r.edge);
      if (r.ambiguous) {
        ambiguousOf.add(a.id);
        ambiguousOf.add(b.id);
      }
    }
  }

  // Жёсткие связи: куски с контрольным кадром и тайм-кодом, отмеченным точным, держат свои места по часам.
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
    log(`точно ${a.cameraId} — ${b.cameraId}: грубо ${e.d.toFixed(3)}, по волне ${fineDs.map((f) => `${f.d.toFixed(3)} (${f.conf.toFixed(0)})`).join(', ') || 'нет'}`);
    if (fineDs.length) {
      e.d = median(fineDs.map((f) => f.d));
      e.fine = true;
      e.fineConfidence = median(fineDs.map((f) => f.conf));
    }
  }
  tick(audible.length);

  // Общий тайм-код. Если звук совпал с тайм-кодами двух устройств до 0,1 с, тайм-код у них общий
  // (от одного генератора) — он точнее звука: дальняя камера слышит сцену позже на путь звука.
  // Такая пара стоит по тайм-коду. Тайм-коды, которые со звуком не сошлись, — просто часы, решает звук.
  for (const e of edges) {
    const a = pieces[e.a];
    const b = pieces[e.b];
    if (e.hard || !a.exact || !b.exact) continue;
    const byTc = b.prior - a.prior;
    if (Math.abs(e.d - byTc) > SHARED_TC) continue;
    log(`общий тайм-код ${a.cameraId}#${a.id} — ${b.cameraId}#${b.id}: по звуку ${e.d.toFixed(3)}, по тайм-коду ${byTc.toFixed(3)}`);
    e.sound = e.d;
    e.d = byTc;
    e.hard = true;
  }

  // 3. Сборка: сначала ведущие куски, ведомые — потом и только по ним.
  const leaders = live.filter((p) => !p.follower).map((p) => p.id);
  const leaderEdges = edges.filter((e) => !pieces[e.a].follower && !pieces[e.b].follower);
  for (const p of anchors) if (!leaders.includes(p.id)) leaders.push(p.id);
  const { pos, used, dropped } = solve(leaders, leaderEdges, pieces);
  const comps = components(leaders, used);
  for (const e of dropped) if (!e.hard) log(`отброшено как противоречие: ${pieces[e.a].cameraId}#${e.a} — ${pieces[e.b].cameraId}#${e.b}, ${e.d.toFixed(3)} с (совпало ${e.support})`);
  log(`группы: ${comps.map((c) => c.map((n) => `${pieces[n].cameraId}#${n}`).join(' + ')).join(' | ')}`);

  // 4. Где стоит каждая группа. Первой — главная: с жёсткой опорой, а без неё — с наибольшим числом устройств.
  // Её время — по опоре, иначе по часам согласных о дате. Следующая группа встаёт так, чтобы часы устройств,
  // уже поставленных в прежних группах, ошибались так же, как там: ошибка часов устройства одна на весь день.
  // Иначе её место решат часы другого устройства, и половины съёмки разъедутся на их расхождение.
  const placed = new Map<number, number>(); // начало куска на таймлинии
  const trustedStarts = pieces.filter((p) => p.trust !== 'none').map((p) => p.prior);
  const sessionStart = trustedStarts.length ? Math.min(...trustedStarts) : coarse.start;
  const rank = (comp: number[]) => [
    comp.some((n) => pieces[n].trust === 'anchor') ? 1 : 0,
    new Set(comp.map((n) => pieces[n].cameraId)).size,
    comp.reduce((s, n) => s + pieces[n].length, 0),
  ];
  const ordered = [...comps].sort((x, y) => {
    const a = rank(x);
    const b = rank(y);
    return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
  });
  // Ошибка часов устройства по уже поставленным кускам. Дата файла меняется при копировании — по ней нельзя.
  const errorsOf = (cameraId: string): ClockError[] => pieces.filter((p) => p.cameraId === cameraId && placed.has(p.id) && !p.fileClock).map((p) => ({ at: p.prior, c: placed.get(p.id)! - p.prior, len: soloLength(p) }));
  const apart: number[][] = []; // группы, которые встали по своим часам отдельно от главной
  for (const comp of ordered) {
    const ps = comp.map((n) => pieces[n]);
    const hard = ps.filter((p) => p.trust === 'anchor');
    const voters = hard.length ? hard : ps.filter((p) => p.trust === 'clock' || p.trust === 'weak');
    const known = ps.filter((p) => !p.fileClock && errorsOf(p.cameraId).length);
    let shift: number;
    if (hard.length) {
      shift = median(hard.map((p) => p.prior - pos.get(p.id)!));
    } else if (known.length) {
      shift = median(known.map((p) => p.prior + expectedCorrection(errorsOf(p.cameraId), p) - pos.get(p.id)!));
      log(`время группы — по ошибке часов её устройств в других группах: ${known.map((p) => `${p.cameraId}#${p.id}`).join(', ')}`);
    } else if (voters.length) {
      shift = agreeingClocks(voters.map((p) => ({ device: p.cameraId, v: p.prior - pos.get(p.id)!, weak: p.trust === 'weak', exact: p.exact })));
      log(`время группы — по часам: ${voters.map((p) => `${p.cameraId}#${p.id} ${(p.prior - pos.get(p.id)! - shift).toFixed(2)} с`).join(', ')}`);
      if (comp !== ordered[0] && comp.length > 1) apart.push(comp);
    } else if (comp.length > 1 || triedOf.has(comp[0])) {
      if (comp !== ordered[0] && comp.length > 1) apart.push(comp);
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

  // Сбои тайм-кода внутри кусков, найденные по клипам.
  const slipOf = new Map<string, number>();
  for (const e of edges) for (const [id, v] of e.slips ?? []) slipOf.set(id, v);
  for (const e of edges) {
    if (!e.slips?.size) continue;
    const p = pieces[pieces[e.a].members.length >= pieces[e.b].members.length ? e.a : e.b];
    const most = Math.max(...[...e.slips.values()].map(Math.abs));
    log(`сбои тайм-кода ${p.cameraId}#${p.id} по клипам: ${e.slips.size} клипов, до ${most.toFixed(2)} с`);
    issues.push(issue({
      severity: 'info',
      cameraId: p.cameraId,
      clipId: [...e.slips.keys()][0],
      title: `«${nameOf(p.cameraId)}»: тайм-код сбивался после пауз — до ${most < 1 ? `${Math.round(most * 1000)} мс` : `${most.toFixed(1).replace('.', ',')} с`}`,
      details: `${e.slips.size} ${e.slips.size === 1 ? 'клип' : 'клипов'} после сбоя поставлены по звуку: каждый клип найден отдельно, и подряд идущие клипы согласно показали сдвиг. Так бывает, когда камеру выключали — при включении она пересчитывает тайм-код по часам.`,
      actions: [{ kind: 'show-clip', clipId: [...e.slips.keys()][0] }],
    }));
  }

  // Поправки клипов: от раскладки по часам до найденного места.
  const corrections: Record<string, number> = { ...(opts.pre ?? {}) };
  const pieceCorr = new Map<number, number>();
  for (const p of pieces) {
    if (!placed.has(p.id) || !opts.isEnabled(p.cameraId)) continue;
    const c = placed.get(p.id)! - p.prior;
    pieceCorr.set(p.id, c);
    for (const m of p.members) corrections[m.clip.id] = placed.get(p.id)! + m.at - m.p.start + (slipOf.get(m.clip.id) ?? 0);
  }
  // Кусок, не нашедший пары по звуку, берёт поправку соседей своей камеры: между двумя — по времени от одного
  // к другому, с одной стороны — как у ближайшего. Часы камеры ошибаются примерно одинаково весь день.
  // Но если по своим же часам записи рекордера накладываются друг на друга — так не бывает, даты файлов
  // сбились при копировании, — часам не верим: запись встаёт встык к соседней, как файлы, на которые
  // рекордер режет длинную запись. Без звука и без верной даты место — догадка: об этом предупреждаем.
  const guessed = new Map<string, { names: string[]; chained: boolean }>();
  const endClocks = new Set<string>(); // устройства, чьи часы отмечают конец записи
  for (const cam of cameras) {
    if (!opts.isEnabled(cam.id)) continue;
    const own = pieces.filter((p) => p.cameraId === cam.id).sort((a, b) => a.prior - b.prior || a.id - b.id);
    const known = own.filter((p) => pieceCorr.has(p.id));
    if (!known.length || known.length === own.length) continue;
    const overlapping = own.some((p, i) => i > 0 && p.prior < own[i - 1].prior + own[i - 1].length - CHAIN_GAP);
    const chained = overlapping && own.every((p) => p.recorder);
    const startOf = new Map(known.map((p) => [p.id, p.prior + pieceCorr.get(p.id)!]));
    const errors: ClockError[] = known.map((p) => ({ at: p.prior, c: pieceCorr.get(p.id)!, len: soloLength(p) }));
    const put = (p: Piece, start: number) => {
      startOf.set(p.id, start);
      for (const m of p.members) corrections[m.clip.id] = start + m.at - m.p.start + (slipOf.get(m.clip.id) ?? 0);
      if (p.trust !== 'none' && p.trust !== 'weak') return;
      const g = guessed.get(cam.id) ?? { names: [], chained };
      g.names.push(...p.members.map((m) => m.clip.name));
      guessed.set(cam.id, g);
    };
    if (chained) {
      // Вперёд — встык за предыдущей, потом назад — перед следующей (для записей до первой найденной).
      own.forEach((p, i) => {
        if (!startOf.has(p.id) && i > 0 && startOf.has(own[i - 1].id)) put(p, startOf.get(own[i - 1].id)! + own[i - 1].length);
      });
      for (let i = own.length - 2; i >= 0; i--) if (!startOf.has(own[i].id) && startOf.has(own[i + 1].id)) put(own[i], startOf.get(own[i + 1].id)! - own[i].length);
    } else {
      for (const p of own) if (!startOf.has(p.id)) put(p, p.prior + expectedCorrection(errors, p));
      if (endOfRecording(errors) !== null) endClocks.add(cam.id);
    }
  }
  for (const cameraId of endClocks) {
    issues.push(issue({
      severity: 'info',
      cameraId,
      title: `«${nameOf(cameraId)}»: время в файлах — конец записи`,
      details: 'По записям, совпавшим по звуку, видно: устройство пишет в файл момент остановки записи, а не начала. Записи без общего звука поставлены с учётом их длины.',
      actions: [],
    }));
  }
  for (const comp of apart) {
    const ids = [...new Set(comp.map((n) => pieces[n].cameraId))];
    issues.push(issue({
      severity: 'warning',
      cameraId: ids[0],
      title: `${ids.map((id) => `«${nameOf(id)}»`).join(', ')}: по звуку не связаны с остальной съёмкой`,
      details: 'Между собой эти записи совпали по звуку, а с остальными — нет, поэтому эта часть съёмки стоит по часам своих устройств. Если часы расходятся с остальными камерами, она сдвинута на это расхождение. Проверьте стыковку по хлопку или отметьте контрольный кадр.',
      actions: [{ kind: 'open-faq', anchor: 'manual-sync' }],
    }));
  }
  // 6. Уточнение каждого клипа по звуку: тайм-код через паузы, секунды BWF, «встык», ход часов.
  const fixedClips = new Set<string>();
  const exactClips = new Set(pieces.filter((p) => p.exact).flatMap((p) => p.members.map((m) => m.clip.id)));
  for (const p of pieces) if (p.trust === 'anchor') for (const m of p.members) fixedClips.add(m.clip.id);
  for (const e of edges) if (e.sound !== undefined) for (const n of [e.a, e.b]) for (const m of pieces[n].members) fixedClips.add(m.clip.id);
  const refined = await refineClips({
    cameras,
    coarse,
    corrections,
    feats: got,
    samples: (c, s, d, ch) => audio.samples(c, s, d, ch),
    isEnabled: opts.isEnabled,
    followers: opts.followers ?? new Set(),
    fixedClips,
    exactClips,
    log,
    tick,
  });
  Object.assign(corrections, refined.corrections);
  issues.push(...refined.issues);

  for (const [cameraId, g] of guessed) {
    // Записи, которые уточнение всё-таки нашло по звуку, — уже не догадка.
    g.names = g.names.filter((name) => !pieces.some((p) => p.cameraId === cameraId && p.members.some((m) => m.clip.name === name && refined.measured.has(m.clip.id))));
    if (!g.names.length) continue;
    const shown = g.names.slice(0, 5).join(', ') + (g.names.length > 5 ? '…' : '');
    issues.push(issue({
      severity: 'warning',
      cameraId,
      title: `«${nameOf(cameraId)}»: ${g.names.length === 1 ? 'запись не нашлась' : `${pluralRu(g.names.length, 'запись', 'записи', 'записей')} не нашлись`} по звуку`,
      details: `${shown}. Дате этих записей программа не верит, а уверенного совпадения звука нет, поэтому они поставлены по соседним записям того же устройства${g.chained ? ' — встык, как рекордер режет длинную запись на файлы' : ''}. Проверьте их по хлопку.`,
      actions: [{ kind: 'open-faq', anchor: 'manual-sync' }],
    }));
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
    if (!e.checks.length) continue;
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
    // Часы камер обычно расходятся на секунды — предупреждаем, когда камера ушла заметно, от 10 с.
    if (r.status === 'applied' && r.correction !== null && Math.abs(r.correction) > 10 && !own.some((p) => p.trust === 'none')) {
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
    } else if ((r.status === 'applied' || r.status === 'confirmed') && r.correction !== null && Math.abs(r.correction) > 1.5 && !own.some((p) => p.trust === 'none' || p.trust === 'anchor')) {
      // Расхождение больше точности часов (секунда), но меньше заметного сбоя: место по звуку точное,
      // а часы устройства расходятся с остальными — говорим, на сколько и в какую сторону.
      issues.push(issue({
        severity: 'info',
        cameraId: cam.id,
        title: `Часы «${cam.name}» ${r.correction > 0 ? 'отстают' : 'спешат'} на ${formatDurationHuman(Math.abs(r.correction))} относительно остальных камер`,
        details: `По звуку «${cam.name}» поставлена точно: совпадение подтверждено в ${confirmed} местах по всей общей записи. Расхождение — в часах самого устройства. Перед съёмкой выставляйте время на всех камерах и рекордерах по одним часам.`,
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
  // Две камеры с точным временем (контрольный кадр, тайм-код, отмеченный точным, или общий тайм-код)
  // расходятся по звуку — сообщаем, раскладку не трогаем.
  for (const e of edges) {
    const a = pieces[e.a];
    const b = pieces[e.b];
    const shared = e.sound !== undefined;
    if (!shared && (e.hard || a.trust !== 'anchor' || b.trust !== 'anchor')) continue;
    const gap = shared ? e.sound! - e.d : e.d - (b.prior - a.prior);
    if (Math.abs(gap) > 0.06 + (a.recorder || b.recorder ? DRIFT_PER_SEC * Math.max(a.length, b.length) : 0)) {
      issues.push(issue({
        severity: 'info',
        cameraId: b.cameraId,
        title: `По звуку «${nameOf(b.cameraId)}» расходится с «${nameOf(a.cameraId)}» на ${formatDurationHuman(Math.abs(gap))}`,
        details: shared
          ? 'Тайм-код у них общий — звук совпал с ним до долей секунды, поэтому камеры стоят по тайм-коду. Скорее всего, они стояли далеко друг от друга: звук идёт около 340 м/с. Проверьте стыковку по картинке.'
          : 'У обеих камер точное время — тайм-код или контрольный кадр, поэтому раскладка не менялась. Скорее всего, камеры стояли далеко друг от друга: звук идёт около 340 м/с. Проверьте стыковку по картинке.',
        actions: [{ kind: 'open-faq', anchor: 'manual-sync' }],
      }));
    }
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

  for (const p of pieces) log(`место ${p.cameraId}#${p.id}: ${placed.has(p.id) ? `поправка ${(placed.get(p.id)! - p.prior).toFixed(3)} с` : 'по звуку не найдено'}`);
  opts.onProgress?.(done + left, done + left);
  for (const r of results) r.accuracySec = refined.deviceAccuracy.get(r.cameraId) ?? null;
  return { cameras: results, corrections, issues, log: lines, drift: refined.drift, accuracy: refined.accuracy };
}
