import type { Camera, ClipMeta, Issue, SyncResult, TimecodeTrust } from '../core/types.ts';

export type Tab = 'sync' | 'errors' | 'faq';

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
  | { type: 'tools'; tools: { ffprobe: boolean; ffmpeg: boolean } };

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
      return { ...state, cameras: mapCamera(state, a.cameraId, (c) => ({ ...c, scanning: { done: a.done, total: a.total } })) };
    case 'scan-done':
      return {
        ...state,
        cameras: mapCamera(state, a.cameraId, (c) => {
          const known = new Set(c.clips.map((x) => x.path));
          return { ...c, clips: [...c.clips, ...a.clips.filter((x) => !known.has(x.path))], scanning: null };
        }),
        scanIssues: [...state.scanIssues, ...a.issues],
        version: state.version + 1,
      };
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
        playhead: state.playhead ?? (a.result.placements.length ? a.result.start : null),
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
  return !!s.sync && !needsSync(s) && !isScanning(s) && s.sync.placements.length > 0;
}
