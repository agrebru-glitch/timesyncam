// Синхронизация: раскладывает клипы всех камер по реальному времени съёмки.
import type { Camera, CameraSync, ClipMeta, Issue, Placement, SyncResult, TimeSource } from './types.ts';
import { DAY, isNtscRate, rateValue, wrapDay, wrapSigned } from './timecode.ts';
import { formatDurationHuman, formatShift } from './format.ts';

const CLUSTER_TOLERANCE = 1.6; // секунды: часы камер пишут время с точностью до секунды
const ABSOLUTE_TC_TOLERANCE = 2; // если тайм-код совпадает с часами, это реальное время
const NUDGE_LIMIT = 1.5; // перекрытие клипов «по часам» до этой величины — погрешность часов

export function localTzOffsetMin(): number {
  return -new Date().getTimezoneOffset();
}

function wallClock(clip: ClipMeta, tzMin: number): number {
  return wrapDay(clip.clock!.epochSec + (clip.clock!.tzOffsetMin ?? tzMin) * 60);
}

interface Group {
  center: number;
  clipIds: Set<string>;
}

// Группирует расхождения «часы минус тайм-код»: у камеры в Free Run они почти одинаковые.
function clusterOffsets(items: { id: string; offset: number }[]): Group[] {
  const sorted = [...items].sort((a, b) => a.offset - b.offset);
  const groups: { ids: string[]; values: number[] }[] = [];
  for (const it of sorted) {
    const last = groups[groups.length - 1];
    if (last && it.offset - last.values[last.values.length - 1] <= CLUSTER_TOLERANCE) {
      last.ids.push(it.id);
      last.values.push(it.offset);
    } else {
      groups.push({ ids: [it.id], values: [it.offset] });
    }
  }
  return groups
    .map((g) => ({ center: estimateOffset(g.values), clipIds: new Set(g.ids) }))
    .sort((a, b) => b.clipIds.size - a.clipIds.size);
}

// Камеры пишут время начала с отброшенными долями секунды, поэтому каждое расхождение «часы − тайм-код»
// занижено на 0…1 с. Истинное значение лежит не ниже большинства значений и не выше меньшего из них + 1 с.
function estimateOffset(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const q = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))];
  const lo = q(0.9);
  const hi = q(0.1) + 1;
  return lo <= hi ? (lo + hi) / 2 : v[Math.floor(v.length / 2)] + 0.5;
}

// Тайм-код 23,976 и 59,94 без drop frame хранится как кадры с полуночи — это метка × 1,001.
// Когда тайм-код идёт по часам, клипу нужна сама метка, как у 25p и 29,97 DF той же камеры.
function labelSeconds(c: ClipMeta): number {
  const ndf = c.tc!.source !== 'bwf' && !c.tc!.drop && c.rate !== null && isNtscRate(rateValue(c.rate));
  return ndf ? c.tc!.seconds / 1.001 : c.tc!.seconds;
}

function isRecRun(clips: ClipMeta[]): boolean {
  const withTc = clips.filter((c) => c.tc && c.clock && !c.captureFps).sort((a, b) => a.clock!.epochSec - b.clock!.epochSec);
  if (withTc.length < 4) return false;
  let contiguous = 0;
  let realGaps = 0;
  for (let i = 1; i < withTc.length; i++) {
    const prev = withTc[i - 1];
    const cur = withTc[i];
    const tcGap = wrapSigned(cur.tc!.seconds - (prev.tc!.seconds + prev.durationSec));
    const clockGap = cur.clock!.epochSec - (prev.clock!.epochSec + prev.durationSec);
    if (clockGap > 3) {
      realGaps++;
      if (Math.abs(tcGap) < 1) contiguous++;
    }
  }
  return realGaps >= 3 && contiguous / realGaps > 0.7;
}

let issueSeq = 0;
function issue(partial: Omit<Issue, 'id'>): Issue {
  issueSeq += 1;
  return { id: `i${issueSeq}`, ...partial };
}

interface CameraOutcome {
  sync: CameraSync;
  placements: Placement[];
  issues: Issue[];
}

export function isSpeedChanged(c: ClipMeta): boolean {
  return c.captureFps !== null;
}

function activeClips(cam: Camera): ClipMeta[] {
  if (!cam.excludedClipIds.length) return cam.clips;
  const excluded = new Set(cam.excludedClipIds);
  return cam.clips.filter((c) => !excluded.has(c.id));
}

function syncCamera(cam: Camera, tzMin: number, corrections: Record<string, number>): CameraOutcome {
  const issues: Issue[] = [];
  const clips = activeClips(cam);
  const sync: CameraSync = {
    cameraId: cam.id,
    timeSource: null,
    timecodeVsClockSec: null,
    timecodeJumps: 0,
    recRun: false,
    start: null,
    end: null,
    lanes: 0,
  };
  if (clips.length === 0) return { sync, placements: [], issues };

  // Клипы с разных камер в одной папке — частая ошибка при сбросе карт.
  const models = new Map<string, number>();
  for (const c of clips) {
    const key = [c.camera.model, c.camera.serial].filter(Boolean).join(' · ');
    if (key) models.set(key, (models.get(key) ?? 0) + 1);
  }
  if (models.size > 1) {
    const list = [...models.entries()].map(([k, n]) => `${k} — ${n}`).join(', ');
    issues.push(issue({
      severity: 'warning',
      cameraId: cam.id,
      title: `На дорожке «${cam.name}» клипы с разных камер`,
      details: `${list}. Каждую камеру лучше положить на свою дорожку: у них разные часы.`,
      actions: [],
    }));
  }

  // S&Q — единственное, что программа считает ошибкой съёмки: длина такого клипа не совпадает
  // с реальным временем, и на мультикамерном монтаже он не стыкуется с другими камерами.
  const speed = clips.filter(isSpeedChanged);
  if (speed.length > 0) {
    const names = speed.slice(0, 6).map((c) => c.name).join(', ');
    issues.push(issue({
      severity: 'error',
      cameraId: cam.id,
      clipId: speed[0].id,
      title: `«${cam.name}»: ${speed.length} ${speed.length === 1 ? 'клип снят' : 'клипов сняты'} в режиме S&Q`,
      details: `${names}${speed.length > 6 ? '…' : ''}. Это замедленная или ускоренная съёмка: длина клипа не совпадает с реальным временем, по времени его не состыковать с другими камерами. Уберите такие клипы с таймлинии — файлы на диске останутся.`,
      actions: [
        { kind: 'exclude-clips', cameraId: cam.id, clipIds: speed.map((c) => c.id) },
        { kind: 'show-clip', clipId: speed[0].id },
      ],
    }));
  }

  const timed = clips.filter((c) => c.clock);
  // Замедленные и ускоренные клипы не участвуют в оценке тайм-кода: камеры ведут его в S&Q по-разному.
  const tcClips = timed.filter((c) => c.tc && !c.captureFps);
  const specialTc = timed.filter((c) => c.tc && c.captureFps);

  // Решаем, откуда брать время.
  let source: TimeSource = 'clock';
  const groupOf = new Map<string, Group>();
  let main: Group | null = null;
  if (cam.timecodeTrust !== 'ignore' && tcClips.length > 0) {
    const offsets = tcClips.map((c) => ({ id: c.id, offset: wrapSigned(wallClock(c, tzMin) - c.tc!.seconds) }));
    const groups = clusterOffsets(offsets);
    main = groups[0];
    sync.timecodeVsClockSec = main.center;
    sync.recRun = isRecRun(clips);
    const tooScattered = groups.length > Math.max(3, tcClips.length * 0.3);

    if (cam.timecodeTrust === 'absolute') {
      source = 'timecode';
    } else if (sync.recRun || (tooScattered && cam.timecodeTrust !== 'relative')) {
      source = 'clock';
    } else if (cam.timecodeTrust === 'auto' && Math.abs(main.center) <= ABSOLUTE_TC_TOLERANCE) {
      source = 'timecode';
    } else {
      source = 'timecode-and-clock';
    }
    for (const g of groups) for (const id of g.clipIds) groupOf.set(id, g);
    for (const c of specialTc) {
      const off = wrapSigned(wallClock(c, tzMin) - c.tc!.seconds);
      const g = groups.find((x) => Math.abs(off - x.center) <= CLUSTER_TOLERANCE);
      if (g) groupOf.set(c.id, g);
    }
    sync.timecodeJumps = source === 'timecode-and-clock' ? groups.length - 1 : 0;

    if (sync.recRun && cam.timecodeTrust !== 'absolute') {
      issues.push(issue({
        severity: 'warning',
        cameraId: cam.id,
        title: `«${cam.name}»: тайм-код шёл только во время записи (Rec Run)`,
        details: 'Паузы между клипами взяты по часам камеры, точность около секунды. Чтобы было точно до кадра, ставьте TC Run → Free Run.',
        actions: [{ kind: 'open-faq', anchor: 'tc-run' }],
      }));
    } else if (tooScattered && source === 'clock') {
      issues.push(issue({
        severity: 'warning',
        cameraId: cam.id,
        title: `«${cam.name}»: тайм-код не совпадает с часами камеры`,
        details: 'Тайм-код постоянно сбивался, поэтому клипы разложены по часам камеры (точность около секунды).',
        actions: [{ kind: 'open-faq', anchor: 'tc-run' }],
      }));
    }
    if (sync.timecodeJumps > 0) {
      issues.push(issue({
        severity: 'info',
        cameraId: cam.id,
        title: `«${cam.name}»: тайм-код сбивался ${sync.timecodeJumps} раз`,
        details: 'Так бывает после смены карты, обновления прошивки или ручной перестановки тайм-кода. Каждый отрезок выровнен по часам камеры отдельно.',
        actions: [{ kind: 'open-faq', anchor: 'tc-preset' }],
      }));
    }
  }
  sync.timeSource = source;

  // Раскладка.
  const raw: { clip: ClipMeta; start: number; method: Placement['method'] }[] = [];
  for (const c of clips) {
    if (!c.clock) continue;
    let start = c.clock.epochSec;
    let method: Placement['method'] = 'clock';
    const tcUsable = !c.captureFps || groupOf.has(c.id);
    if (c.tc && tcUsable && source === 'timecode') {
      // Камера снимала и 24p, и 30p/25p: клип 24p выпал из главной группы только из-за счёта тайм-кода.
      // Если по самой метке он сходится с часами, как вся камера, — ставим по метке, иначе уедет на минуту.
      let tcSec = c.tc.seconds;
      const label = labelSeconds(c);
      if (main && groupOf.get(c.id) !== main && Math.abs(wrapSigned(wallClock(c, tzMin) - label) - main.center) <= CLUSTER_TOLERANCE) tcSec = label;
      start = c.clock.epochSec + wrapSigned(tcSec - wallClock(c, tzMin));
      method = 'timecode';
    } else if (c.tc && source === 'timecode-and-clock') {
      const g = groupOf.get(c.id);
      if (g) {
        start = c.clock.epochSec + wrapSigned(c.tc.seconds - wallClock(c, tzMin)) + g.center;
        method = 'timecode-and-clock';
      }
    }
    raw.push({ clip: c, start: start + cam.manualShiftSec + (corrections[c.id] ?? 0), method });
  }

  const untimed = clips.filter((c) => !c.clock);
  if (untimed.length > 0) {
    issues.push(issue({
      severity: 'error',
      cameraId: cam.id,
      clipId: untimed[0].id,
      title: `«${cam.name}»: у ${untimed.length} клипов нет времени съёмки`,
      details: `${untimed.slice(0, 5).map((c) => c.name).join(', ')}${untimed.length > 5 ? '…' : ''}. Их не получится поставить на таймлинию.`,
      actions: [],
    }));
  }

  // Дорожки. Реальное время записи одной камеры не может пересекаться — это ошибка данных.
  // А вот замедленный клип в монтажке длиннее, чем шла запись, и может залезть на следующий:
  // такой клип просто уходит на соседнюю дорожку камеры, без предупреждений.
  raw.sort((a, b) => a.start - b.start);
  const laneEnds: number[] = [];
  let lastRecordedEnd = -Infinity;
  let lastRecordedClip: ClipMeta | null = null;
  const placements: Placement[] = [];
  for (const r of raw) {
    let start = r.start;
    const realOverlap = lastRecordedEnd - start;
    if (realOverlap > 0.02) {
      if (r.method !== 'timecode' && realOverlap <= NUDGE_LIMIT) {
        start = lastRecordedEnd; // погрешность часов — ставим вплотную
      } else {
        issues.push(issue({
          severity: 'error',
          cameraId: cam.id,
          clipId: r.clip.id,
          title: `«${cam.name}»: ${lastRecordedClip ? `${lastRecordedClip.name} и ` : ''}${r.clip.name} накладываются на ${formatDurationHuman(realOverlap)}`,
          details: 'Одна камера не может снимать два клипа одновременно. Похоже, в папке файлы с другой камеры или часы камеры переставляли во время съёмки.',
          actions: [{ kind: 'show-clip', clipId: r.clip.id }],
        }));
      }
    }
    let lane = laneEnds.findIndex((e) => e <= start + 0.02);
    if (lane === -1) lane = laneEnds.length;
    const end = start + r.clip.durationSec;
    laneEnds[lane] = end;
    if (start + r.clip.recordedSec > lastRecordedEnd) {
      lastRecordedEnd = start + r.clip.recordedSec;
      lastRecordedClip = r.clip;
    }
    placements.push({ clipId: r.clip.id, cameraId: cam.id, start, end, method: r.method, lane });
  }
  sync.lanes = laneEnds.length;
  if (placements.length > 0) {
    sync.start = Math.min(...placements.map((p) => p.start));
    sync.end = Math.max(...placements.map((p) => p.end));
  }

  const fileTimed = clips.filter((c) => c.clock?.source === 'file').length;
  if (fileTimed > 0) {
    issues.push(issue({
      severity: 'warning',
      cameraId: cam.id,
      title: `«${cam.name}»: время ${fileTimed} клипов взято из даты файла`,
      details: 'Камера не записала время съёмки внутрь файла. Дата файла верна, только если карту копировали целиком, без пересохранения.',
      actions: [],
    }));
  }

  return { sync, placements, issues };
}

function overlapSec(a: CameraSync, b: CameraSync): number {
  if (a.start === null || a.end === null || b.start === null || b.end === null) return 0;
  return Math.min(a.end, b.end) - Math.max(a.start, b.start);
}

export function pickDisplayTz(cameras: Camera[]): number {
  for (const cam of cameras) for (const c of cam.clips) if (c.clock?.tzOffsetMin != null) return c.clock.tzOffsetMin;
  return localTzOffsetMin();
}

// corrections — поправки по звуку для отдельных клипов (секунды), см. audioSync.ts.
// heardCameras — камеры, которые уже сверены по звуку: подсказка сверить их по хлопку им не нужна.
export function runSync(cameras: Camera[], corrections: Record<string, number> = {}, heardCameras: Set<string> = new Set()): SyncResult {
  const tz = pickDisplayTz(cameras);
  const outcomes = cameras.map((c) => syncCamera(c, tz, corrections));
  const placements = outcomes.flatMap((o) => o.placements);
  const issues = outcomes.flatMap((o) => o.issues);
  const syncs = outcomes.map((o) => o.sync);

  // Проверка камер между собой: часовой пояс, другой день, нет пересечения.
  const withRange = syncs.filter((s) => s.start !== null);
  if (withRange.length > 1) {
    const ref = [...withRange].sort((a, b) => {
      const aAbs = a.timeSource === 'timecode' ? 1 : 0;
      const bAbs = b.timeSource === 'timecode' ? 1 : 0;
      if (aAbs !== bAbs) return bAbs - aAbs;
      return (b.end! - b.start!) - (a.end! - a.start!);
    })[0];
    const refCam = cameras.find((c) => c.id === ref.cameraId)!;
    for (const s of withRange) {
      if (s === ref) continue;
      const cam = cameras.find((c) => c.id === s.cameraId)!;
      if (overlapSec(s, ref) > 0) continue;
      const delta = (s.start! + s.end!) / 2 - (ref.start! + ref.end!) / 2;
      const hours = Math.round(delta / 3600);
      const days = Math.round(delta / DAY);
      if (Math.abs(days) >= 1 && Math.abs(delta - days * DAY) < 6 * 3600) {
        issues.push(issue({
          severity: 'warning',
          cameraId: cam.id,
          title: `«${cam.name}» снимала в другой день, чем «${refCam.name}»`,
          details: `Разница около ${formatDurationHuman(Math.abs(delta))}. Скорее всего, на камере неверная дата.`,
          actions: [{ kind: 'shift-camera', cameraId: cam.id, seconds: -days * DAY }],
        }));
      } else if (Math.abs(hours) >= 1 && Math.abs(delta - hours * 3600) < 40 * 60) {
        issues.push(issue({
          severity: 'warning',
          cameraId: cam.id,
          title: `Часы «${cam.name}» расходятся с «${refCam.name}» примерно на ${Math.abs(hours)} ч`,
          details: 'Похоже на другой часовой пояс или летнее время на камере. Сдвиньте камеру на целые часы, а точно подгоните по хлопку.',
          actions: [{ kind: 'shift-camera', cameraId: cam.id, seconds: -hours * 3600 }],
        }));
      } else {
        issues.push(issue({
          severity: 'info',
          cameraId: cam.id,
          title: `«${cam.name}» не пересекается по времени с «${refCam.name}»`,
          details: `Между ними ${formatDurationHuman(Math.abs(delta))}. Если камеры снимали одновременно, проверьте часы на «${cam.name}».`,
          actions: [],
        }));
      }
    }

    const reference = withRange.filter((s) => s.timeSource === 'timecode');
    for (const s of withRange) {
      if (s.timeSource === 'timecode' || reference.length === 0 || heardCameras.has(s.cameraId)) continue;
      const cam = cameras.find((c) => c.id === s.cameraId)!;
      issues.push(issue({
        severity: 'info',
        cameraId: cam.id,
        title: `«${cam.name}» выровнена по своим часам`,
        details: `Точный тайм-код есть у камер: ${reference.map((r) => cameras.find((c) => c.id === r.cameraId)!.name).join(', ')}. Часы «${cam.name}» могут расходиться с ними на секунды — проверьте по хлопку и при необходимости сдвиньте камеру${cam.manualShiftSec ? ` (сейчас сдвиг ${formatShift(cam.manualShiftSec)})` : ''}.`,
        actions: [{ kind: 'open-faq', anchor: 'manual-sync' }],
      }));
    }
  }

  const start = placements.length ? Math.min(...placements.map((p) => p.start)) : 0;
  const end = placements.length ? Math.max(...placements.map((p) => p.end)) : 0;
  return { placements, cameras: syncs, issues, start, end, displayTzOffsetMin: tz };
}

// Раскладка до синхронизации — «кучкой»: клипы каждой камеры лежат подряд, по порядку съёмки,
// и все камеры начинаются с нуля. Часы камер могут быть сбиты на часы и сутки — так клипы не разлетаются,
// и контрольные кадры удобно отмечать. Настоящие места клипы получают по кнопке «Синхронизировать».
export function pilePlacements(cameras: Camera[]): Placement[] {
  const piles = cameras.map((cam) => {
    // Порядок съёмки — по часам камеры; клипы без часов — в конце, по имени файла.
    const clips = activeClips(cam).map((c, i) => ({ c, i }));
    clips.sort((a, b) => (a.c.clock?.epochSec ?? Infinity) - (b.c.clock?.epochSec ?? Infinity) || a.i - b.i);
    return { cam, clips: clips.map((x) => x.c) };
  });
  // Зазор между клипами — заметный при любом масштабе: около 1/300 самой длинной кучки, не меньше секунды.
  const longest = Math.max(0, ...piles.map((p) => p.clips.reduce((sum, c) => sum + c.durationSec, 0)));
  const gap = Math.max(1, longest / 300);
  const out: Placement[] = [];
  for (const { cam, clips } of piles) {
    let t = 0;
    for (const c of clips) {
      out.push({ clipId: c.id, cameraId: cam.id, start: t, end: t + c.durationSec, method: 'clock', lane: 0 });
      t += c.durationSec + gap;
    }
  }
  return out;
}
