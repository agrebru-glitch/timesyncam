// Проверка без интерфейса:
//   node scripts/scan-cli.mts <папка камеры> [<папка камеры 2> ...] [--audio] [--qr <камера>:<клип>@<секунда>] [--xml путь.xml | путь.fcpxml]
// --qr можно повторять: например --qr 1:C0009.MP4@4 — контрольный кадр в клипе C0009 камеры 1 на 4-й секунде.
// Папки только читаются. XML пишется туда, куда указано.
import { writeFile } from 'node:fs/promises';
import { scanFolder } from '../src/main/scan.ts';
import { audioFeatures, audioSamples } from '../src/main/audio.ts';
import { scanQr } from '../src/main/qr.ts';
import { runSync } from '../src/core/sync.ts';
import { heardCameras, refineByAudio } from '../src/core/audioSync.ts';
import { controlCorrections } from '../src/core/qrSync.ts';
import type { ControlFrame, QrResult } from '../src/core/qrSync.ts';
import { rateValue } from '../src/core/timecode.ts';
import { buildFcp7Xml, defaultResolution, defaultTimelineRate } from '../src/core/fcp7.ts';
import { buildFcpxml } from '../src/core/fcpxml.ts';
import { formatClockTime, formatDurationHuman } from '../src/core/format.ts';
import type { Camera, SyncResult } from '../src/core/types.ts';

const args = process.argv.slice(2);
const take = (flag: string) => {
  const out: string[] = [];
  for (let i = args.indexOf(flag); i >= 0; i = args.indexOf(flag)) {
    out.push(args[i + 1]);
    args.splice(i, 2);
  }
  return out;
};
const xmlPath = take('--xml')[0] ?? null;
const qrArgs = take('--qr');
const withAudio = args.includes('--audio') || qrArgs.length > 0;
const folders = args.filter((a) => a !== '--audio');

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

// Контрольные кадры: читаем экран синхронизации.
const controls: { frame: ControlFrame; result: QrResult }[] = [];
for (const q of qrArgs) {
  const m = /^(\d+):(.+)@([\d.]+)$/.exec(q);
  if (!m) throw new Error(`Не понял --qr ${q}`);
  const cam = cameras[Number(m[1]) - 1];
  const clip = cam?.clips.find((c) => c.name === m[2]);
  if (!clip || !clip.rate || !clip.width || !clip.height) throw new Error(`Нет клипа ${q}`);
  const t = performance.now();
  const scan = await scanQr(clip.path, Number(m[3]), rateValue(clip.rate), clip.width, clip.height, clip.durationSec);
  console.log(`QR ${cam.name} ${clip.name}: прочитано кадров ${scan.framesRead}, с кодом ${scan.framesWithCode}, ${((performance.now() - t) / 1000).toFixed(1)} с` +
    (scan.result ? `, смен кода ${scan.result.transitions}, точность ±${(scan.result.precisionSec * 1000).toFixed(1)} мс` : ', код не найден'));
  if (scan.result) controls.push({ frame: { cameraId: cam.id, clipId: clip.id, localSec: Number(m[3]) }, result: scan.result });
}
const clockOnly = new Set(r.cameras.filter((c) => c.timeSource === 'clock').map((c) => c.cameraId));
const control = controlCorrections(controls, r.placements, clockOnly);
for (const [camId, c] of control.cameras) console.log(`  ${camId}: поправка по экрану ${c.correction.toFixed(4)} с, точность ±${(c.precisionSec * 1000).toFixed(1)} мс`);

if (withAudio) {
  const t = performance.now();
  const audio = await refineByAudio(cameras, r, {
    features: (clip, s, d) => audioFeatures(clip.path, s, d),
    samples: (clip, s, d, ch) => audioSamples(clip.path, s, d, ch),
  }, {
    searchSec: 10,
    maxAnchors: 8,
    isEnabled: (id) => cameras.find((c) => c.id === id)?.audioAssist ?? true,
    pre: control.pre,
    fixed: control.fixed,
    controlClips: control.clips,
  });
  console.log(`--- Сверка по звуку: ${((performance.now() - t) / 1000).toFixed(1)} с`);
  for (const c of audio.cameras) {
    console.log(`${c.cameraId}: ${c.status}, модель=${c.model}, поправка=${c.correction?.toFixed(4)} с, широкий сдвиг=${c.wideShift?.toFixed(3) ?? '-'}, шагов=${c.steps.length}`);
    for (const a of c.anchors) console.log(`    точка ${a.role}: поправка ${a.correction.toFixed(5)} с, совпадение ${a.score.toFixed(2)}, отрыв ×${a.ratio.toFixed(2)}, точно=${a.fine ? a.fineConfidence.toFixed(1) : 'нет'}`);
  }
  for (const i of audio.issues) console.log(`  [${i.severity}] ${i.title}`);
  r = runSync(cameras, audio.corrections, new Set([...heardCameras(audio), ...control.fixed]));
  report(r, 'После сверки');
}

if (xmlPath) {
  const rate = defaultTimelineRate(cameras);
  const { width, height } = defaultResolution(cameras);
  const build = xmlPath.endsWith('.fcpxml') ? buildFcpxml : buildFcp7Xml;
  await writeFile(xmlPath, build(cameras, r, { name: 'Проверка TimesynCam', rate, width, height }), 'utf8');
  console.log(`XML: ${xmlPath} (${rate.num}/${rate.den}, ${width}×${height})`);
}
