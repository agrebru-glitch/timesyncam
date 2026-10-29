import { contextBridge, ipcRenderer, webUtils } from 'electron';

const api = {
  pickFolders: (): Promise<string[] | null> => ipcRenderer.invoke('dialog:pick-folder'),
  scanFolder: (scanId: string, folder: string) => ipcRenderer.invoke('scan:folder', scanId, folder),
  onScanProgress: (cb: (p: { scanId: string; done: number; total: number }) => void) => {
    const listener = (_e: unknown, p: { scanId: string; done: number; total: number }) => cb(p);
    ipcRenderer.on('scan:progress', listener);
    return () => ipcRenderer.removeListener('scan:progress', listener);
  },
  onAutoload: (cb: (p: { folders: string[]; sync: boolean; tab?: string; at?: string; menu?: boolean }) => void) => {
    ipcRenderer.on('app:autoload', (_e, p) => cb(p));
  },
  grabFrame: (path: string, seconds: number): Promise<string | null> => ipcRenderer.invoke('media:grab', path, seconds),
  audioEnvelope: (path: string, startSec: number, durSec: number): Promise<{ env: Float32Array; peakDb: number } | null> =>
    ipcRenderer.invoke('audio:envelope', path, startSec, durSec),
  saveExport: (defaultName: string, content: string): Promise<string | null> => ipcRenderer.invoke('export:save', defaultName, content),
  reveal: (path: string) => ipcRenderer.invoke('shell:reveal', path),
  tools: (): Promise<{ ffprobe: boolean; ffmpeg: boolean }> => ipcRenderer.invoke('app:tools'),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
