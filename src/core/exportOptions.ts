// Опции экспорта — все выключены по умолчанию: раскладку программы они не меняют, только то, что уйдёт в монтажку.
import type { AudioSyncResult } from './audioSync.ts';
import type { Camera, SyncResult } from './types.ts';

// Проблемные клипы — те, чьё место звук не нашёл: устройство не нашлось по звуку, часть съёмки не связана
// с остальной, или у устройства нет звука вовсе. Клипы, стоящие по тайм-коду рядом с найденными соседями,
// и клипы с точностью хуже кадра сюда не входят: их место известно, пусть и не идеально.
export function problemClips(cameras: Camera[], audio: AudioSyncResult | null | undefined): Set<string> {
  const out = new Set<string>();
  const unsure = audio?.unsure;
  if (!unsure) return out;
  for (const cam of cameras) {
    const live = cam.clips.filter((c) => !cam.excludedClipIds.includes(c.id));
    const allUnsure = live.length > 0 && live.every((c) => unsure[c.id]);
    for (const c of live) {
      const r = unsure[c.id];
      if (r === 'not-found' || r === 'apart' || (r === 'no-sound' && allUnsure)) out.add(c.id);
    }
  }
  return out;
}

export const END_GAP = 10; // секунд между концом съёмки и перенесёнными клипами

// Проблемные клипы — в конец таймлинии, как делает PluralEyes: каждый на своей дорожке, подряд, в прежнем
// порядке, через 10 секунд после последнего клипа. Остальные клипы не двигаются.
export function moveToEnd(sync: SyncResult, ids: Set<string>): SyncResult {
  if (!ids.size || !sync.placements.some((p) => ids.has(p.clipId))) return sync;
  const stay = sync.placements.filter((p) => !ids.has(p.clipId));
  const end = Math.max(...(stay.length ? stay : sync.placements).map((p) => p.end));
  const at = new Map<string, number>(); // где следующий перенесённый клип каждой дорожки
  const moved = sync.placements
    .filter((p) => ids.has(p.clipId))
    .sort((a, b) => a.start - b.start)
    .map((p) => {
      const start = at.get(p.cameraId) ?? end + END_GAP;
      const len = p.end - p.start;
      at.set(p.cameraId, start + len);
      return { ...p, start, end: start + len, lane: 0 };
    });
  const placements = [...stay, ...moved];
  return {
    ...sync,
    placements,
    start: Math.min(...placements.map((p) => p.start)),
    end: Math.max(...placements.map((p) => p.end)),
  };
}
