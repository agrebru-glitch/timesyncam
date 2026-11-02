// Отчёт для разработчика: всё, что нужно, чтобы разобрать, почему синхронизация вышла так, а не иначе, —
// без видео и звука и без полных путей на диске (только имена папок и файлов).
import type { Issue } from '../core/types.ts';
import type { State } from './state.ts';

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? '';
const parent = (p: string) => p.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] ?? '';

export function buildReport(state: State, issues: Issue[]): string {
  const report = {
    about: 'TimesynCam — отчёт для разработчика. Видео, звука и полных путей здесь нет.',
    app: { version: __APP_VERSION__, platform: navigator.platform, userAgent: navigator.userAgent, created: new Date().toISOString(), tzOffsetMin: -new Date().getTimezoneOffset() },
    tools: state.tools,
    syncMode: state.syncMode,
    cameras: state.cameras.map((c) => ({
      id: c.id,
      name: c.name,
      folders: c.folders.map(base),
      follower: !!c.follower,
      audioAssist: c.audioAssist,
      manualShiftSec: c.manualShiftSec,
      timecodeTrust: c.timecodeTrust,
      excludedClipIds: c.excludedClipIds,
      clips: c.clips.map((k) => ({
        id: k.id,
        file: k.name,
        folder: parent(k.path),
        sizeBytes: k.sizeBytes,
        durationSec: k.durationSec,
        recordedSec: k.recordedSec,
        captureFps: k.captureFps,
        rate: k.rate,
        frames: k.frames,
        width: k.width,
        height: k.height,
        codec: k.codec,
        codecLabel: k.codecLabel,
        hasVideo: k.hasVideo,
        audioChannels: k.audioChannels,
        audioSampleRate: k.audioSampleRate,
        audioStartSec: k.audioStartSec,
        tc: k.tc,
        clock: k.clock,
        camera: k.camera,
        proxy: !!k.proxyPath,
      })),
    })),
    controlFrames: state.controlFrames,
    control: state.control,
    sync: state.sync && {
      start: state.sync.start,
      end: state.sync.end,
      displayTzOffsetMin: state.sync.displayTzOffsetMin,
      cameras: state.sync.cameras,
      placements: state.sync.placements,
    },
    audio: state.audio && {
      cameras: state.audio.cameras.map((c) => ({ ...c, anchors: c.anchors.map((a) => ({ clip: a.clipId, ref: a.refClipId, at: a.at, correction: a.correction, score: a.score, ratio: a.ratio, role: a.role, fine: a.fine })) })),
      corrections: state.audio.corrections,
      log: state.audio.log ?? [],
    },
    issues: issues.map((i) => ({ severity: i.severity, camera: state.cameras.find((c) => c.id === i.cameraId)?.name ?? null, title: i.title, details: i.details })),
  };
  return JSON.stringify(report, null, 1);
}
