import type { Rate } from './types.ts';

export const DAY = 86400;

export function rateValue(r: Rate): number {
  return r.num / r.den;
}

export function parseRate(text: string | undefined | null): Rate | null {
  if (!text) return null;
  const m = /^(\d+)(?:\/(\d+))?$/.exec(text.trim());
  if (!m) return null;
  const num = Number(m[1]);
  const den = m[2] ? Number(m[2]) : 1;
  if (!num || !den) return null;
  return { num, den };
}

// 29.97 → 30, 23.976 → 24, 50 → 50
export function nominalRate(fps: number): number {
  return Math.round(fps);
}

export function isNtscRate(fps: number): boolean {
  return Math.abs(fps - Math.round(fps)) > 0.001;
}

export function wrapDay(sec: number): number {
  const w = sec % DAY;
  return w < 0 ? w + DAY : w;
}

// Разница по кругу суток в диапазоне (-12 ч, +12 ч]
export function wrapSigned(sec: number): number {
  let w = wrapDay(sec);
  if (w > DAY / 2) w -= DAY;
  return w;
}

export interface TcParts {
  h: number;
  m: number;
  s: number;
  f: number;
  drop: boolean;
}

export function parseTc(text: string): TcParts | null {
  const m = /^(\d{1,2})[:.](\d{2})[:.](\d{2})([:;.,])(\d{2,3})$/.exec(text.trim());
  if (!m) return null;
  return { h: +m[1], m: +m[2], s: +m[3], f: +m[5], drop: m[4] === ';' || m[4] === ',' };
}

export function formatTc(p: TcParts): string {
  const sep = p.drop ? ';' : ':';
  return `${pad2(p.h)}:${pad2(p.m)}:${pad2(p.s)}${sep}${pad2(p.f)}`;
}

// Номер кадра тайм-кода от полуночи с учётом drop frame (только 30/60 DF).
export function tcToFrameCount(p: TcParts, countRate: number): number {
  const total = (p.h * 3600 + p.m * 60 + p.s) * countRate + p.f;
  if (!p.drop) return total;
  const dropPerMin = countRate === 60 ? 4 : 2;
  const totalMinutes = p.h * 60 + p.m;
  return total - dropPerMin * (totalMinutes - Math.floor(totalMinutes / 10));
}

// Секунды реального времени от полуночи тайм-кода.
// countRate — по сколько кадров считается тайм-код, actualFps — реальная частота счёта (29.97 для NTSC).
export function tcToSeconds(p: TcParts, countRate: number, actualFps: number): number {
  if (!isNtscRate(actualFps)) {
    return p.h * 3600 + p.m * 60 + p.s + p.f / countRate;
  }
  return tcToFrameCount(p, countRate) / actualFps;
}

// Время суток в виде тайм-кода при заданной частоте (без drop frame).
export function secondsToTcText(daySeconds: number, fps: number): string {
  const nominal = nominalRate(fps);
  let totalFrames = Math.round(wrapDay(daySeconds) * nominal);
  totalFrames = totalFrames % (DAY * nominal);
  const f = totalFrames % nominal;
  const s = Math.floor(totalFrames / nominal);
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}:${pad2(f)}`;
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
