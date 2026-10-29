// Проверка без интерфейса: node scripts/scan-cli.mts <папка камеры> [<папка камеры 2> ...] [--audio] [--xml путь.xml]
// Папки только читаются. XML пишется туда, куда указано.
import { writeFile } from 'node:fs/promises';
import { scanFolder } from '../src/main/scan.ts';
import { audioEnvelope } from '../src/main/audio.ts';
import { runSync } from '../src/core/sync.ts';
import { heardCameras, refineByAudio } from '../src/core/audioSync.ts';
import { buildFcp7Xml, defaultResolution, defaultTimelineRate } from '../src/core/fcp7.ts';
import { formatClockTime, formatDurationHuman } from '../src/core/format.ts';
import type { Camera, SyncResult } from '../src/core/types.ts';

const args = process.argv.slice(2);
const xmlIdx = args.indexOf('--xml');
const xmlPath = xmlIdx >= 0 ? args[xmlIdx + 1] : null;
const withAudio = args.includes('--audio');
const folders = args.filter((a, i) => a !== '--audio' && (xmlIdx < 0 || (i !== xmlIdx && i !== xmlIdx + 1)));

const cameras: Camera[] = [];
for (const [i, folder] of folders.entries()) {
  const t = performance.now();
  const res = await scanFolder(folder, () => undefined);
  console.log(`Камера ${i + 1}: ${res.clips.length} клипов за ${((performance.now() - t) / 1000).toFixed(1)} с, без SDK: ${res.needsSdk.length}, не прочитано: ${res.unreadable.length}`);
  cameras.push({ id: `cam${i}`, name: `Камера ${i + 1}`, folders: [folder], clips: res.clips, manualShiftSec: 0, timecodeTrust: 'auto', excludedClipIds: [], audioAssist: true, scanning: null });
}

function report(r: SyncResult, title: string) {
  const tz = r.displayTzOffsetMin;
  console.log(`--- ${title}`);
  for (const cs of r.cameras) {
    console.log(`${cs.cameraId}: источник=${cs.timeSource}, TC−часы=${cs.timecodeVsClockSec?.toFixed(2)} с, скачков=${cs.timecodeJumps}, RecRun=${cs.recRun}, дорожек=${cs.lanes}, ${cs.start ? formatClockTime(cs.start, tz) : '-'}–${cs.end ? formatClockTime(cs.end, tz) : '-'}`);
  }
  console.log(`Замечаний: ${r.issues.length}`);
  for (const i of r.issues) console.log(`  [${i.severity}] ${i.title}`);
  const names = new Map(cameras.flatMap((c) => c.clips.map((x) => [x.id, x] as const)));
  const sorted = [...r.placements].sort((a, b) => a.start - b.start);
  for (const p of sorted.length > 6 ? [...sorted.slice(0, 3), ...sorted.slice(-2)] : sorted) {
    const c = names.get(p.clipId)!;
    console.log(`  ${p.cameraId} ${c.name}: ${formatClockTime(p.start, tz)}.${String(Math.round((p.start % 1) * 1000)).padStart(3, '0')} (${p.method}), длина ${formatDurationHuman(c.durationSec)}, TC ${c.tc?.text}, ${c.codecLabel}`);
  }
}

let r = runSync(cameras);
report(r, 'По тайм-коду и часам');

if (withAudio) {
  const t = performance.now();
  const audio = await refineByAudio(cameras, r, (clip, s, d) => audioEnvelope(clip.path, s, d), {
    searchSec: 10,
    maxAnchors: 8,
    isEnabled: (id) => cameras.find((c) => c.id === id)?.audioAssist ?? true,
  });
  console.log(`--- Сверка по звуку: ${((performance.now() - t) / 1000).toFixed(1)} с`);
  for (const c of audio.cameras) {
    console.log(`${c.cameraId}: ${c.status}, модель=${c.model}, поправка=${c.correction?.toFixed(3)} с, широкий сдвиг=${c.wideShift?.toFixed(3) ?? '-'}, шагов=${c.steps.length}`);
    for (const a of c.anchors) console.log(`    точка ${a.role}: поправка ${a.correction.toFixed(3)} с, совпадение ${a.score.toFixed(2)}, отрыв ×${a.ratio.toFixed(2)}`);
  }
  for (const i of audio.issues) console.log(`  [${i.severity}] ${i.title}`);
  r = runSync(cameras, audio.corrections, heardCameras(audio));
  report(r, 'После сверки по звуку');
}

if (xmlPath) {
  const rate = defaultTimelineRate(cameras);
  const { width, height } = defaultResolution(cameras);
  await writeFile(xmlPath, buildFcp7Xml(cameras, r, { name: 'Проверка TimesynCam', rate, width, height }), 'utf8');
  console.log(`XML: ${xmlPath} (${rate.num}/${rate.den}, ${width}×${height})`);
}
