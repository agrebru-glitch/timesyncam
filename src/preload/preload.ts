import { contextBridge, ipcRenderer, webUtils } from 'electron';

const api = {
  pickFolders: (): Promise<string[] | null> => ipcRenderer.invoke('dialog:pick-folder'),
  pickFiles: (): Promise<string[] | null> => ipcRenderer.invoke('dialog:pick-files'),
  scanPaths: (scanId: string, paths: string[]) => ipcRenderer.invoke('scan:paths', scanId, paths),
  onScanProgress: (cb: (p: { scanId: string; done: number; total: number }) => void) => {
    const listener = (_e: unknown, p: { scanId: string; done: number; total: number }) => cb(p);
    ipcRenderer.on('scan:progress', listener);
    return () => ipcRenderer.removeListener('scan:progress', listener);
  },
  onAutoload: (cb: (p: { folders: string[]; sync: boolean; tab?: string; at?: string; menu?: boolean; view?: string; control?: string; mode?: string; qr?: boolean; preview?: string }) => void) => {
    ipcRenderer.on('app:autoload', (_e, p) => cb(p));
  },
  grabFrame: (path: string, seconds: number): Promise<string | null> => ipcRenderer.invoke('media:grab', path, seconds),
  syncAudio: (job: unknown) => ipcRenderer.invoke('sync:audio', job),
  cancelSync: () => ipcRenderer.invoke('sync:cancel'),
  onSyncProgress: (cb: (p: { done: number; total: number }) => void) => {
    const listener = (_e: unknown, p: { done: number; total: number }) => cb(p);
    ipcRenderer.on('sync:progress', listener);
    return () => ipcRenderer.removeListener('sync:progress', listener);
  },
  waveform: (path: string, audioStartSec: number): Promise<Uint8Array | null> => ipcRenderer.invoke('audio:waveform', path, audioStartSec),
  scanQr: (path: string, localSec: number, fps: number, width: number, height: number, durationSec: number) =>
    ipcRenderer.invoke('qr:scan', path, localSec, fps, width, height, durationSec),
  saveExport: (defaultName: string, content: string): Promise<string | null> => ipcRenderer.invoke('export:save', defaultName, content),
  chooseExport: (defaultName: string): Promise<string | null> => ipcRenderer.invoke('export:choose', defaultName),
  writeExport: (path: string, content: string): Promise<string | null> => ipcRenderer.invoke('export:write', path, content),
  renderDrift: (target: string, jobs: unknown) => ipcRenderer.invoke('drift:render', target, jobs),
  onDriftProgress: (cb: (p: { done: number; total: number }) => void) => {
    const listener = (_e: unknown, p: { done: number; total: number }) => cb(p);
    ipcRenderer.on('drift:progress', listener);
    return () => ipcRenderer.removeListener('drift:progress', listener);
  },
  saveExtendedReport: (defaultName: string, clips: { camera: string; path: string; audioChannels: number }[], report: string): Promise<string | null> =>
    ipcRenderer.invoke('report:extended', defaultName, clips, report),
  onReportProgress: (cb: (p: { done: number; total: number }) => void) => {
    const listener = (_e: unknown, p: { done: number; total: number }) => cb(p);
    ipcRenderer.on('report:progress', listener);
    return () => ipcRenderer.removeListener('report:progress', listener);
  },
  reveal: (path: string) => ipcRenderer.invoke('shell:reveal', path),
  openLink: (name: 'support' | 'github' | 'release' | 'telegram') => ipcRenderer.invoke('shell:open-link', name),
  tools: (): Promise<{ ffprobe: boolean; ffmpeg: boolean }> => ipcRenderer.invoke('app:tools'),
  checkUpdate: (): Promise<{ version: string } | null> => ipcRenderer.invoke('app:update'),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
