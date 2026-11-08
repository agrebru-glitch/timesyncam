// Повтор сверки по расширенному отчёту тестера — без видео, по звуку из архива.
//   node scripts/replay-report.mts <распакованный архив> [--json раскладка.json]
// Восстанавливает клипы из report.json (время, тайм-код, откуда взято), подставляет звук <файл>.opus
// и прогоняет раскладку и сверку. Печатает, где программа тестера поставила клипы и где их ставит сейчас.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSync } from '../src/core/sync.ts';
import { heardCameras } from '../src/core/audioSync.ts';
import { alignByAudio } from '../src/core/align.ts';
import { audioFeatures, audioSamples, audioWholeFeatures } from '../src/main/audio.ts';
// Звук клипа в отчёте — Opus, вынутый из файла: его время начинается с первого сэмпла звука.
const reportTiming = (c: { audioStartSec?: number }) => ({ start: c.audioStartSec ?? 0, copy: true });
import type { Camera, ClipMeta } from '../src/core/types.ts';

const dir = process.argv[2];
const r = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').trim() || 'без имени';
const cameras: Camera[] = r.cameras.map((c: any) => ({
  id: c.id,
  name: c.name,
  folders: [],
  manualShiftSec: c.manualShiftSec,
  timecodeTrust: c.timecodeTrust,
  excludedClipIds: c.excludedClipIds,
  audioAssist: c.audioAssist,
  scanning: null,
  clips: c.clips.map((k: any): ClipMeta => {
    const audio = join(dir, safe(c.name), `${k.file}.opus`);
    return { ...k, name: k.file, path: audio, proxyPath: null, playable: false, audioChannels: existsSync(audio) ? k.audioChannels : 0 };
  }),
}));
console.log(`программа тестера ${r.app.version}, режим ${r.syncMode}, камер ${cameras.length}, клипов ${cameras.reduce((n, c) => n + c.clips.length, 0)}`);

const coarse = runSync(cameras);
// Режим «Контрольный кадр + тайм-код + звук»: поправки по экрану из отчёта (по камере), камеры с экраном — опорные.
// Камера без тайм-кода ставится по клипу с экраном — в отчёте только итог по камере, его и берём.
const pre: Record<string, number> = {};
const fixed = new Set<string>();
const controlClips = new Set<string>();
if (r.syncMode === 'control' && r.control && !process.argv.includes('--no-control')) {
  for (const [camId, c] of Object.entries(r.control as Record<string, { correction: number }>)) {
    for (const p of coarse.placements) if (p.cameraId === camId) pre[p.clipId] = c.correction;
    if (coarse.cameras.find((x) => x.cameraId === camId)?.timeSource !== 'clock') fixed.add(camId);
  }
  for (const f of Object.values(r.controlFrames ?? {}) as { clipId: string }[]) controlClips.add(f.clipId);
  console.log(`контрольные кадры: камер ${Object.keys(r.control).length}, опорных ${fixed.size}`);
}
const audio = await alignByAudio(cameras, coarse, {
  features: (c, s, d) => audioFeatures(c.path, s, d, reportTiming(c)),
  samples: (c, s, d, ch) => audioSamples(c.path, s, d, ch, reportTiming(c)),
  whole: (c) => audioWholeFeatures(c.path, c.durationSec, reportTiming(c)),
}, { searchSec: 30, maxAnchors: 8, isEnabled: (id) => cameras.find((c) => c.id === id)?.audioAssist ?? true, pre, fixed, controlClips });
const now = runSync(cameras, audio.corrections, new Set([...heardCameras(audio), ...fixed]));

for (const line of audio.log ?? []) console.log(line);
console.log('--- клипы: у тестера → сейчас (секунды от начала съёмки)');
const t0 = (pl: { start: number }[]) => Math.min(...pl.map((p) => p.start));
const theirs = r.sync?.placements ?? [];
for (const cam of cameras) {
  for (const k of cam.clips) {
    const a = theirs.find((p: any) => p.clipId === k.id);
    const b = now.placements.find((p) => p.clipId === k.id);
    const fa = a ? (a.start - t0(theirs)).toFixed(3) : '—';
    const fb = b ? (b.start - t0(now.placements)).toFixed(3) : '—';
    console.log(`  ${cam.name} / ${k.name}: ${fa} → ${fb}`);
  }
}
for (const i of audio.issues) console.log(`  [${i.severity}] ${i.title}`);
console.log('--- клипы без сверки (на таймлинии — пунктир)');
for (const cam of cameras) {
  const list = cam.clips.filter((k) => audio.unsure?.[k.id] && !cam.excludedClipIds.includes(k.id));
  if (list.length) console.log(`  ${cam.name}: ${list.length} из ${cam.clips.length} — ${list.map((k) => `${k.name} (${audio.unsure![k.id]})`).join(', ')}`);
}
// Раскладка «файл → начало, с» — для сверки по звуку (probe) и сравнения с проектом монтажки.
const jsonAt = process.argv.indexOf('--json');
if (jsonAt > 0) {
  const at: Record<string, number> = {};
  for (const cam of cameras) for (const k of cam.clips) {
    const p = now.placements.find((x) => x.clipId === k.id);
    if (p) at[k.name] = p.start;
  }
  writeFileSync(process.argv[jsonAt + 1], JSON.stringify(at));
}
