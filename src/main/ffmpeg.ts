import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FfprobeResult } from '../core/clipMeta.ts';

// ffprobe/ffmpeg: сначала рядом с программой (bin), потом в PATH.
// Программа, запущенная на Mac из Finder, не видит PATH терминала — поэтому папки Homebrew проверяем сами.
function resolveTool(name: 'ffprobe' | 'ffmpeg'): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'bin', exe) : '',
    join(process.cwd(), 'bin', exe),
    ...(process.platform === 'darwin' ? [`/opt/homebrew/bin/${exe}`, `/usr/local/bin/${exe}`] : []),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return exe;
}

const FFPROBE = resolveTool('ffprobe');
const FFMPEG = resolveTool('ffmpeg');

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 4000) err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

export function toolPath(name: 'ffmpeg' | 'ffprobe'): string {
  return name === 'ffmpeg' ? FFMPEG : FFPROBE;
}

export function runTool(name: 'ffmpeg' | 'ffprobe', args: string[], timeoutMs: number) {
  return run(name === 'ffmpeg' ? FFMPEG : FFPROBE, args, timeoutMs);
}

export async function toolsAvailable(): Promise<{ ffprobe: boolean; ffmpeg: boolean }> {
  const check = async (cmd: string) => {
    try {
      const r = await run(cmd, ['-version'], 5000);
      return r.code === 0;
    } catch {
      return false;
    }
  };
  const [ffprobe, ffmpeg] = await Promise.all([check(FFPROBE), check(FFMPEG)]);
  return { ffprobe, ffmpeg };
}

export async function probe(path: string): Promise<FfprobeResult | null> {
  try {
    const r = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], 30000);
    if (r.code !== 0) return null;
    return JSON.parse(r.stdout.toString('utf8')) as FfprobeResult;
  } catch {
    return null;
  }
}

// Стоп-кадр для предпросмотра: ffmpeg декодирует то, что не умеет встроенный плеер (4:2:2 10-bit, ProRes, MXF).
export async function grabFrame(path: string, seconds: number, width = 960): Promise<string | null> {
  const t = Math.max(0, seconds).toFixed(3);
  try {
    const r = await run(
      FFMPEG,
      ['-v', 'error', '-ss', t, '-i', path, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'],
      20000,
    );
    if (r.code !== 0 || r.stdout.length === 0) return null;
    return `data:image/jpeg;base64,${r.stdout.toString('base64')}`;
  } catch {
    return null;
  }
}
