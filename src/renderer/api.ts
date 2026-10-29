import type { ClipMeta } from '../core/types.ts';

export interface ScanResult {
  clips: ClipMeta[];
  needsSdk: string[];
  unreadable: string[];
}

export interface Api {
  pickFolders(): Promise<string[] | null>;
  scanFolder(scanId: string, folder: string): Promise<ScanResult>;
  onScanProgress(cb: (p: { scanId: string; done: number; total: number }) => void): () => void;
  onAutoload(cb: (p: { folders: string[]; sync: boolean; tab?: string; at?: string; menu?: boolean; view?: string }) => void): void;
  grabFrame(path: string, seconds: number): Promise<string | null>;
  audioEnvelope(path: string, startSec: number, durSec: number): Promise<{ env: Float32Array; peakDb: number } | null>;
  waveform(path: string): Promise<Uint8Array | null>;
  saveExport(defaultName: string, content: string): Promise<string | null>;
  reveal(path: string): Promise<void>;
  tools(): Promise<{ ffprobe: boolean; ffmpeg: boolean }>;
  pathForFile(file: File): string;
}

declare global {
  interface Window {
    api: Api;
  }
}

export const api: Api = window.api;

export function mediaUrl(path: string): string {
  return `media://local/${encodeURIComponent(path)}`;
}

export const CAMERA_COLORS = ['#3d8bfd', '#b07cff', '#2fc6b4', '#ff8a4c', '#e86bb0', '#9bc53d', '#f2b544', '#6fa8ff'];

export function cameraColor(index: number): string {
  return CAMERA_COLORS[index % CAMERA_COLORS.length];
}
