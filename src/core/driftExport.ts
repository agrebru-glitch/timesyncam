// Выравнивание хода часов при экспорте: какие записи растянуть, где проверить копию и как подставить её в XML.
//
// Сверка ставит запись с ходом часов по середине: к началу и к концу звук расходится с видео поровну. Копия,
// растянутая на найденный коэффициент, совпадает с видео по всей длине. Её начало — там, где по ходу часов
// начинается запись: на половину расхождения раньше места по середине (для часов, которые отстают).
import type { Camera, ClipMeta, Placement, SyncResult } from './types.ts';
import type { AudioSyncResult } from './audioSync.ts';

export interface DriftCheck {
  refId: string; // клип-опора: расхождение копии с одной и той же опорой должно быть одинаковым по всей длине
  refPath: string; // запись, звучащая в тот же момент (лучше — камера: её время и есть шкала таймлинии)
  refChannel: number;
  refAudioStart?: number; // где в опорном клипе начинается звук (у части телефонов — позже видео)
  at: number; // момент внутри копии, секунды
  refAt: number; // где этот звук должен быть в опорной записи
}

export interface DriftJob {
  clipId: string;
  deviceId: string;
  path: string;
  ratio: number; // во сколько раз копия длиннее оригинала
  ppm: number;
  outName: string; // «Дорожка/файл_drift+0.030s.wav» — внутри папки «<XML> — выровненный звук»
  checks: DriftCheck[];
}

export interface DriftRendered {
  clipId: string;
  ok: boolean;
  outPath?: string;
  durationSec?: number;
  checked: number; // в скольких местах копию удалось проверить по звуку
  residualMs: number | null; // наибольшее расхождение копии с опорой в этих местах
  spreadMs?: number | null; // насколько расхождение с одной и той же опорой меняется по длине копии
  reason?: string;
}

// Секунд звука в одной проверке: в гулком зале на 4 с пик тонул в отражениях и копии не проверялись вовсе.
// Неверный коэффициент внутри куска почти не виден (17 ppm за 8 с — 0,14 мс), он виден по разным местам копии.
export const CHECK_LEN = 8;
const CHECK_AT = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
export const CHECK_MIN = 2; // копию нужно проверить хотя бы в двух местах
// Ход часов исправлен, если расхождение копии с одной и той же опорой одинаково по всей длине — до четверти
// кадра. Само расхождение может быть и больше: запись по звуку стоит по согласию всех камер, а камеры стоят
// на разном расстоянии от звука. Но и у видео свои часы: камеры расходятся между собой на единицы ppm (на
// съёмке тестера — до 10), поэтому допуск растёт с расстоянием между точками. Проверка ловит грубые ошибки
// хода — вроде ложных 265 ppm у PluralEyes; сам ход точно меряет сверка по всем записям сразу.
export const CHECK_SPREAD = 0.008;
const CAMERA_DRIFT = 10e-6;
export const CHECK_OFFSET = 0.1; // дальше 0,1 с от расчётного места — что-то не так с самим местом, копию не ставим

export interface CheckVerdict {
  ok: boolean;
  checked: number;
  worst: number | null; // наибольшее расхождение, с
  spread: number | null; // разброс расхождений с одной опорой, с
  reason?: string;
}

export function judgeCopy(lags: { refId: string; at: number; lag: number }[]): CheckVerdict {
  const checked = lags.length;
  if (checked < CHECK_MIN) return { ok: false, checked, worst: null, spread: null, reason: 'копию не удалось проверить по звуку' };
  const worst = Math.max(...lags.map((l) => Math.abs(l.lag)));
  const byRef = new Map<string, typeof lags>();
  for (const l of lags) byRef.set(l.refId, [...(byRef.get(l.refId) ?? []), l]);
  const groups = [...byRef.values()].filter((g) => g.length >= 2);
  // Если опоры в каждом месте разные, их собственный разброс добавляется — допуск вдвое.
  const sets = groups.length ? groups : [lags];
  const base = groups.length ? CHECK_SPREAD : 2 * CHECK_SPREAD;
  let spread = 0;
  for (const g of sets) {
    const range = Math.max(...g.map((l) => l.lag)) - Math.min(...g.map((l) => l.lag));
    const span = Math.max(...g.map((l) => l.at)) - Math.min(...g.map((l) => l.at));
    spread = Math.max(spread, range);
    if (range > base + CAMERA_DRIFT * span) return { ok: false, checked, worst, spread: range, reason: `по длине копия расходится с видео на ${Math.round(range * 1000)} мс — ход часов измерен неточно` };
  }
  if (worst > CHECK_OFFSET) return { ok: false, checked, worst, spread, reason: `копия стоит в ${Math.round(worst * 1000)} мс от расчётного места` };
  return { ok: true, checked, worst, spread };
}

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
  const taken = new Set<string>();
  const nameOf = (id: string) => (cameras.find((c) => c.id === id)?.name ?? 'Звук').replace(/[\\/:*?"<>|]/g, '_').trim() || 'Звук';
  for (const p of sync.placements) {
    const device = deviceOf(p);
    const d = apply.get(device);
    const clip = clipOf.get(p.clipId);
    if (!d || !clip || clip.hasVideo || !hasSound(clip)) continue;
    const ratio = 1 + d.ppm * 1e-6;
    const start = copyStart(p, clip, ratio);
    const added = clip.durationSec * (ratio - 1);
    // Копии — по папкам дорожек: у двух рекордеров или двух карт одной петлички имена файлов совпадают.
    const stem = `${nameOf(device)}/${baseName(clip.name).replace(/\.[^.]+$/, '')}_drift${added >= 0 ? '+' : '-'}${Math.abs(added).toFixed(3)}s`;
    let outName = `${stem}.wav`;
    for (let n = 2; taken.has(outName.toLowerCase()); n++) outName = `${stem} (${n}).wav`;
    taken.add(outName.toLowerCase());
    const length = clip.durationSec * ratio;
    // Опоры — в порядке предпочтения: камеры, потом звук без хода часов, дольше всего звучащие вместе с копией.
    // Так одна и та же опора проходит через всю копию, и по ней виден остаток хода часов.
    const together = (r: (typeof refs)[number]) => Math.min(start + length, r.p.start + r.clip.durationSec) - Math.max(start, r.p.start);
    const mine = refs.filter((r) => together(r) > CHECK_LEN + 1).sort((a, b) => Number(b.clip.hasVideo) - Number(a.clip.hasVideo) || together(b) - together(a));
    // В каждом месте — до трёх опор по порядку: у одной камеры может быть эхо, тогда проверка берёт следующую.
    const checks: DriftCheck[] = [];
    for (const f of CHECK_AT) {
      const at = Math.max(0, Math.min(length - CHECK_LEN, f * length - CHECK_LEN / 2));
      const T = start + at;
      for (const ref of mine.filter((r) => r.p.start <= T - 0.2 && r.p.start + r.clip.durationSec >= T + CHECK_LEN + 0.2).slice(0, 3)) {
        checks.push({ refId: ref.clip.id, refPath: ref.clip.path, refChannel: 0, refAudioStart: ref.clip.audioStartSec ?? 0, at, refAt: T - ref.p.start });
      }
    }
    jobs.push({ clipId: clip.id, deviceId: device, path: clip.path, ratio, ppm: d.ppm, outName, checks });
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
