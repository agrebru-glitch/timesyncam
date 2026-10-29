import { contextBridge, ipcRenderer, webUtils } from 'electron';

const api = {
  pickFolders: (): Promise<string[] | null> => ipcRenderer.invoke('dialog:pick-folder'),
  pickFiles: (): Promise<string[] | null> => ipcRenderer.invoke('dialog:pick-files'),
  scanFolder: (scanId: string, folder: string) => ipcRenderer.invoke('scan:folder', scanId, folder),
  onScanProgress: (cb: (p: { scanId: string; done: number; total: number }) => void) => {
    const listener = (_e: unknown, p: { scanId: string; done: number; total: number }) => cb(p);
    ipcRenderer.on('scan:progress', listener);
    return () => ipcRenderer.removeListener('scan:progress', listener);
  },
  onAutoload: (cb: (p: { folders: string[]; sync: boolean; tab?: string; at?: string; menu?: boolean; view?: string; control?: string; mode?: string; qr?: boolean; preview?: string }) => void) => {
    ipcRenderer.on('app:autoload', (_e, p) => cb(p));
  },
  grabFrame: (path: string, seconds: number): Promise<string | null> => ipcRenderer.invoke('media:grab', path, seconds),
  audioFeatures: (path: string, startSec: number, durSec: number) => ipcRenderer.invoke('audio:features', path, startSec, durSec),
  audioSamples: (path: string, startSec: number, durSec: number, channel: number): Promise<Float32Array | null> =>
    ipcRenderer.invoke('audio:samples', path, startSec, durSec, channel),
  waveform: (path: string): Promise<Uint8Array | null> => ipcRenderer.invoke('audio:waveform', path),
  scanQr: (path: string, localSec: number, fps: number, width: number, height: number, durationSec: number) =>
    ipcRenderer.invoke('qr:scan', path, localSec, fps, width, height, durationSec),
  saveExport: (defaultName: string, content: string): Promise<string | null> => ipcRenderer.invoke('export:save', defaultName, content),
  reveal: (path: string) => ipcRenderer.invoke('shell:reveal', path),
  openLink: (name: 'support' | 'github') => ipcRenderer.invoke('shell:open-link', name),
  tools: (): Promise<{ ffprobe: boolean; ffmpeg: boolean }> => ipcRenderer.invoke('app:tools'),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
