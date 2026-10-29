// Контрольный кадр: камера снимает «Экран синхронизации», на котором раз в секунду меняется QR-код
// с точным временем часов компьютера. Точность даёт не сам код, а момент его смены: последний кадр
// со старым кодом и первый кадр с новым — смена была ровно между ними.

export const QR_PREFIX = 'TSC1 ';
export const QR_PERIOD_MS = 1000;

export function qrPayload(epochMs: number): string {
  return `${QR_PREFIX}${epochMs}`;
}

export function parseQrPayload(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /^TSC1 (\d{12,14})$/.exec(text.trim());
  return m ? Number(m[1]) : null;
}

export interface QrFrame {
  t: number; // время кадра внутри клипа, секунды
  code: number | null; // время с экрана, мс эпохи; null — код не прочитан (смаз, блик, кадр смены)
}

export interface QrResult {
  clipStartEpoch: number; // во сколько по часам экрана начался клип
  precisionSec: number;
  transitions: number; // сколько смен кода увидели
  codes: number; // сколько разных кодов прочитали
}

export interface ControlFrame {
  cameraId: string;
  clipId: string;
  localSec: number; // где в клипе отмечен контрольный кадр
}

export interface ControlOutcome {
  pre: Record<string, number>; // поправка каждого клипа камер с контрольным кадром
  fixed: Set<string>; // эти камеры — опорные для сверки по звуку
  clips: Set<string>; // клипы, в которых снят экран, — стоят точно сами по себе
  cameras: Map<string, { correction: number; precisionSec: number; transitions: number; frames: number }>;
}

// Поправки по контрольным кадрам. Часы и тайм-код связывают контрольный кадр со всей съёмкой камеры,
// поэтому поправка действует на все её клипы — и до, и после экрана синхронизации.
export function controlCorrections(
  results: { frame: ControlFrame; result: QrResult }[],
  placements: { clipId: string; cameraId: string; start: number }[],
  clockOnly: Set<string>,
): ControlOutcome {
  const byCam = new Map<string, { clipId: string; delta: number; precision: number; transitions: number }[]>();
  for (const { frame, result } of results) {
    const p = placements.find((x) => x.clipId === frame.clipId);
    if (!p) continue;
    const list = byCam.get(frame.cameraId) ?? [];
    list.push({ clipId: frame.clipId, delta: result.clipStartEpoch - p.start, precision: result.precisionSec, transitions: result.transitions });
    byCam.set(frame.cameraId, list);
  }
  const pre: Record<string, number> = {};
  const fixed = new Set<string>();
  const clips = new Set<string>();
  const cameras: ControlOutcome['cameras'] = new Map();
  for (const [camId, list] of byCam) {
    const best = list.filter((x) => x.transitions > 0);
    const use = best.length ? best : list;
    const correction = median(use.map((x) => x.delta));
    for (const p of placements) if (p.cameraId === camId) pre[p.clipId] = correction;
    for (const x of list) clips.add(x.clipId);
    // Без тайм-кода часы у каждого клипа ошибаются по-своему: клип с экраном ставим по нему самому,
    // остальные — общим сдвигом, их дальше уточнит звук.
    if (clockOnly.has(camId)) for (const x of use) pre[x.clipId] = x.delta;
    else fixed.add(camId);
    cameras.set(camId, {
      correction,
      precisionSec: Math.min(...use.map((x) => x.precision)),
      transitions: use.reduce((n, x) => n + x.transitions, 0),
      frames: list.length,
    });
  }
  return { pre, fixed, clips, cameras };
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// frames — кадры по порядку времени. Возвращает начало клипа по часам экрана.
export function analyzeQr(frames: QrFrame[], fps: number): QrResult | null {
  const read = frames.filter((f) => f.code !== null) as { t: number; code: number }[];
  if (read.length === 0) return null;
  const codes = new Set(read.map((f) => f.code));

  // Смены кода: последний кадр со старым кодом и первый с новым (между ними могут быть смазанные кадры).
  const estimates: number[] = [];
  for (let i = 1; i < read.length; i++) {
    const a = read[i - 1];
    const b = read[i];
    if (b.code === a.code) continue;
    if (b.code - a.code !== QR_PERIOD_MS) continue; // пропуск кода — смена не одна, такую пару не берём
    if (b.t - a.t > 3 / fps + 1e-6) continue; // между кадрами слишком много непрочитанных — неточно
    // Чистый кадр со старым кодом целиком отснят до смены, значит смена не раньше конца его выдержки.
    // Выдержку считаем по правилу 180°: половина длительности кадра.
    const exposure = 0.5 / fps;
    const switchLocal = (a.t + exposure + b.t) / 2;
    estimates.push(b.code / 1000 - switchLocal);
  }

  if (estimates.length > 0) {
    const est = median(estimates);
    const spread = estimates.length > 1 ? Math.max(...estimates.map((e) => Math.abs(e - est))) : 0.5 / fps;
    return {
      clipStartEpoch: est,
      precisionSec: Math.max(0.25 / fps, Math.min(spread, 1 / fps)) / Math.sqrt(Math.max(1, estimates.length / 2)),
      transitions: estimates.length,
      codes: codes.size,
    };
  }

  // Смены не видно (снимали меньше секунды): код показывался весь период, начало клипа — с точностью до секунды.
  const first = read[0];
  const lastSame = read.filter((f) => f.code === first.code).at(-1)!;
  // Код first.code показывался в [code, code + 1 с); кадры с ним — между first.t и lastSame.t.
  const lo = first.code / 1000 - first.t; // если первый кадр снят в самом начале показа
  const hi = (first.code + QR_PERIOD_MS) / 1000 - lastSame.t; // если последний — в самом конце
  return { clipStartEpoch: (lo + hi) / 2, precisionSec: Math.max(1 / fps, (hi - lo) / 2), transitions: 0, codes: codes.size };
}
