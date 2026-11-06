// Стресс-проверка по расширенному отчёту тестера: тот же звук и те же сведения о файлах, но файлы переименованы,
// даты сбиты, дорожки и клипы добавлены в другом порядке. Каждый вариант проходит путь программы целиком —
// сведения о клипе из ffprobe и Sony XML, перенос клипов по дорожкам, раскладка по времени, сверка по звуку —
// и сравнивается с раскладкой без изменений.
//   node scripts/stress-report.mts <распакованный архив> [вариант…]
// STRESS_LOG=1 — ещё и журнал сверки с раскладкой по часам.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
// Местное время — как у тестера: от него зависят время из имён файлов и даты BWF.
const tz = report.app?.tzOffsetMin ?? 0;
if (tz % 60 === 0) process.env.TZ = tz === 0 ? 'UTC' : `Etc/GMT${tz > 0 ? '-' : '+'}${Math.abs(tz) / 60}`;

const { buildClipMeta, timeOfDayFromFilename } = await import('../src/core/clipMeta.ts');
const { parseSonyXml } = await import('../src/core/sonyXml.ts');
const { applyRelocation, planRelocation, runSync } = await import('../src/core/sync.ts');
const { alignByAudio } = await import('../src/core/align.ts');
const { AUDIO_SEARCH_SEC, heardCameras } = await import('../src/core/audioSync.ts');
const { audioFeatures, audioSamples, audioWholeFeatures } = await import('../src/main/audio.ts');
// Звук клипа в отчёте — Opus, вынутый из файла: его время начинается с первого сэмпла звука.
const reportTiming = (c: { audioStartSec?: number }) => ({ start: c.audioStartSec ?? 0, copy: true });
type Camera = import('../src/core/types.ts').Camera;
type FfprobeResult = import('../src/core/clipMeta.ts').FfprobeResult;

interface FileSpec { key: string; name: string; probe: FfprobeResult; xml: string | null; mtimeMs: number; audio: string; size: number }
interface Device { name: string; role: 'camera' | 'recorder' | 'lav' | 'other'; files: FileSpec[]; keepOrder?: boolean }

const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').trim() || 'без имени';
const source: Device[] = report.cameras.map((c: any): Device => {
  const files = c.clips.map((k: any): FileSpec => {
    const base = join(dir, safe(c.name));
    const xml = join(base, `${k.file.replace(/\.[^.]+$/, '')}M01.XML`);
    // XML Sony изнутри MP4 — в отчёте, если рядом с клипом его не было. Варианты «потерян XML» убирают и его.
    const nrt = join(base, `${k.file}.nrtm.xml`);
    return {
      key: `${c.name}/${k.file}`,
      name: k.file,
      probe: JSON.parse(readFileSync(join(base, `${k.file}.ffprobe.json`), 'utf8')),
      xml: existsSync(xml) ? readFileSync(xml, 'utf8') : existsSync(nrt) ? readFileSync(nrt, 'utf8') : null,
      // Даты файла в отчёте нет. Для записей, где день брался из неё, ставим конец записи — так и было у тестера.
      mtimeMs: k.clock ? (k.clock.epochSec + k.recordedSec) * 1000 : 0,
      audio: join(base, `${k.file}.opus`),
      size: k.sizeBytes,
    };
  });
  const video = c.clips.some((k: any) => k.hasVideo);
  const role = video ? 'camera' : files.every((f: FileSpec) => f.probe.format?.tags?.time_reference) ? 'recorder'
    : files.every((f: FileSpec) => timeOfDayFromFilename(f.name) !== null) ? 'lav' : 'other';
  return { name: c.name, role, files };
});

// --- правки

const pad = (n: number) => String(n).padStart(4, '0');
const ext = (name: string) => /\.[^.]+$/.exec(name)?.[0] ?? '';
const two = (n: number) => String(n).padStart(2, '0');
const localDate = (sec: number) => { const d = new Date(sec * 1000); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };
const localTime = (sec: number) => { const d = new Date(sec * 1000); return `${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`; };

function shiftIso(v: string, sec: number): string {
  const suffix = /([+-]\d{2}:\d{2}|Z)$/.exec(v)?.[1] ?? '';
  const off = suffix && suffix !== 'Z' ? (suffix[0] === '-' ? -1 : 1) * (Number(suffix.slice(1, 3)) * 60 + Number(suffix.slice(4, 6))) : 0;
  const ms = Date.parse(v.replace(/(\.\d{3})\d+/, '$1')) + sec * 1000;
  const t = new Date(ms + off * 60000).toISOString();
  return suffix === 'Z' ? t.replace('.000Z', v.includes('.') ? '.000000Z' : 'Z') : t.slice(0, 19) + suffix;
}

function eachTags(p: FfprobeResult, fn: (tags: Record<string, string>) => void): void {
  if (p.format?.tags) fn(p.format.tags);
  for (const s of p.streams ?? []) if (s.tags) fn(s.tags);
}

// Сдвиг часов устройства: XML Sony, даты контейнера, BWF и дата файла сдвигаются вместе.
function shiftClock(d: Device, sec: number): void {
  for (const f of d.files) {
    if (f.xml) f.xml = f.xml.replace(/(<CreationDate value=")([^"]+)/, (_, a, v) => a + shiftIso(v, sec)).replace(/(lastUpdate=")([^"]+)/, (_, a, v) => a + shiftIso(v, sec));
    eachTags(f.probe, (t) => {
      if (/^\d{4}-\d{2}-\d{2}T/.test(t.creation_time ?? '')) t.creation_time = shiftIso(t.creation_time, sec);
    });
    const t = f.probe.format?.tags;
    if (t?.date && /^\d{2}:\d{2}:\d{2}$/.test(t.creation_time ?? '')) {
      const [y, mo, dd] = t.date.split('-').map(Number);
      const [h, mi, s] = t.creation_time.split(':').map(Number);
      const at = new Date(y, mo - 1, dd, h, mi, s).getTime() / 1000 + sec;
      t.date = localDate(at);
      t.creation_time = localTime(at).replace(/-/g, ':');
    }
    if (f.mtimeMs) f.mtimeMs += sec * 1000;
  }
}

// Даты в метаданных стёрты. Дата файла остаётся — без неё файлов не бывает: copiedAt — время копирования.
function dropClock(d: Device, copiedAt?: Date): void {
  d.files.forEach((f, i) => {
    if (f.xml) f.xml = f.xml.replace(/<CreationDate value="[^"]+"\/>/, '');
    eachTags(f.probe, (t) => {
      delete t.creation_time;
      delete t.date;
    });
    if (copiedAt) f.mtimeMs = copiedAt.getTime() + i * 2000;
  });
}

function rand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(list: T[], r: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const of = (ds: Device[], role: Device['role']) => ds.filter((d) => d.role === role);
const cams = (ds: Device[]) => of(ds, 'camera');
// День съёмки — по часам большинства камер.
const sessionDay = (() => {
  const days = report.cameras.flatMap((c: any) => c.clips.filter((k: any) => k.hasVideo && k.clock).map((k: any) => localDate(k.clock.epochSec)));
  const count = new Map<string, number>();
  for (const d of days) count.set(d, (count.get(d) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '2026-01-01';
})();

interface Variant { id: string; title: string; edit: (ds: Device[]) => Device[] | void; needs?: Device['role'][] }
const variants: Variant[] = [
  { id: 'base', title: 'без изменений', edit: () => {} },

  // Имена
  { id: 'lav-plain', title: 'петличка: имена REC_0001.wav… без времени, дата файла — конец записи', needs: ['lav'], edit: (ds) => {
    for (const d of of(ds, 'lav')) d.files.forEach((f, i) => (f.name = `REC_${pad(i + 1)}${ext(f.name)}`));
  } },
  { id: 'lav-copied', title: 'петличка: имена без времени, файлы скопированы 01.11 в 12:00 (дата файла — время копирования)', needs: ['lav'], edit: (ds) => {
    for (const d of of(ds, 'lav')) d.files.forEach((f, i) => {
      f.name = `REC_${pad(i + 1)}${ext(f.name)}`;
      f.mtimeMs = new Date(2026, 10, 1, 12, 0, i * 2).getTime();
    });
  } },
  { id: 'lav-dated', title: 'петличка: дата и время в имени (2026-10-30_18-52-06.wav)', needs: ['lav'], edit: (ds) => {
    for (const d of of(ds, 'lav')) for (const f of d.files) {
      const start = f.mtimeMs / 1000 - (f.probe.format?.duration ? Number(f.probe.format.duration) : 0);
      f.name = `${localDate(start)}_${localTime(start)}${ext(f.name)}`;
    }
  } },
  { id: 'lav-3h', title: 'петличка: в именах время на 3 ч позже настоящего', needs: ['lav'], edit: (ds) => {
    for (const d of of(ds, 'lav')) for (const f of d.files) {
      const tod = timeOfDayFromFilename(f.name)!;
      const t = (tod + 3 * 3600) % 86400;
      f.name = `${two(Math.floor(t / 3600))}-${two(Math.floor(t / 60) % 60)}-${two(t % 60)}${ext(f.name)}`;
    }
  } },
  { id: 'rec-swapped', title: 'рекордер: файлы поменялись именами (первый назван вторым)', needs: ['recorder'], edit: (ds) => {
    for (const d of of(ds, 'recorder')) {
      const names = d.files.map((f) => f.name).reverse();
      d.files.forEach((f, i) => (f.name = names[i]));
    }
  } },
  { id: 'rec-named', title: 'рекордер: имена «Концерт 1.WAV», «Концерт 2.WAV»', needs: ['recorder'], edit: (ds) => {
    for (const d of of(ds, 'recorder')) d.files.forEach((f, i) => (f.name = `Концерт ${i + 1}${ext(f.name)}`));
  } },
  { id: 'cam-renamed', title: 'камеры: MP4 переименованы, файлы Sony XML потерялись', needs: ['camera'], edit: (ds) => {
    for (const d of cams(ds)) d.files.forEach((f, i) => {
      f.name = `${d.name} часть ${i + 1}${ext(f.name)}`;
      f.xml = null;
    });
  } },
  { id: 'same-names', title: 'звук: у рекордера и петлички одинаковые имена 0001.wav, 0002.wav…', needs: ['recorder', 'lav'], edit: (ds) => {
    for (const d of [...of(ds, 'recorder'), ...of(ds, 'lav')]) d.files.forEach((f, i) => (f.name = `${pad(i + 1)}.wav`));
  } },

  // Даты
  { id: 'rec-day', title: `рекордер: дата исправлена на ${sessionDay}, а время суток осталось своё`, needs: ['recorder'], edit: (ds) => {
    for (const d of of(ds, 'recorder')) for (const f of d.files) {
      const t = f.probe.format?.tags;
      if (t?.date) t.date = sessionDay;
    }
  } },
  { id: 'rec-noclock', title: 'рекордер: дата и время стёрты, остался тайм-код BWF и дата файла', needs: ['recorder'], edit: (ds) => of(ds, 'recorder').forEach((d) => dropClock(d)) },
  { id: 'rec-noclock-copied', title: 'рекордер: дата и время стёрты, файлы скопированы 01.11 в 12:00', needs: ['recorder'], edit: (ds) => of(ds, 'recorder').forEach((d) => dropClock(d, new Date(2026, 10, 1, 12))) },
  { id: 'cam2-year', title: 'вторая камера: дата на год вперёд', needs: ['camera'], edit: (ds) => cams(ds)[1] && shiftClock(cams(ds)[1], 365 * 86400) },
  { id: 'cams-day-back', title: 'вторая и третья камеры на сутки назад — большинство теперь с чужой датой', needs: ['camera'], edit: (ds) => cams(ds).slice(1, 3).forEach((d) => shiftClock(d, -86400)) },
  { id: 'cam3-3h', title: 'третья камера: часы на 3 ч вперёд (не тот пояс)', needs: ['camera'], edit: (ds) => cams(ds)[2] && shiftClock(cams(ds)[2], 3 * 3600) },
  { id: 'cams-noclock', title: 'камеры без даты в метаданных — тайм-код и дата файла', needs: ['camera'], edit: (ds) => cams(ds).forEach((d) => dropClock(d)) },
  { id: 'cams-noclock-copied', title: 'камеры без даты в метаданных, файлы скопированы 01.11 в 12:00', needs: ['camera'], edit: (ds) => cams(ds).forEach((d) => dropClock(d, new Date(2026, 10, 1, 12))) },
  { id: 'lav-next-day', title: 'петличка: дата файлов на сутки позже', needs: ['lav'], edit: (ds) => of(ds, 'lav').forEach((d) => shiftClock(d, 86400)) },
  { id: 'all-400d', title: 'все устройства на 400 суток назад одинаково', edit: (ds) => ds.forEach((d) => shiftClock(d, -400 * 86400)) },
  { id: 'cam1-fixed', title: 'первая камера: дата исправлена (+1 сутки)', needs: ['camera'], edit: (ds) => cams(ds)[0] && shiftClock(cams(ds)[0], 86400) },

  // Порядок
  { id: 'reverse', title: 'дорожки в обратном порядке', edit: (ds) => [...ds].reverse() },
  { id: 'sound-first', title: 'сначала звук, потом камеры', edit: (ds) => [...ds.filter((d) => d.role !== 'camera'), ...cams(ds)] },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n): Variant => ({
    id: `shuffle-${n}`,
    title: `случайный порядок дорожек и клипов в них №${n}`,
    edit: (ds) => {
      const r = rand(n * 7919);
      for (const d of ds) {
        d.files = shuffle(d.files, r);
        d.keepOrder = true;
      }
      return shuffle(ds, r);
    },
  })),

  // Всё вместе
  { id: 'mix-1', title: 'всё сразу: петличка скопирована без времени в именах, рекордер с днём съёмки, обратный порядок, клипы вразнобой', edit: (ds) => {
    variants.find((v) => v.id === 'lav-copied')!.edit(ds);
    variants.find((v) => v.id === 'rec-day')!.edit(ds);
    const r = rand(17);
    for (const d of ds) {
      d.files = shuffle(d.files, r);
      d.keepOrder = true;
    }
    return [...ds].reverse();
  } },
  { id: 'mix-2', title: 'всё сразу: камеры без XML, вторая на год вперёд, петличка на сутки позже, случайный порядок', edit: (ds) => {
    variants.find((v) => v.id === 'cam-renamed')!.edit(ds);
    variants.find((v) => v.id === 'cam2-year')!.edit(ds);
    variants.find((v) => v.id === 'lav-next-day')!.edit(ds);
    return shuffle(ds, rand(29));
  } },
];

// --- прогон

function build(devices: Device[], seed: number): { cameras: Camera[]; keyOf: Map<string, string> } {
  const keyOf = new Map<string, string>();
  const cameras = devices.map((d, di): Camera => {
    const files = d.keepOrder ? d.files : [...d.files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const clips = files.map((f, i) => {
      const id = `k${seed.toString(36)}${di}${i}`;
      keyOf.set(id, f.key);
      const probe = structuredClone(f.probe);
      if (probe.format) (probe.format as Record<string, unknown>).filename = f.name;
      const sony = f.xml ? parseSonyXml(f.xml) : null;
      return buildClipMeta({ id, path: f.audio, name: f.name, sizeBytes: f.size, mtimeMs: f.mtimeMs, probe, sony, proxyPath: null });
    });
    return { id: `c${seed.toString(36)}${di}`, name: d.name, folders: [d.name], clips, manualShiftSec: 0, timecodeTrust: 'auto', excludedClipIds: [], audioAssist: true, scanning: null };
  });
  return { cameras, keyOf };
}

async function run(v: Variant, seed: number) {
  const devices = structuredClone(source);
  const edited = v.edit(devices) ?? devices;
  const built = build(edited, seed);
  const plan = planRelocation(built.cameras);
  const cameras = plan.moves.length || plan.drops.length ? applyRelocation(built.cameras, plan) : built.cameras;
  const coarse = runSync(cameras);
  const audio = await alignByAudio(cameras, coarse, {
    features: (c, s, d) => audioFeatures(c.path, s, d, reportTiming(c)),
    samples: (c, s, d, ch) => audioSamples(c.path, s, d, ch, reportTiming(c)),
    whole: (c) => audioWholeFeatures(c.path, c.durationSec, reportTiming(c)),
  }, { searchSec: AUDIO_SEARCH_SEC, maxAnchors: 8, isEnabled: () => true, pre: {}, fixed: new Set(), controlClips: new Set() });
  const final = runSync(cameras, audio.corrections, heardCameras(audio));
  if (process.env.STRESS_LOG) {
    const name = (id: string) => cameras.find((c) => c.id === id)?.name ?? id;
    for (const c of coarse.cameras) console.log(`      раскладка ${name(c.cameraId)}: ${c.timeSource ?? 'нет времени'}, тк−часы ${c.timecodeVsClockSec?.toFixed(2) ?? '—'}, скачков ${c.timecodeJumps}, выброс даты ${c.dateOutlierSec ?? '—'}`);
    for (const line of audio.log ?? []) console.log(`      | ${cameras.reduce((s, c) => s.replaceAll(c.id, c.name), line)}`);
    for (const i of final.issues) console.log(`      раскладка: [${i.severity}] ${i.title}`);
  }
  const start = new Map<string, number>();
  for (const p of final.placements) start.set(built.keyOf.get(p.clipId)!, p.start);
  return { start, issues: audio.issues.map((i) => `[${i.severity}] ${i.title}`), moved: plan.moves.length };
}

const fmtShift = (s: number) => {
  const a = Math.abs(s);
  const sign = s < 0 ? '−' : '+';
  if (a < 1) return `${sign}${(a * 1000).toFixed(0)} мс`;
  if (a < 3600) return `${sign}${a.toFixed(1)} с`;
  if (a < 86400 * 2) return `${sign}${(a / 3600).toFixed(2)} ч`;
  return `${sign}${(a / 86400).toFixed(1)} сут`;
};
const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };

const only = new Set(process.argv.slice(3));
const chosen = variants.filter((v) => (!only.size || only.has(v.id) || v.id === 'base') && (v.needs ?? []).every((r) => source.some((d) => d.role === r)));
console.log(`отчёт ${report.app.version}, устройства: ${source.map((d) => `${d.name} (${d.role}, ${d.files.length})`).join(', ')}; день съёмки ${sessionDay}`);
const FRAME = 1 / 30;
let base: Map<string, number> | null = null;
let bad = 0;
for (const [i, v] of chosen.entries()) {
  const t0 = Date.now();
  const r = await run(v, i + 1);
  if (!base) {
    base = r.start;
    const tester = new Map<string, number>(report.sync.placements.map((p: any) => {
      const cam = report.cameras.find((c: any) => c.id === p.cameraId);
      return [`${cam.name}/${cam.clips.find((k: any) => k.id === p.clipId).file}`, p.start] as [string, number];
    }));
    const diff = [...base].map(([k, s]) => s - (tester.get(k) ?? NaN)).filter(Number.isFinite);
    const sh = median(diff);
    console.log(`эталон: от раскладки тестера до ${(Math.max(...diff.map((d) => Math.abs(d - sh))) * 1000).toFixed(0)} мс, сдвиг ${fmtShift(sh)}`);
  }
  const diff = [...base].map(([k, s]) => (r.start.has(k) ? r.start.get(k)! - s : NaN));
  const missing = diff.filter((d) => !Number.isFinite(d)).length;
  const shift = median(diff.filter(Number.isFinite));
  const errs = [...base.keys()].map((k, j) => ({ k, e: diff[j] - shift })).filter((x) => Number.isFinite(x.e));
  const worst = errs.reduce((a, b) => (Math.abs(b.e) > Math.abs(a.e) ? b : a), { k: '', e: 0 });
  const ok = !missing && Math.abs(worst.e) <= FRAME;
  if (!ok) bad++;
  console.log(`\n${ok ? 'OK   ' : 'ПЛОХО'} ${v.id}: ${v.title}`);
  console.log(`      клипы до ${(Math.abs(worst.e) * 1000).toFixed(0)} мс от эталона${Math.abs(worst.e) > 0.002 ? ` (хуже всех ${worst.k})` : ''}; вся съёмка сдвинута на ${fmtShift(shift)}${missing ? `; не поставлено ${missing}` : ''}${r.moved ? `; перенесено клипов ${r.moved}` : ''}; ${((Date.now() - t0) / 1000).toFixed(0)} с`);
  if (!ok) for (const x of errs.filter((x) => Math.abs(x.e) > FRAME)) console.log(`      ${x.k}: ${fmtShift(x.e)}`);
  for (const line of r.issues) console.log(`      ${line}`);
}
console.log(`\nвариантов ${chosen.length}, плохих ${bad}`);
