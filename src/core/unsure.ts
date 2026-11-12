// Клипы без сверки: звук не подтвердил их место или подтвердил с точностью хуже кадра. Обычно они стоят верно —
// по тайм-коду и часам, — но программа это не проверила. На таймлинии они обведены пунктиром, на дорожке и в карточке —
// их число.
import type { AudioSyncResult, UnsureReason } from './audioSync.ts';
import type { Camera } from './types.ts';
import { pluralRu } from './format.ts';

export const UNSURE_TEXT: Record<UnsureReason, string> = {
  'no-sound': 'в клипе нет звука — стоит по тайм-коду и часам',
  neighbours: 'нет общего звука — стоит по соседним клипам',
  'not-found': 'по звуку место не найдено — стоит по часам',
  apart: 'часть съёмки не связана по звуку с остальной — стоит по часам',
  rough: 'место найдено по звуку, но не точнее кадра',
};

const ORDER: UnsureReason[] = ['not-found', 'apart', 'neighbours', 'no-sound', 'rough'];

export interface UnsureSummary {
  ids: string[]; // клипы дорожки, которые сейчас на таймлинии
  byReason: { reason: UnsureReason; count: number }[];
}

export function unsureOf(cam: Camera, audio: AudioSyncResult | null | undefined): UnsureSummary {
  const map = audio?.unsure;
  if (!map) return { ids: [], byReason: [] };
  const excluded = new Set(cam.excludedClipIds);
  const ids = cam.clips.filter((c) => map[c.id] && !excluded.has(c.id)).map((c) => c.id);
  const counts = new Map<UnsureReason, number>();
  for (const id of ids) counts.set(map[id], (counts.get(map[id]) ?? 0) + 1);
  return { ids, byReason: ORDER.filter((r) => counts.has(r)).map((reason) => ({ reason, count: counts.get(reason)! })) };
}

// Строка для меню клипа: почему он без сверки.
export function unsureNote(reason: UnsureReason): string {
  return reason === 'rough' ? 'Сверен хуже кадра: место найдено по звуку, но совпадение нечёткое (эхо, далёкий микрофон)' : `Без сверки: ${UNSURE_TEXT[reason]}`;
}

// Клип, который не с чем сверить: в это время писало только его устройство.
export const ALONE_NOTE = 'Не с чем сверить: в это время другие устройства не писали — стоит по часам и соседним клипам своей камеры';

export function aloneOf(cam: Camera, audio: AudioSyncResult | null | undefined): string[] {
  const set = new Set(audio?.alone ?? []);
  const excluded = new Set(cam.excludedClipIds);
  return cam.clips.filter((c) => set.has(c.id) && !excluded.has(c.id)).map((c) => c.id);
}

// «3 клипа: 2 — нет общего звука…, 1 — точность хуже кадра» — для подсказки.
export function unsureDetails(s: UnsureSummary): string {
  return s.byReason.map((r) => `${pluralRu(r.count, 'клип', 'клипа', 'клипов')}: ${UNSURE_TEXT[r.reason]}`).join('\n');
}
