import type { ClipMeta } from '../core/types.ts';
import type { AudioJob, AudioSyncResult } from '../core/audioSync.ts';
import type { DriftJob, DriftRendered } from '../core/driftExport.ts';
import type { QrResult } from '../core/qrSync.ts';

export interface ScanResult {
  clips: ClipMeta[];
  needsSdk: string[];
  unreadable: string[];
  skipped: string[];
  folders: string[];
}

export interface Api {
  pickFolders(): Promise<string[] | null>;
  pickFiles(): Promise<string[] | null>;
  scanPaths(scanId: string, paths: string[]): Promise<ScanResult>;
  onScanProgress(cb: (p: { scanId: string; done: number; total: number }) => void): () => void;
  onAutoload(cb: (p: { folders: string[]; sync: boolean; tab?: string; at?: string; menu?: boolean; view?: string; control?: string; mode?: string; qr?: boolean; preview?: string }) => void): void;
  grabFrame(path: string, seconds: number): Promise<string | null>;
  // Сверка по звуку в фоновом потоке. null — сверку остановили.
  syncAudio(job: AudioJob): Promise<AudioSyncResult | null>;
  cancelSync(): Promise<void>;
  onSyncProgress(cb: (p: { done: number; total: number }) => void): () => void;
  waveform(path: string): Promise<Uint8Array | null>;
  scanQr(path: string, localSec: number, fps: number, width: number, height: number, durationSec: number): Promise<{ result: QrResult | null; framesRead: number; framesWithCode: number } | null>;
  saveExport(defaultName: string, content: string): Promise<string | null>;
  // Экспорт с выровненным звуком: выбрать место, сделать копии рядом с ним, записать XML.
  chooseExport(defaultName: string): Promise<string | null>;
  writeExport(path: string, content: string): Promise<string | null>;
  renderDrift(target: string, jobs: DriftJob[]): Promise<DriftRendered[] | null>;
  onDriftProgress(cb: (p: { done: number; total: number }) => void): () => void;
  // Расширенный отчёт для разработчика: ZIP с отчётом, звуком клипов без видео, сведениями о файлах и системе.
  saveExtendedReport(defaultName: string, clips: { camera: string; path: string; audioChannels: number }[], report: string): Promise<string | null>;
  onReportProgress(cb: (p: { done: number; total: number }) => void): () => void;
  reveal(path: string): Promise<void>;
  openLink(name: 'support' | 'github' | 'release'): Promise<void>;
  tools(): Promise<{ ffprobe: boolean; ffmpeg: boolean }>;
  checkUpdate(): Promise<{ version: string } | null>;
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
