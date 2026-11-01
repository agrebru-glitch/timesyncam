// Повтор сверки по расширенному отчёту тестера — без видео, по звуку из архива.
//   node scripts/replay-report.mts <распакованный архив> [--old]
// Восстанавливает клипы из report.json (время, тайм-код, откуда взято), подставляет звук <файл>.opus
// и прогоняет раскладку и сверку. Печатает, где программа тестера поставила клипы и где их ставит сейчас.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSync } from '../src/core/sync.ts';
import { alignByAudio } from '../src/core/align.ts';
import { audioFeatures, audioSamples, audioWholeFeatures } from '../src/main/audio.ts';
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
  follower: c.follower,
  scanning: null,
  clips: c.clips.map((k: any): ClipMeta => {
    const audio = join(dir, safe(c.name), `${k.file}.opus`);
    return { ...k, name: k.file, path: audio, proxyPath: null, playable: false, audioChannels: existsSync(audio) ? k.audioChannels : 0 };
  }),
}));
console.log(`программа тестера ${r.app.version}, режим ${r.syncMode}, камер ${cameras.length}, клипов ${cameras.reduce((n, c) => n + c.clips.length, 0)}`);

const coarse = runSync(cameras);
const audio = await alignByAudio(cameras, coarse, {
  features: (c, s, d) => audioFeatures(c.path, s, d),
  samples: (c, s, d, ch) => audioSamples(c.path, s, d, ch),
  whole: (c) => audioWholeFeatures(c.path, c.durationSec),
}, { searchSec: 30, maxAnchors: 8, isEnabled: (id) => cameras.find((c) => c.id === id)?.audioAssist ?? true, followers: new Set(cameras.filter((c) => c.follower).map((c) => c.id)) });
const now = runSync(cameras, audio.corrections);

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
