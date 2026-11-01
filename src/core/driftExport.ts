// Выравнивание хода часов при экспорте: какие записи растянуть, где проверить копию и как подставить её в XML.
//
// Сверка ставит запись с ходом часов по середине: к началу и к концу звук расходится с видео поровну. Копия,
// растянутая на найденный коэффициент, совпадает с видео по всей длине. Её начало — там, где по ходу часов
// начинается запись: на половину расхождения раньше места по середине (для часов, которые отстают).
import type { Camera, ClipMeta, Placement, SyncResult } from './types.ts';
import type { AudioSyncResult } from './audioSync.ts';

export interface DriftCheck {
  refPath: string; // запись, звучащая в тот же момент (лучше — камера: её время и есть шкала таймлинии)
  refChannel: number;
  at: number; // момент внутри копии, секунды
  refAt: number; // где этот звук должен быть в опорной записи
}

export interface DriftJob {
  clipId: string;
  path: string;
  ratio: number; // во сколько раз копия длиннее оригинала
  ppm: number;
  outName: string;
  checks: DriftCheck[];
}

export interface DriftRendered {
  clipId: string;
  ok: boolean;
  outPath?: string;
  durationSec?: number;
  checked: number; // в скольких местах копию удалось проверить по звуку
  residualMs: number | null; // наибольшее расхождение копии с опорой в этих местах
  reason?: string;
}

// Секунд звука в одной проверке. Коротко: если коэффициент неверен, копия «плывёт» внутри куска и пик
// размывается — короткий кусок это всё равно покажет.
export const CHECK_LEN = 4;

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const hasSound = (c: ClipMeta) => c.audioChannels > 0 && c.captureFps === null;

// Начало выровненной копии на таймлинии: запись стояла по середине.
export function copyStart(p: Placement, clip: ClipMeta, ratio: number): number {
  return p.start - ((ratio - 1) * clip.durationSec) / 2;
}

export function driftJobs(cameras: Camera[], sync: SyncResult, audio: AudioSyncResult | null): DriftJob[] {
  const apply = new Map((audio?.drift ?? []).filter((d) => d.apply).map((d) => [d.cameraId, d]));
  if (!apply.size) return [];
  const clipOf = new Map(cameras.flatMap((c) => c.clips.map((k) => [k.id, k] as const)));
  const deviceOf = (p: Placement) => p.timeCameraId ?? p.cameraId;
  // Опора для проверки: камера с видео, а без неё — звук без хода часов.
  const refs = sync.placements
    .map((p) => ({ p, clip: clipOf.get(p.clipId)! }))
    .filter((r) => r.clip && hasSound(r.clip) && !apply.has(deviceOf(r.p)))
    .sort((a, b) => Number(b.clip.hasVideo) - Number(a.clip.hasVideo));
  const jobs: DriftJob[] = [];
  for (const p of sync.placements) {
    const d = apply.get(deviceOf(p));
    const clip = clipOf.get(p.clipId);
    if (!d || !clip || clip.hasVideo || !hasSound(clip)) continue;
    const ratio = 1 + d.ppm * 1e-6;
    const start = copyStart(p, clip, ratio);
    const added = clip.durationSec * (ratio - 1);
    const outName = `${baseName(clip.name).replace(/\.[^.]+$/, '')}_drift${added >= 0 ? '+' : '-'}${Math.abs(added).toFixed(3)}s.wav`;
    const length = clip.durationSec * ratio;
    const checks: DriftCheck[] = [];
    for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const at = Math.max(0, Math.min(length - CHECK_LEN, f * length - CHECK_LEN / 2));
      const T = start + at;
      const ref = refs.find((r) => r.p.start <= T - 0.2 && r.p.start + r.clip.durationSec >= T + CHECK_LEN + 0.2);
      if (ref) checks.push({ refPath: ref.clip.path, refChannel: 0, at, refAt: T - ref.p.start });
    }
    jobs.push({ clipId: clip.id, path: clip.path, ratio, ppm: d.ppm, outName, checks });
  }
  return jobs;
}

// Камеры и раскладка, где выровненные записи заменены копиями: в XML пойдут копии на своих местах.
export function withDriftCopies(cameras: Camera[], sync: SyncResult, jobs: DriftJob[], done: DriftRendered[]): { cameras: Camera[]; sync: SyncResult } {
  const ok = new Map(done.filter((r) => r.ok && r.outPath && r.durationSec).map((r) => [r.clipId, r]));
  const jobOf = new Map(jobs.map((j) => [j.clipId, j]));
  const clipOf = new Map(cameras.flatMap((c) => c.clips.map((k) => [k.id, k] as const)));
  const outCameras = cameras.map((c) => ({
    ...c,
    clips: c.clips.map((k) => {
      const r = ok.get(k.id);
      if (!r) return k;
      return { ...k, path: r.outPath!, name: baseName(r.outPath!), durationSec: r.durationSec!, recordedSec: r.durationSec!, sizeBytes: Math.round(k.sizeBytes * jobOf.get(k.id)!.ratio) };
    }),
  }));
  const placements = sync.placements.map((p) => {
    const r = ok.get(p.clipId);
    if (!r) return p;
    const start = copyStart(p, clipOf.get(p.clipId)!, jobOf.get(p.clipId)!.ratio);
    return { ...p, start, end: start + r.durationSec! };
  });
  return {
    cameras: outCameras,
    sync: { ...sync, placements, start: Math.min(...placements.map((p) => p.start)), end: Math.max(...placements.map((p) => p.end)) },
  };
}
