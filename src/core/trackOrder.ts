// Порядок дорожек: сверху — камеры, у которых материала меньше всего, ниже — те, где его больше. В монтажке так
// удобнее: короткие вставки с редких камер лежат над основной камерой, которая пишет почти всё время. Дорожки только
// со звуком — всегда под камерами, между собой по тому же правилу. Пустые дорожки (файлы ещё не добавлены) — в самом
// низу, у кнопок «+ Камера» и «+ Звук», — там новую дорожку и ждут. Порядок одинаковый на таймлинии программы,
// в карточках, в мультивью и в экспорте; цвета дорожек от него не зависят.
import type { Camera } from './types.ts';

// Сколько материала у дорожки: суммарная длина клипов, кроме исключённых.
export function materialSec(cam: Camera): number {
  const excluded = new Set(cam.excludedClipIds);
  return cam.clips.reduce((s, c) => s + (excluded.has(c.id) ? 0 : c.durationSec), 0);
}

export const isAudioOnly = (cam: Camera) => cam.clips.length > 0 && cam.clips.every((c) => !c.hasVideo);

export function trackOrder<T extends Camera>(cameras: T[]): T[] {
  return cameras
    .map((c, i) => ({ c, i, audio: isAudioOnly(c) ? 1 : 0, empty: c.clips.length ? 0 : 1, sec: materialSec(c) }))
    .sort((x, y) => x.empty - y.empty || x.audio - y.audio || x.sec - y.sec || x.i - y.i)
    .map((x) => x.c);
}
