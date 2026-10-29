import type { Camera, ClipMeta, Issue, SyncResult, TimecodeTrust } from '../core/types.ts';
import type { AudioSyncResult } from '../core/audioSync.ts';
import type { ControlFrame, QrResult } from '../core/qrSync.ts';

export type Tab = 'sync' | 'errors' | 'faq';

// Как синхронизировать: только тайм-код и часы; затем ещё сверка по звуку;
// или сначала контрольные кадры с экрана синхронизации, затем тайм-код и звук.
export type SyncMode = 'audio' | 'timecode' | 'control';

// Что дал экран синхронизации на камере — для карточки камеры.
export interface ControlInfo {
  correction: number;
  precisionSec: number;
  transitions: number;
  frames: number;
}

export interface Viewport {
  start: number; // эпоха, левый край таймлинии
  secPerPx: number;
}

export interface Toast {
  id: number;
  text: string;
  revealPath?: string;
}

export interface State {
  cameras: Camera[];
  version: number; // растёт при каждом изменении, которое требует синхронизации
  syncedVersion: number | null;
  sync: SyncResult | null;
  scanIssues: Issue[];
  tab: Tab;
  faqAnchor: string | null;
  viewMode: 'multi' | 'single';
  activeCameraId: string | null;
  selectedClipId: string | null;
  playhead: number | null;
  playing: boolean;
  viewport: Viewport | null;
  exportOpen: boolean;
  toasts: Toast[];
  tools: { ffprobe: boolean; ffmpeg: boolean } | null;
  syncMode: SyncMode;
  syncMenuOpen: boolean;
  audioRun: { done: number; total: number; frac: number } | null; // идёт сверка по звуку; frac — доля работы, только растёт
  audio: AudioSyncResult | null;
  controlFrames: Record<string, ControlFrame>; // по клипу — где отмечен контрольный кадр
  qrResults: Record<string, QrResult | null>; // прочитанные экраны: ключ «клип@секунда»
  control: Record<string, ControlInfo> | null; // итог по камерам после синхронизации
  controlPre: Record<string, number>; // поправки клипов по экрану — для пересчёта после ручной подгонки
  controlFixed: string[]; // камеры, которые стоят по экрану точно и звуком не двигаются
  controlIssues: Issue[];
  qrRun: { done: number; total: number } | null;
  previewOn: boolean;
  qrScreenOpen: boolean;
  controlHint: number | null; // подсказка «отметьте контрольный кадр»: номер показа, null — скрыта
}

let camSeq = 0;
export function newCamera(index: number): Camera {
  camSeq += 1;
  return {
    id: `cam${Date.now().toString(36)}${camSeq}`,
    name: `Камера ${index}`,
    folders: [],
    clips: [],
    manualShiftSec: 0,
    timecodeTrust: 'auto',
    excludedClipIds: [],
    audioAssist: true,
    scanning: null,
  };
}

export const initialState: State = {
  cameras: [newCamera(1)],
  version: 0,
  syncedVersion: null,
  sync: null,
  scanIssues: [],
  tab: 'sync',
  faqAnchor: null,
  viewMode: 'multi',
  activeCameraId: null,
  selectedClipId: null,
  playhead: null,
  playing: false,
  viewport: null,
  exportOpen: false,
  toasts: [],
  tools: null,
  syncMode: 'audio',
  syncMenuOpen: false,
  audioRun: null,
  audio: null,
  controlFrames: {},
  qrResults: {},
  control: null,
  controlPre: {},
  controlFixed: [],
  controlIssues: [],
  qrRun: null,
  previewOn: true,
  qrScreenOpen: false,
  controlHint: null,
};

export type Action =
  | { type: 'add-camera'; camera?: Camera }
  | { type: 'remove-camera'; cameraId: string }
  | { type: 'rename-camera'; cameraId: string; name: string }
  | { type: 'scan-start'; cameraId: string; folder: string }
  | { type: 'scan-progress'; cameraId: string; done: number; total: number }
  | { type: 'scan-done'; cameraId: string; clips: ClipMeta[]; issues: Issue[] }
  | { type: 'set-trust'; cameraId: string; trust: TimecodeTrust }
  | { type: 'shift-camera'; cameraId: string; deltaSec?: number; absoluteSec?: number }
  | { type: 'exclude-clips'; cameraId: string; clipIds: string[] }
  | { type: 'restore-clips'; cameraId: string }
  | { type: 'synced'; result: SyncResult; fit: boolean }
  | { type: 'tab'; tab: Tab; faqAnchor?: string | null }
  | { type: 'view-mode'; mode: 'multi' | 'single'; cameraId?: string }
  | { type: 'select-clip'; clipId: string | null }
  | { type: 'playhead'; at: number }
  | { type: 'play'; playing: boolean }
  | { type: 'viewport'; viewport: Viewport }
  | { type: 'export-open'; open: boolean }
  | { type: 'toast'; text: string; revealPath?: string }
  | { type: 'toast-dismiss'; id: number }
  | { type: 'tools'; tools: { ffprobe: boolean; ffmpeg: boolean } }
  | { type: 'sync-menu'; open: boolean }
  | { type: 'sync-mode'; mode: SyncMode }
  | { type: 'audio-start' }
  | { type: 'audio-progress'; done: number; total: number }
  | { type: 'audio-done'; result: AudioSyncResult | null }
  | { type: 'set-audio-assist'; cameraId: string; on: boolean }
  | { type: 'set-follower'; cameraId: string; on: boolean }
  | { type: 'set-control'; frame: ControlFrame }
  | { type: 'clear-control'; clipId: string }
  | { type: 'qr-start'; total: number }
  | { type: 'qr-progress'; done: number }
  | { type: 'qr-result'; key: string; result: QrResult | null }
  | { type: 'qr-done'; control: Record<string, ControlInfo> | null; issues: Issue[]; pre: Record<string, number>; fixed: string[] }
  | { type: 'preview'; on: boolean }
  | { type: 'qr-screen'; open: boolean }
  | { type: 'control-hint-close' };

let toastSeq = 0;

function mapCamera(state: State, id: string, fn: (c: Camera) => Camera): Camera[] {
  return state.cameras.map((c) => (c.id === id ? fn(c) : c));
}

export function reducer(state: State, a: Action): State {
  switch (a.type) {
    case 'add-camera':
      return { ...state, cameras: [...state.cameras, a.camera ?? newCamera(state.cameras.length + 1)] };
    case 'remove-camera': {
      const removed = state.cameras.find((c) => c.id === a.cameraId);
      const cameras = state.cameras.filter((c) => c.id !== a.cameraId);
      return {
        ...state,
        cameras: cameras.length ? cameras : [newCamera(1)],
        scanIssues: state.scanIssues.filter((i) => i.cameraId !== a.cameraId),
        version: removed && removed.clips.length ? state.version + 1 : state.version,
        activeCameraId: state.activeCameraId === a.cameraId ? null : state.activeCameraId,
      };
    }
    case 'rename-camera':
      return { ...state, cameras: mapCamera(state, a.cameraId, (c) => ({ ...c, name: a.name || c.name })) };
    case 'scan-start':
      return {
        ...state,
        cameras: mapCamera(state, a.cameraId, (c) => ({ ...c, folders: [...c.folders, a.folder], scanning: { done: 0, total: 0 } })),
      };
    case 'scan-progress':
      // Сообщение о ходе чтения может прийти уже после конца чтения — тогда его не учитываем.
      return { ...state, cameras: mapCamera(state, a.cameraId, (c) => (c.scanning ? { ...c, scanning: { done: a.done, total: a.total } } : c)) };
    case 'scan-done': {
      const cameras = mapCamera(state, a.cameraId, (c) => {
        const known = new Set(c.clips.map((x) => x.path));
        return { ...c, clips: [...c.clips, ...a.clips.filter((x) => !known.has(x.path))], scanning: null };
      });
      // Появилась вторая (третья…) камера с клипами — напоминаем про контрольный кадр.
      const wasEmpty = !state.cameras.find((c) => c.id === a.cameraId)?.clips.length;
      const nowFilled = !!cameras.find((c) => c.id === a.cameraId)?.clips.length;
      const secondCamera = wasEmpty && nowFilled && cameras.filter((c) => c.clips.length).length >= 2;
      return {
        ...state,
        cameras,
        scanIssues: [...state.scanIssues, ...a.issues],
        version: state.version + 1,
        controlHint: secondCamera ? (state.controlHint ?? 0) + 1 : state.controlHint,
      };
    }
    case 'set-trust':
      return { ...state, cameras: mapCamera(state, a.cameraId, (c) => ({ ...c, timecodeTrust: a.trust })), version: state.version + 1 };
    case 'shift-camera':
      // Ручная подгонка не сбрасывает синхронизацию: результат пересчитывается сразу.
      return {
        ...state,
        cameras: mapCamera(state, a.cameraId, (c) => ({
          ...c,
          manualShiftSec: a.absoluteSec !== undefined ? a.absoluteSec : c.manualShiftSec + (a.deltaSec ?? 0),
        })),
      };
    case 'exclude-clips':
      return {
        ...state,
        cameras: mapCamera(state, a.cameraId, (c) => ({ ...c, excludedClipIds: [...new Set([...c.excludedClipIds, ...a.clipIds])] })),
        selectedClipId: a.clipIds.includes(state.selectedClipId ?? '') ? null : state.selectedClipId,
      };
    case 'restore-clips':
      return { ...state, cameras: mapCamera(state, a.cameraId, (c) => ({ ...c, excludedClipIds: [] })) };
    case 'synced': {
      let viewport = state.viewport;
      if (a.fit && a.result.end > a.result.start) {
        const span = a.result.end - a.result.start;
        viewport = { start: a.result.start - span * 0.02, secPerPx: (span * 1.04) / 1100 };
      }
      return {
        ...state,
        sync: a.result,
        syncedVersion: state.version,
        viewport,
        // После синхронизации курсор должен стоять внутри съёмки, а не там, где были клипы до сдвига.
        playhead: !a.result.placements.length
          ? state.playhead
          : state.playhead === null || (a.fit && (state.playhead < a.result.start || state.playhead > a.result.end))
            ? a.result.start
            : state.playhead,
      };
    }
    case 'tab':
      return { ...state, tab: a.tab, faqAnchor: a.faqAnchor ?? null };
    case 'view-mode':
      return { ...state, viewMode: a.mode, activeCameraId: a.cameraId ?? state.activeCameraId };
    case 'select-clip':
      return { ...state, selectedClipId: a.clipId };
    case 'playhead':
      return { ...state, playhead: a.at };
    case 'play':
      return { ...state, playing: a.playing };
    case 'viewport':
      return { ...state, viewport: a.viewport };
    case 'export-open':
      return { ...state, exportOpen: a.open };
    case 'toast':
      toastSeq += 1;
      return { ...state, toasts: [...state.toasts.slice(-2), { id: toastSeq, text: a.text, revealPath: a.revealPath }] };
    case 'toast-dismiss':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== a.id) };
    case 'tools':
      return { ...state, tools: a.tools };
    case 'sync-menu':
      return { ...state, syncMenuOpen: a.open };
    case 'sync-mode':
      return { ...state, syncMode: a.mode };
    case 'audio-start':
      return { ...state, audioRun: { done: 0, total: 0, frac: 0 }, audio: null };
    case 'audio-progress':
      // Оценка оставшейся работы уточняется по ходу; полоса на кнопке назад не откатывается.
      return { ...state, audioRun: { done: a.done, total: a.total, frac: Math.max(state.audioRun?.frac ?? 0, a.total ? Math.min(1, a.done / a.total) : 0) } };
    case 'audio-done':
      return { ...state, audioRun: null, audio: a.result };
    case 'set-control':
      return { ...state, controlFrames: { ...state.controlFrames, [a.frame.clipId]: a.frame }, version: state.version + 1, controlHint: null };
    case 'clear-control': {
      const next = { ...state.controlFrames };
      delete next[a.clipId];
      return { ...state, controlFrames: next, version: state.version + 1 };
    }
    case 'qr-start':
      return { ...state, qrRun: { done: 0, total: a.total } };
    case 'qr-progress':
      return { ...state, qrRun: state.qrRun ? { ...state.qrRun, done: a.done } : null };
    case 'qr-result':
      return { ...state, qrResults: { ...state.qrResults, [a.key]: a.result } };
    case 'qr-done':
      return { ...state, qrRun: null, control: a.control, controlIssues: a.issues, controlPre: a.pre, controlFixed: a.fixed };
    case 'preview':
      return { ...state, previewOn: a.on };
    case 'qr-screen':
      return { ...state, qrScreenOpen: a.open };
    case 'control-hint-close':
      return { ...state, controlHint: null };
    case 'set-audio-assist':
      return { ...state, cameras: mapCamera(state, a.cameraId, (c) => ({ ...c, audioAssist: a.on })), version: state.version + 1 };
    case 'set-follower':
      return { ...state, cameras: mapCamera(state, a.cameraId, (c) => ({ ...c, follower: a.on })), version: state.version + 1 };
  }
}

export function needsSync(s: State): boolean {
  const hasClips = s.cameras.some((c) => c.clips.length > 0);
  return hasClips && s.syncedVersion !== s.version;
}

export function isScanning(s: State): boolean {
  return s.cameras.some((c) => c.scanning !== null);
}

export function canExport(s: State): boolean {
  return !!s.sync && !needsSync(s) && !isScanning(s) && !s.audioRun && !s.qrRun && s.sync.placements.length > 0;
}
