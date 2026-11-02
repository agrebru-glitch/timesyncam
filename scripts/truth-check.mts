// Точность на демо-съёмке: сравнивает раскладку с настоящим временем клипов из truth.json.
//   node scripts/make-demo.mjs <папка>
//   node scripts/truth-check.mts <папка> [--qr-only GoPro,A7 III]
// Показывает ошибку каждого клипа в трёх режимах: только тайм-код, тайм-код + звук, контрольный кадр + тайм-код + звук.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { scanFolder } from '../src/main/scan.ts';
import { audioFeatures, audioSamples, audioWholeFeatures, clipTiming } from '../src/main/audio.ts';
import { alignByAudio } from '../src/core/align.ts';
import { scanQr } from '../src/main/qr.ts';
import { runSync } from '../src/core/sync.ts';
import { AUDIO_SEARCH_SEC, refineByAudio } from '../src/core/audioSync.ts';
import { controlCorrections } from '../src/core/qrSync.ts';
import type { QrResult, ControlFrame } from '../src/core/qrSync.ts';
import { rateValue } from '../src/core/timecode.ts';
import type { Camera, SyncResult } from '../src/core/types.ts';

const DEMO = process.argv[2];
// Экран синхронизации снимали только эти камеры (по части имени папки); без флага — все, у кого он есть.
const qrOnlyArg = process.argv.indexOf('--qr-only');
const qrOnly = qrOnlyArg > 0 ? process.argv[qrOnlyArg + 1].split(',') : null;
const truth = new Map<string, number>((JSON.parse(readFileSync(join(DEMO, 'truth.json'), 'utf8')) as { file: string; epoch: number }[]).map((t) => [t.file, t.epoch]));
const dirs = readdirSync(DEMO).filter((d) => statSync(join(DEMO, d)).isDirectory()).sort();
const cameras: Camera[] = [];
for (const [i, d] of dirs.entries()) {
  const res = await scanFolder(join(DEMO, d), () => undefined);
  cameras.push({ id: d, name: `Камера ${i + 1}`, folders: [], clips: res.clips, manualShiftSec: 0, timecodeTrust: 'auto', excludedClipIds: [], audioAssist: true, scanning: null });
}
const fetchAudio = {
  features: (c: { path: string; audioStartSec?: number }, s: number, d: number) => audioFeatures(c.path, s, d, clipTiming(c)),
  samples: (c: { path: string; audioStartSec?: number }, s: number, d: number, ch: number) => audioSamples(c.path, s, d, ch, clipTiming(c)),
  whole: (c: { path: string; durationSec: number; audioStartSec?: number }) => audioWholeFeatures(c.path, c.durationSec, clipTiming(c)),
};
// --old — прежняя сверка цепочкой (для сравнения), по умолчанию — новая: все дорожки со всеми.
const OLD = process.argv.includes('--old');
const sync = (opts: Parameters<typeof refineByAudio>[3]) => (OLD ? refineByAudio(cameras, coarse, fetchAudio, opts) : alignByAudio(cameras, coarse, fetchAudio, opts));

// Ошибка каждого клипа. Для монтажа важна стыковка камер между собой, поэтому показываем и общий сдвиг
// всей съёмки (медиана ошибок), и ошибку каждого клипа относительно него. Больше двух кадров — с пометкой «!».
function errors(r: SyncResult, title: string) {
  const all: number[] = [];
  const rows = cameras.map((cam) => cam.clips.map((c) => {
    const p = r.placements.find((x) => x.clipId === c.id);
    const t = truth.get(`${cam.id}/${c.name}`);
    const e = p && t !== undefined ? p.start - t : null;
    if (e !== null) all.push(e);
    return e;
  }));
  const s = [...all].sort((a, b) => a - b);
  const base = s.length ? s[Math.floor(s.length / 2)] : 0;
  const show = (e: number) => (Math.abs(e) >= 60 ? `${(e / 3600).toFixed(Math.abs(e) >= 36000 ? 0 : 2)} ч` : Math.abs(e) >= 1 ? `${e.toFixed(2)} с` : `${(e * 1000).toFixed(1)} мс`);
  const bad = all.filter((e) => Math.abs(e - base) > 0.08).length;
  console.log(`--- ${title}: общий сдвиг ${show(base)}, клипов мимо больше 2 кадров: ${bad} из ${all.length}`);
  cameras.forEach((cam, i) => {
    console.log(`  ${cam.id}: ${rows[i].map((e) => (e === null ? '—' : `${show(e - base)}${Math.abs(e - base) > 0.08 ? '!' : ''}`)).join(' / ')}`);
  });
}

const coarse = runSync(cameras);
errors(coarse, 'Только тайм-код и часы');

let t0 = performance.now();
const audio = await sync({ searchSec: AUDIO_SEARCH_SEC, maxAnchors: 8, isEnabled: () => true });
console.log(`  (сверка ${((performance.now() - t0) / 1000).toFixed(0)} с)`);
for (const c of audio.cameras) console.log(`  ${c.cameraId}: ${c.status}${c.correction !== null ? `, поправка ${c.correction.toFixed(3)} с` : ''}, точек ${c.anchors.filter((a) => a.role !== 'ignored').length}`);
for (const i of audio.issues) console.log(`  [${i.severity}] ${i.title}`);
errors(runSync(cameras, audio.corrections), 'Тайм-код + звук');

// Контрольные кадры — короткие клипы с экраном синхронизации.
const controls: { frame: ControlFrame; result: QrResult }[] = [];
for (const cam of cameras) {
  if (qrOnly && !qrOnly.some((s) => cam.id.includes(s))) continue;
  for (const c of cam.clips) {
    if (!c.hasVideo || !c.rate || !c.width || !c.height || c.durationSec < 6 || c.durationSec > 9) continue;
    const s = await scanQr(c.path, c.durationSec / 2, rateValue(c.rate), c.width, c.height, c.durationSec);
    if (!s.result) continue;
    const t = truth.get(`${cam.id}/${c.name}`);
    console.log(`  экран в ${cam.id}/${c.name}: смен кода ${s.result.transitions}, ошибка начала ${t !== undefined ? ((s.result.clipStartEpoch - t) * 1000).toFixed(1) : '—'} мс`);
    controls.push({ frame: { cameraId: cam.id, clipId: c.id, localSec: c.durationSec / 2 }, result: s.result });
  }
}
const ctl = controlCorrections(controls, coarse.placements, new Set(coarse.cameras.filter((x) => x.timeSource === 'clock').map((x) => x.cameraId)));
t0 = performance.now();
const withControl = await sync({ searchSec: AUDIO_SEARCH_SEC, maxAnchors: 8, isEnabled: () => true, pre: ctl.pre, fixed: ctl.fixed, controlClips: ctl.clips });
console.log(`  (сверка ${((performance.now() - t0) / 1000).toFixed(0)} с)`);
errors(runSync(cameras, withControl.corrections), 'Контрольный кадр + тайм-код + звук');
