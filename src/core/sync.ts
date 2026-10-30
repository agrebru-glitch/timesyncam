// Синхронизация: раскладывает клипы всех камер по реальному времени съёмки.
import type { Camera, CameraSync, ClipMeta, Issue, Placement, SyncResult, TimeSource } from './types.ts';
import { DAY, isNtscRate, rateValue, wrapDay, wrapSigned } from './timecode.ts';
import { formatDurationHuman, formatShift, pluralRu } from './format.ts';

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
  // Время клипа по часам и тайм-коду этой камеры (без ручного сдвига и поправок) — для её клипов на чужих дорожках.
  place: (c: ClipMeta) => { start: number; method: Placement['method'] } | null;
}

// Клип с другой камеры на этой дорожке: время уже посчитано по его камере.
interface Guest {
  clip: ClipMeta;
  start: number;
  method: Placement['method'];
  ownerId: string;
}

export function isSpeedChanged(c: ClipMeta): boolean {
  return c.captureFps !== null;
}

function activeClips(cam: Camera, copies?: Map<string, Duplicate>): ClipMeta[] {
  if (!cam.excludedClipIds.length && !copies?.size) return cam.clips;
  const excluded = new Set(cam.excludedClipIds);
  return cam.clips.filter((c) => !excluded.has(c.id) && !copies?.has(copyKey(cam.id, c.id)));
}

export interface Duplicate {
  cameraId: string;
  clipId: string;
  keptCameraId: string; // где лежит копия, которая берётся в синхронизацию
  keptClipId: string;
}

const copyKey = (cameraId: string, clipId: string) => `${cameraId}|${clipId}`;

// Тот же ли это файл. Одинаковое имя ничего не значит: две камеры одной модели обе пишут C0003.MP4.
// Копия совпадает с оригиналом до байта по размеру; сверху — всё, что известно у обоих файлов: длина, частота,
// кадр, кодек, тайм-код начала (он записан в самом MP4, есть и у копии без XML), серийный номер камеры.
// Длина и число кадров — с допуском в кадр: у файла с XML их берём из XML, у копии без него — из самого MP4.
function sameFile(a: ClipMeta, b: ClipMeta): boolean {
  const known = <T>(x: T | null | undefined, y: T | null | undefined, eq: (x: T, y: T) => boolean) => x == null || y == null || eq(x, y);
  const frameSec = a.rate ? 1 / rateValue(a.rate) : 0.04;
  return (
    Math.abs(a.durationSec - b.durationSec) <= frameSec * 1.5 + 0.01 &&
    known(a.rate, b.rate, (x, y) => x.num * y.den === y.num * x.den) &&
    known(a.frames, b.frames, (x, y) => Math.abs(x - y) <= 1) &&
    known(a.width, b.width, (x, y) => x === y) &&
    known(a.height, b.height, (x, y) => x === y) &&
    known(a.codec, b.codec, (x, y) => x === y) &&
    a.audioChannels === b.audioChannels &&
    known(a.tc, b.tc, (x, y) => Math.abs(wrapSigned(x.seconds - y.seconds)) < 1.5 / Math.max(1, x.countRate)) &&
    known(a.camera.serial, b.camera.serial, (x, y) => x === y)
  );
}

// Копии одного файла — на разных дорожках или в двух папках одной.
// Копия без XML на чужой дорожке приносит чужие часы и тайм-код: камера получает лишний отрезок, сверка по звуку
// цепляется за копию, а настоящие клипы камеры остаются на месте своих часов. Поэтому в синхронизацию берётся
// одна копия — с Sony XML, а при равенстве — с более ранней дорожки. Ключ — «камера|клип».
export function findDuplicates(cameras: Camera[]): Map<string, Duplicate> {
  const groups = new Map<string, { clip: ClipMeta; cameraId: string; order: number }[]>();
  cameras.forEach((cam, ci) => {
    const excluded = new Set(cam.excludedClipIds);
    cam.clips.forEach((clip, i) => {
      if (excluded.has(clip.id) || !clip.sizeBytes) return;
      const key = `${clip.name.toUpperCase()}|${clip.sizeBytes}`;
      groups.set(key, [...(groups.get(key) ?? []), { clip, cameraId: cam.id, order: ci * 1e6 + i }]);
    });
  });
  const score = (c: ClipMeta) => (c.clock?.source === 'sony-xml' ? 2 : 0) + (c.tc?.source === 'sony-xml' ? 1 : 0);
  const out = new Map<string, Duplicate>();
  for (const all of groups.values()) {
    // Одинаковые имя и размер ещё делятся на разные записи, если у них расходится что-то из sameFile.
    let rest = all;
    while (rest.length > 1) {
      const list = rest.filter((x) => sameFile(x.clip, rest[0].clip));
      rest = rest.filter((x) => !list.includes(x));
      if (list.length < 2) continue;
      const keep = list.reduce((a, b) => (score(b.clip) > score(a.clip) || (score(b.clip) === score(a.clip) && b.order < a.order) ? b : a));
      for (const x of list) {
        if (x === keep) continue;
        out.set(copyKey(x.cameraId, x.clip.id), { cameraId: x.cameraId, clipId: x.clip.id, keptCameraId: keep.cameraId, keptClipId: keep.clip.id });
      }
    }
  }
  return out;
}

function syncCamera(
  cam: Camera,
  tzMin: number,
  corrections: Record<string, number>,
  copies: Map<string, Duplicate>,
  strays: Map<string, Stray>,
  guests: Guest[],
): CameraOutcome {
  const issues: Issue[] = [];
  const clips = activeClips(cam, copies).filter((c) => !strays.has(copyKey(cam.id, c.id)));
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
  if (clips.length === 0 && guests.length === 0) return { sync, placements: [], issues, place: () => null };

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
  let groups: Group[] = [];
  let main: Group | null = null;
  if (cam.timecodeTrust !== 'ignore' && tcClips.length > 0) {
    const offsets = tcClips.map((c) => ({ id: c.id, offset: wrapSigned(wallClock(c, tzMin) - c.tc!.seconds) }));
    groups = clusterOffsets(offsets);
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

  // Раскладка. Группа клипа — его отрезок тайм-кода; клип с другой дорожки (снятый этой камерой) ищет свою по расхождению.
  const groupFor = (c: ClipMeta): Group | undefined => {
    const known = groupOf.get(c.id);
    if (known || !c.tc || !c.clock || !groups.length) return known;
    const off = wrapSigned(wallClock(c, tzMin) - c.tc.seconds);
    return groups.find((x) => Math.abs(off - x.center) <= CLUSTER_TOLERANCE);
  };
  const place = (c: ClipMeta): { start: number; method: Placement['method'] } | null => {
    if (!c.clock) return null;
    let start = c.clock.epochSec;
    let method: Placement['method'] = 'clock';
    const g = groupFor(c);
    const tcUsable = !c.captureFps || !!g;
    if (c.tc && tcUsable && source === 'timecode') {
      // Камера снимала и 24p, и 30p/25p: клип 24p выпал из главной группы только из-за счёта тайм-кода.
      // Если по самой метке он сходится с часами, как вся камера, — ставим по метке, иначе уедет на минуту.
      let tcSec = c.tc.seconds;
      const label = labelSeconds(c);
      if (main && g !== main && Math.abs(wrapSigned(wallClock(c, tzMin) - label) - main.center) <= CLUSTER_TOLERANCE) tcSec = label;
      start = c.clock.epochSec + wrapSigned(tcSec - wallClock(c, tzMin));
      method = 'timecode';
    } else if (c.tc && source === 'timecode-and-clock' && g) {
      start = c.clock.epochSec + wrapSigned(c.tc.seconds - wallClock(c, tzMin)) + g.center;
      method = 'timecode-and-clock';
    }
    return { start, method };
  };
  const raw: { clip: ClipMeta; start: number; method: Placement['method']; ownerId?: string }[] = [];
  for (const c of clips) {
    const at = place(c);
    if (at) raw.push({ clip: c, start: at.start + cam.manualShiftSec + (corrections[c.id] ?? 0), method: at.method });
  }
  for (const gst of guests) raw.push({ clip: gst.clip, start: gst.start, method: gst.method, ownerId: gst.ownerId });

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
    // Клип другой камеры на этой дорожке снят одновременно с её клипами — это не ошибка, он просто уходит на соседнюю дорожку.
    const guest = r.ownerId !== undefined;
    const realOverlap = guest ? 0 : lastRecordedEnd - start;
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
    if (!guest && start + r.clip.recordedSec > lastRecordedEnd) {
      lastRecordedEnd = start + r.clip.recordedSec;
      lastRecordedClip = r.clip;
    }
    placements.push({ clipId: r.clip.id, cameraId: cam.id, start, end, method: r.method, lane, ...(guest ? { timeCameraId: r.ownerId } : {}) });
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

  return { sync, placements, issues, place };
}

export interface Stray {
  cameraId: string; // дорожка, на которой лежит файл
  clipId: string;
  ownerId: string; // дорожка камеры, которая его сняла
  identity: string; // модель и серийный номер
}

const identityOf = (c: ClipMeta) => [c.camera.model, c.camera.serial].filter(Boolean).join(' · ');

// Чужой клип: снят другой камерой, чем остальные клипы дорожки, — той, что лежит на другой дорожке
// (модель и серийный номер из метаданных). Так бывает, когда файл при сбросе попал не в ту папку.
// Программа переносит такой клип на дорожку его камеры до синхронизации (planRelocation). Если он всё же остался
// на чужой дорожке, время ему задаёт его камера: её часы, тайм-код и поправка по звуку.
export function findStrays(cameras: Camera[], copies: Map<string, Duplicate>): Map<string, Stray> {
  const majorityOf = new Map<string, { key: string; count: number; camera: ClipMeta['camera'] }>();
  for (const cam of cameras) {
    const counts = new Map<string, { count: number; camera: ClipMeta['camera'] }>();
    for (const c of activeClips(cam, copies)) {
      const key = identityOf(c);
      if (key) counts.set(key, { count: (counts.get(key)?.count ?? 0) + 1, camera: c.camera });
    }
    const top = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
    // Большинство должно быть явным: при равенстве не угадываем.
    if (top.length && (top.length === 1 || top[0][1].count > top[1][1].count)) majorityOf.set(cam.id, { key: top[0][0], ...top[0][1] });
  }
  const out = new Map<string, Stray>();
  for (const cam of cameras) {
    const own = majorityOf.get(cam.id);
    if (!own) continue;
    for (const c of activeClips(cam, copies)) {
      const key = identityOf(c);
      if (!key || key === own.key) continue;
      // Та же модель, а серийного номера нет у одной из сторон (потерялся XML) — может быть и своя камера: не трогаем.
      if (c.camera.model === own.camera.model && (!c.camera.serial || !own.camera.serial)) continue;
      const owners = cameras.filter((x) => x.id !== cam.id && majorityOf.get(x.id)?.key === key);
      if (owners.length === 1) out.set(copyKey(cam.id, c.id), { cameraId: cam.id, clipId: c.id, ownerId: owners[0].id, identity: key });
    }
  }
  return out;
}

function strayIssues(cameras: Camera[], strays: Map<string, Stray>): Issue[] {
  const out: Issue[] = [];
  const byPair = new Map<string, Stray[]>();
  for (const st of strays.values()) byPair.set(`${st.cameraId}|${st.ownerId}`, [...(byPair.get(`${st.cameraId}|${st.ownerId}`) ?? []), st]);
  for (const list of byPair.values()) {
    const cam = cameras.find((c) => c.id === list[0].cameraId)!;
    const owner = cameras.find((c) => c.id === list[0].ownerId)!;
    const names = list.slice(0, 4).map((st) => cam.clips.find((c) => c.id === st.clipId)!.name).join(', ') + (list.length > 4 ? '…' : '');
    out.push(issue({
      severity: 'warning',
      cameraId: cam.id,
      clipId: list[0].clipId,
      title: `«${cam.name}»: ${names} ${list.length === 1 ? 'снят' : 'сняты'} камерой «${owner.name}» (${list[0].identity})`,
      details: `Файл лежит в папке «${cam.name}», но снят той же камерой, что клипы «${owner.name}». Он стоит на этой дорожке, а время ему задают часы, тайм-код и сверка по звуку «${owner.name}». Перенесите файл в её папку, чтобы в монтажке он был на её дорожке.`,
      actions: [{ kind: 'show-clip', clipId: list[0].clipId }],
    }));
  }
  return out;
}

export interface Relocation {
  moves: Stray[]; // клипы другой камеры — на дорожку их камеры
  drops: Duplicate[]; // копии файла, который уже лежит на другой дорожке или в другой папке той же камеры
}

// Распределение клипов по дорожкам камер — перед синхронизацией. Клип, снятый камерой другой дорожки, переезжает
// на её дорожку; копия файла, который уже есть на другой дорожке, уходит туда же — то есть на таймлинии остаётся
// один экземпляр. Файлы на диске не трогаются.
export function planRelocation(cameras: Camera[]): Relocation {
  const copies = findDuplicates(cameras);
  const moves = [...findStrays(cameras, copies).values()];
  const drops = [...copies.values()];
  // Файл уже перенесли, а папку добавили ещё раз: он снова в своей папке и уже на дорожке своей камеры.
  // Убираем вернувшийся экземпляр, а не переносим его заново на место того, что уже стоит.
  for (const m of [...moves]) {
    const back = drops.find((d) => d.cameraId === m.ownerId && d.keptCameraId === m.cameraId && d.keptClipId === m.clipId);
    if (!back) continue;
    moves.splice(moves.indexOf(m), 1);
    drops.splice(drops.indexOf(back), 1, { cameraId: m.cameraId, clipId: m.clipId, keptCameraId: back.cameraId, keptClipId: back.clipId });
  }
  return { moves, drops };
}

export function applyRelocation(cameras: Camera[], plan: Relocation): Camera[] {
  if (!plan.moves.length && !plan.drops.length) return cameras;
  const drop = new Set(plan.drops.map((d) => copyKey(d.cameraId, d.clipId)));
  const moveTo = new Map(plan.moves.map((m) => [copyKey(m.cameraId, m.clipId), m.ownerId]));
  const incoming = new Map<string, ClipMeta[]>();
  const kept = cameras.map((cam) => ({
    ...cam,
    clips: cam.clips.filter((c) => {
      const key = copyKey(cam.id, c.id);
      const to = moveTo.get(key);
      if (to) incoming.set(to, [...(incoming.get(to) ?? []), c]);
      return !drop.has(key) && !to;
    }),
  }));
  return kept.map((cam) => {
    const add = (incoming.get(cam.id) ?? []).filter((c) => !cam.clips.some((x) => x.path === c.path));
    // Свои клипы дорожки остаются в прежнем порядке, перенесённые — в конце.
    return add.length ? { ...cam, clips: [...cam.clips, ...add] } : cam;
  });
}

// Отметки контрольного кадра едут вместе с клипом; отметка на убранной копии переходит на оставшийся экземпляр того же файла.
export function relocateFrames<T extends { cameraId: string; clipId: string }>(frames: Record<string, T>, plan: Relocation): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, f] of Object.entries(frames)) {
    const move = plan.moves.find((m) => m.cameraId === f.cameraId && m.clipId === f.clipId);
    const drop = plan.drops.find((d) => d.cameraId === f.cameraId && d.clipId === f.clipId);
    if (move) out[key] = { ...f, cameraId: move.ownerId };
    else if (drop) {
      // Своя отметка у оставшегося экземпляра важнее.
      if (!frames[drop.keptClipId] || drop.keptClipId === f.clipId) out[drop.keptClipId] = { ...f, cameraId: drop.keptCameraId, clipId: drop.keptClipId };
    }
    else out[key] = f;
  }
  return out;
}

// Что и куда перенесено — одно сообщение на пару дорожек.
export function relocationIssues(cameras: Camera[], plan: Relocation): Issue[] {
  const nameOf = (id: string) => cameras.find((c) => c.id === id)?.name ?? '';
  const clipName = (camId: string, clipId: string) => cameras.find((c) => c.id === camId)?.clips.find((c) => c.id === clipId)?.name ?? '';
  const list = (names: string[]) => names.slice(0, 4).join(', ') + (names.length > 4 ? '…' : '');
  const out: Issue[] = [];
  const moves = new Map<string, Stray[]>();
  for (const m of plan.moves) moves.set(`${m.cameraId}|${m.ownerId}`, [...(moves.get(`${m.cameraId}|${m.ownerId}`) ?? []), m]);
  for (const group of moves.values()) {
    const { cameraId: from, ownerId: to, identity } = group[0];
    const one = group.length === 1;
    out.push(issue({
      severity: 'info',
      cameraId: to,
      clipId: group[0].clipId,
      title: `${one ? 'Перенесён' : 'Перенесены'} на дорожку «${nameOf(to)}»: ${list(group.map((m) => clipName(from, m.clipId)))}`,
      details: `${one ? 'Файл лежал' : 'Файлы лежали'} в папке «${nameOf(from)}», но ${one ? 'снят' : 'сняты'} той же камерой, что «${nameOf(to)}» (${identity}). Программа поставила ${one ? 'его' : 'их'} на её дорожку — по её часам, тайм-коду и звуку. Файлы на диске не трогались.`,
      actions: [{ kind: 'show-clip', clipId: group[0].clipId }],
    }));
  }
  const drops = new Map<string, Duplicate[]>();
  for (const d of plan.drops) drops.set(`${d.cameraId}|${d.keptCameraId}`, [...(drops.get(`${d.cameraId}|${d.keptCameraId}`) ?? []), d]);
  for (const group of drops.values()) {
    const { cameraId: from, keptCameraId: kept } = group[0];
    const names = list(group.map((d) => clipName(from, d.clipId)));
    out.push(issue({
      severity: 'info',
      cameraId: from,
      title: from === kept
        ? `«${nameOf(from)}»: ${names} — одна и та же запись лежала в двух папках`
        : `«${nameOf(from)}»: ${names} — копия клипа с дорожки «${nameOf(kept)}»`,
      details: from === kept
        ? 'На таймлинии оставлена одна копия. Файлы на диске остались.'
        : `Такой же файл уже есть на дорожке «${nameOf(kept)}», там он и стоит — второй экземпляр с дорожки «${nameOf(from)}» убран. Файл на диске остался.`,
      actions: [],
    }));
  }
  return out;
}

// Одно замечание на пару «камера — дорожка, где лежит оригинал».
function duplicateIssues(cameras: Camera[], copies: Map<string, Duplicate>): Issue[] {
  const out: Issue[] = [];
  const nameOf = (id: string) => cameras.find((c) => c.id === id)?.name ?? '';
  const byPair = new Map<string, Duplicate[]>();
  for (const d of copies.values()) byPair.set(`${d.cameraId}|${d.keptCameraId}`, [...(byPair.get(`${d.cameraId}|${d.keptCameraId}`) ?? []), d]);
  for (const list of byPair.values()) {
    const cam = cameras.find((c) => c.id === list[0].cameraId)!;
    const names = list.slice(0, 4).map((d) => cam.clips.find((c) => c.id === d.clipId)!.name).join(', ') + (list.length > 4 ? '…' : '');
    const same = list[0].keptCameraId === cam.id;
    out.push(issue({
      severity: 'warning',
      cameraId: cam.id,
      title: same
        ? `«${cam.name}»: ${names} — одна и та же запись лежит в двух папках`
        : `«${cam.name}»: ${names} — ${list.length === 1 ? 'копия клипа' : `${pluralRu(list.length, 'копия', 'копии', 'копий')} клипов`} с дорожки «${nameOf(list[0].keptCameraId)}»`,
      details: same
        ? 'В синхронизацию берётся одна копия. Уберите лишнюю с таймлинии — файлы на диске останутся.'
        : `Такой же файл лежит на дорожке «${nameOf(list[0].keptCameraId)}». Копия не берётся в синхронизацию: в ней часы и тайм-код другой камеры, и она сбивает сверку. Похоже, файл попал не в ту папку — уберите его с таймлинии, файл на диске останется.`,
      actions: [{ kind: 'exclude-clips', cameraId: cam.id, clipIds: list.map((d) => d.clipId) }],
    }));
  }
  return out;
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
  const copies = findDuplicates(cameras);
  const strays = findStrays(cameras, copies);
  // Сначала каждая камера — по своим клипам. Потом дорожки с чужими клипами раскладываются ещё раз:
  // время такого клипа считает его камера, со своим ручным сдвигом и поправками.
  let outcomes = cameras.map((c) => syncCamera(c, tz, corrections, copies, strays, []));
  if (strays.size) {
    const guestsOf = new Map<string, Guest[]>();
    for (const st of strays.values()) {
      const owner = cameras.findIndex((c) => c.id === st.ownerId);
      const clip = cameras.find((c) => c.id === st.cameraId)!.clips.find((c) => c.id === st.clipId)!;
      const at = outcomes[owner].place(clip);
      if (!at) continue;
      const start = at.start + cameras[owner].manualShiftSec + (corrections[clip.id] ?? 0);
      guestsOf.set(st.cameraId, [...(guestsOf.get(st.cameraId) ?? []), { clip, start, method: at.method, ownerId: st.ownerId }]);
    }
    outcomes = cameras.map((c, i) => (guestsOf.has(c.id) ? syncCamera(c, tz, corrections, copies, strays, guestsOf.get(c.id)!) : outcomes[i]));
  }
  const placements = outcomes.flatMap((o) => o.placements);
  const issues = [...duplicateIssues(cameras, copies), ...strayIssues(cameras, strays), ...outcomes.flatMap((o) => o.issues)];
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
  const copies = findDuplicates(cameras);
  const piles = cameras.map((cam) => {
    // Порядок съёмки — по часам камеры; клипы без часов — в конце, по имени файла. Копии клипов не показываем.
    const clips = activeClips(cam, copies).map((c, i) => ({ c, i }));
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
