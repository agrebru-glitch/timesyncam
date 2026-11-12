// Каналы многоканального рекордера на одной дорожке (ZOOM0001_Tr1/_Tr2, …S3/…S4): программа сверяет их как одно
// устройство, а показывает и отдаёт в монтажку каждый своей строкой — «Подкаст · Tr2», со своими M и S, как
// отдельную дорожку у PluralEyes («New Track (from …)»). Строка дорожки (lane) — один канал.
import { trackTail } from './sync.ts';
import type { Camera, Placement } from './types.ts';

// Подписи строк дорожки-рекордера: lane → «Tr2». Пусто, если это не рекордер с каналами на разных строках
// (у камеры с видео вторая строка — наложение клипов, а не канал).
export function channelLabels(cam: Camera, placements: Placement[]): Map<number, string> {
  const out = new Map<number, string>();
  if (!cam.clips.length || cam.clips.some((c) => c.hasVideo)) return out;
  const own = placements.filter((p) => p.cameraId === cam.id);
  const lanes = [...new Set(own.map((p) => p.lane))].sort((a, b) => a - b);
  if (lanes.length < 2) return out;
  const clipOf = new Map(cam.clips.map((c) => [c.id, c] as const));
  for (const lane of lanes) {
    const tails = new Set(own.filter((p) => p.lane === lane).map((p) => trackTail(clipOf.get(p.clipId)?.name ?? '') ?? ''));
    const tail = tails.size === 1 ? [...tails][0] : '';
    out.set(lane, tail || `канал ${lane + 1}`);
  }
  return out;
}

// Название строки канала: «Подкаст · Tr2»; null — строка не канал.
export function laneName(cam: Camera, placements: Placement[], lane: number): string | null {
  const label = channelLabels(cam, placements).get(lane);
  return label ? `${cam.name} · ${label}` : null;
}

// Ключ звука строки для предпросмотра и M/S: первая строка — сама дорожка, остальные каналы — «дорожка#строка».
export const laneKey = (cameraId: string, lane: number) => (lane > 0 ? `${cameraId}#${lane}` : cameraId);

// Для звука предпросмотра: каждый канал — своя «дорожка» со своим ключом, чтобы M и S работали на канал.
export function audioByChannel(cameras: Camera[], placements: Placement[]): { cameras: Camera[]; placements: Placement[] } {
  const extra: Camera[] = [];
  const split = new Set<string>();
  for (const cam of cameras) {
    const labels = channelLabels(cam, placements);
    if (!labels.size) continue;
    split.add(cam.id);
    for (const lane of labels.keys()) if (lane > 0) extra.push({ ...cam, id: laneKey(cam.id, lane) });
  }
  if (!split.size) return { cameras, placements };
  return {
    cameras: [...cameras, ...extra],
    placements: placements.map((p) => (split.has(p.cameraId) && p.lane > 0 ? { ...p, cameraId: laneKey(p.cameraId, p.lane) } : p)),
  };
}
