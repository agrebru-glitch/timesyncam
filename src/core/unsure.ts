// Клипы, чьё место неточно: звук его не подтвердил или подтвердил с точностью хуже кадра.
// На таймлинии они обведены пунктиром, на дорожке и в карточке — их число.
import type { AudioSyncResult, UnsureReason } from './audioSync.ts';
import type { Camera } from './types.ts';
import { pluralRu } from './format.ts';

export const UNSURE_TEXT: Record<UnsureReason, string> = {
  'no-sound': 'в клипе нет звука — стоит по тайм-коду и часам',
  neighbours: 'нет общего звука — стоит по соседним клипам',
  'not-found': 'звук не нашёл место — стоит по часам',
  apart: 'часть съёмки не связана по звуку с остальной — стоит по часам',
  rough: 'место по звуку, но точность хуже кадра',
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

// «3 клипа: 2 — нет общего звука…, 1 — точность хуже кадра» — для подсказки.
export function unsureDetails(s: UnsureSummary): string {
  return s.byReason.map((r) => `${pluralRu(r.count, 'клип', 'клипа', 'клипов')}: ${UNSURE_TEXT[r.reason]}`).join('\n');
}
