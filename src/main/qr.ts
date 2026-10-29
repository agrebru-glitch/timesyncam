// Чтение «Экрана синхронизации» из видео: ffmpeg отдаёт кадры в оттенках серого, jsQR ищет в них QR-код.
import { spawn } from 'node:child_process';
import jsQR from 'jsqr';
import { analyzeQr, parseQrPayload } from '../core/qrSync.ts';
import type { QrFrame, QrResult } from '../core/qrSync.ts';
import { toolPath } from './ffmpeg.ts';

const WINDOW = 4; // секунд по обе стороны от отмеченного кадра
const SCAN_WIDTH = 960;
const PASS1_FPS = 4;

// Кадры по одному, без хранения всего окна в памяти.
function frames(path: string, startSec: number, durSec: number, vf: string, w: number, h: number, onFrame: (i: number, gray: Buffer) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(toolPath('ffmpeg'), ['-v', 'error', '-ss', startSec.toFixed(4), '-t', durSec.toFixed(4), '-i', path, '-an', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { windowsHide: true });
    const size = w * h;
    let buf: Buffer = Buffer.alloc(0);
    let index = 0;
    child.stdout.on('data', (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= size) {
        onFrame(index++, buf.subarray(0, size));
        buf = buf.subarray(size);
      }
    });
    child.on('error', reject);
    child.on('close', () => resolve());
  });
}

function decode(gray: Buffer, w: number, h: number): number | null {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    rgba[j] = rgba[j + 1] = rgba[j + 2] = gray[i];
    rgba[j + 3] = 255;
  }
  const r = jsQR(rgba, w, h, { inversionAttempts: 'attemptBoth' });
  return parseQrPayload(r?.data);
}

export interface QrScan {
  result: QrResult | null;
  framesRead: number;
  framesWithCode: number;
}

export async function scanQr(path: string, localSec: number, fps: number, width: number, height: number, durationSec: number): Promise<QrScan> {
  const w = Math.min(SCAN_WIDTH, width) & ~1;
  const h = Math.round((w * height) / width / 2) * 2;
  const scale = `scale=${w}:${h}:flags=bicubic`;
  const winStart = Math.max(0, localSec - WINDOW);
  const winEnd = Math.min(durationSec, localSec + WINDOW);

  // Проход 1: 4 кадра в секунду — где на экране код и где он меняется.
  const coarse: QrFrame[] = [];
  await frames(path, winStart, winEnd - winStart, `fps=${PASS1_FPS},${scale},format=gray`, w, h, (i, gray) => {
    coarse.push({ t: winStart + i / PASS1_FPS, code: decode(gray, w, h) });
  });
  const spans: [number, number][] = [];
  for (let i = 1; i < coarse.length; i++) {
    const a = coarse[i - 1];
    const b = coarse[i];
    if (a.code === b.code && a.code !== null) continue;
    if (a.code === null && b.code === null) continue;
    const s0 = a.t - 0.3;
    const s1 = b.t + 0.3;
    const last = spans.at(-1);
    if (last && s0 <= last[1]) last[1] = s1;
    else spans.push([s0, s1]);
  }
  const withCode = coarse.filter((f) => f.code !== null).length;
  if (withCode === 0) return { result: null, framesRead: coarse.length, framesWithCode: 0 };

  // Проход 2: каждый кадр, но читаем только около смен кода.
  const k0 = Math.ceil(winStart * fps - 1e-6);
  const start2 = Math.max(0, (k0 - 0.5) / fps);
  const fine: QrFrame[] = [];
  let read = 0;
  await frames(path, start2, winEnd - start2, `${scale},format=gray`, w, h, (i, gray) => {
    const t = (k0 + i) / fps;
    if (!spans.some(([a, b]) => t >= a && t <= b)) return;
    read++;
    fine.push({ t, code: decode(gray, w, h) });
  });
  const all = [...fine, ...coarse.filter((c) => c.code !== null && !spans.some(([a, b]) => c.t >= a && c.t <= b))].sort((x, y) => x.t - y.t);
  return { result: analyzeQr(all, fps), framesRead: coarse.length + read, framesWithCode: all.filter((f) => f.code !== null).length };
}
