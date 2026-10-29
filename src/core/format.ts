// Форматирование для людей: время суток, длительности, размеры, сдвиги.
import { pad2, wrapDay, secondsToTcText } from './timecode.ts';

function plural(n: number, one: string, few: string, many: string): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

export function pluralRu(n: number, one: string, few: string, many: string): string {
  return `${n} ${plural(n, one, few, many)}`;
}

// 1 ч 12 мин, 3 мин 5 с, 0,4 с
export function formatDurationHuman(sec: number): string {
  const s = Math.abs(sec);
  if (s < 1) return `${s.toFixed(1).replace('.', ',')} с`;
  // Сначала округляем, потом делим на части — иначе выйдет «2 ч 60 мин».
  const totalSec = Math.round(s);
  if (totalSec < 60) return `${totalSec} с`;
  if (totalSec < 3600) {
    const rest = totalSec % 60;
    return rest ? `${Math.floor(totalSec / 60)} мин ${rest} с` : `${Math.floor(totalSec / 60)} мин`;
  }
  if (s < 86400 * 2) {
    const totalMin = Math.round(s / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m ? `${h} ч ${m} мин` : `${h} ч`;
  }
  return `${Math.round(s / 86400)} дн`;
}

export function formatClockTime(epochSec: number, tzMin: number, withSeconds = true): string {
  const t = wrapDay(epochSec + tzMin * 60);
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const s = Math.floor(t % 60);
  return withSeconds ? `${pad2(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(h)}:${pad2(m)}`;
}

export function formatTimecodeAt(epochSec: number, tzMin: number, fps: number): string {
  return secondsToTcText(epochSec + tzMin * 60, fps);
}

export function formatDate(epochSec: number, tzMin: number): string {
  const d = new Date((epochSec + tzMin * 60) * 1000);
  return `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

// Сдвиг камеры в виде +00:01:12:05 (часы:минуты:секунды:кадры)
export function formatShift(sec: number, fps = 25): string {
  const sign = sec < 0 ? '−' : '+';
  const nominal = Math.round(fps);
  const totalFrames = Math.round(Math.abs(sec) * nominal);
  const f = totalFrames % nominal;
  const s = Math.floor(totalFrames / nominal);
  return `${sign}${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}:${pad2(f)}`;
}

export function parseShift(text: string, fps = 25): number | null {
  const m = /^\s*([+\-−]?)\s*(?:(\d{1,2}):)?(?:(\d{1,2}):)?(\d{1,2})(?:[:;.](\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  const sign = m[1] === '-' || m[1] === '−' ? -1 : 1;
  const parts = [m[2], m[3], m[4]].filter((x) => x !== undefined).map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, mi, s] = parts;
  const f = m[5] ? Number(m[5]) : 0;
  return sign * (h * 3600 + mi * 60 + s + f / Math.round(fps));
}

// Как в Проводнике Windows: двоичные единицы.
export function formatSize(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  const TB = GB * 1024;
  if (bytes >= TB) return `${(bytes / TB).toFixed(1).replace('.', ',')} ТБ`;
  if (bytes >= GB) return `${Math.round(bytes / GB)} ГБ`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} МБ`;
  return `${Math.round(bytes / KB)} КБ`;
}

export function formatFps(fps: number): string {
  const r = Math.round(fps * 100) / 100;
  return Number.isInteger(r) ? `${r}p` : `${r.toString().replace('.', ',')}p`;
}

export function resolutionLabel(w: number | null, h: number | null): string | null {
  if (!w || !h) return null;
  if (w >= 7600) return '8K';
  if (w >= 5700) return '6K';
  if (w >= 5000) return '5K';
  if (w >= 3800) return '4K';
  if (w >= 2500) return '2,7K';
  if (h >= 1080 || w >= 1920) return 'Full HD';
  if (h >= 720) return 'HD';
  return `${w}×${h}`;
}
