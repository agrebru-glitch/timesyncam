// Волны клипов для таймлинии: загружаются в фоне по одной-две, таймлиния перерисовывается по мере готовности.
import { useSyncExternalStore } from 'react';
import type { ClipMeta } from '../core/types.ts';
import { api } from './api.ts';

const waves = new Map<string, Uint8Array>();
const queued = new Set<string>();
const queue: ClipMeta[] = [];
const listeners = new Set<() => void>();
let version = 0;
let running = 0;
const CONCURRENCY = 2;

function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

async function pump(): Promise<void> {
  while (running < CONCURRENCY && queue.length) {
    const clip = queue.shift()!;
    running++;
    void api.waveform(clip.path).then((w) => {
      if (w) {
        waves.set(clip.id, w);
        notify();
      }
    }).catch(() => undefined).finally(() => {
      running--;
      void pump();
    });
  }
}

export function requestWaveforms(clips: ClipMeta[]): void {
  for (const c of clips) {
    if (c.audioChannels === 0 || c.captureFps !== null || queued.has(c.id)) continue;
    queued.add(c.id);
    queue.push(c);
  }
  void pump();
}

export function getWaveform(clipId: string): Uint8Array | undefined {
  return waves.get(clipId);
}

export function useWaveformVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
}
