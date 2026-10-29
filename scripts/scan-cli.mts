// Проверка без интерфейса: node scripts/scan-cli.mts <папка камеры> [<папка камеры 2> ...] [--xml путь.xml]
// Папки только читаются. XML пишется туда, куда указано.
import { writeFile } from 'node:fs/promises';
import { scanFolder } from '../src/main/scan.ts';
import { runSync } from '../src/core/sync.ts';
import { buildFcp7Xml, defaultResolution, defaultTimelineRate } from '../src/core/fcp7.ts';
import { formatClockTime, formatDurationHuman } from '../src/core/format.ts';
import type { Camera } from '../src/core/types.ts';

const args = process.argv.slice(2);
const xmlIdx = args.indexOf('--xml');
const xmlPath = xmlIdx >= 0 ? args[xmlIdx + 1] : null;
const folders = xmlIdx >= 0 ? args.filter((_, i) => i !== xmlIdx && i !== xmlIdx + 1) : args;

const cameras: Camera[] = [];
for (const [i, folder] of folders.entries()) {
  const t = performance.now();
  const res = await scanFolder(folder, () => undefined);
  console.log(`Камера ${i + 1}: ${res.clips.length} клипов за ${((performance.now() - t) / 1000).toFixed(1)} с, без SDK: ${res.needsSdk.length}, не прочитано: ${res.unreadable.length}`);
  cameras.push({ id: `cam${i}`, name: `Камера ${i + 1}`, folders: [folder], clips: res.clips, manualShiftSec: 0, timecodeTrust: 'auto', excludedClipIds: [], scanning: null });
}

const r = runSync(cameras);
const tz = r.displayTzOffsetMin;
for (const cs of r.cameras) {
  console.log(`${cs.cameraId}: источник=${cs.timeSource}, TC−часы=${cs.timecodeVsClockSec?.toFixed(2)} с, скачков=${cs.timecodeJumps}, RecRun=${cs.recRun}, дорожек=${cs.lanes}, ${formatClockTime(cs.start!, tz)}–${formatClockTime(cs.end!, tz)}`);
}
console.log(`Замечаний: ${r.issues.length}`);
for (const i of r.issues) console.log(`  [${i.severity}] ${i.title}`);
const sorted = [...r.placements].sort((a, b) => a.start - b.start);
const names = new Map(cameras.flatMap((c) => c.clips.map((x) => [x.id, x] as const)));
for (const p of [...sorted.slice(0, 3), ...sorted.slice(-2)]) {
  const c = names.get(p.clipId)!;
  console.log(`  ${c.name}: ${formatClockTime(p.start, tz)} (${p.method}), длина ${formatDurationHuman(c.durationSec)}, TC ${c.tc?.text}, ${c.codecLabel}, прокси=${!!c.proxyPath}`);
}

if (xmlPath) {
  const rate = defaultTimelineRate(cameras);
  const { width, height } = defaultResolution(cameras);
  await writeFile(xmlPath, buildFcp7Xml(cameras, r, { name: 'Проверка TimesynCam', rate, width, height }), 'utf8');
  console.log(`XML: ${xmlPath} (${rate.num}/${rate.den}, ${width}×${height})`);
}
