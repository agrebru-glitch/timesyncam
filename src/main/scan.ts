// Чтение папки камеры: находит клипы, их сайдкары и прокси, читает метаданные.
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { buildClipMeta } from '../core/clipMeta.ts';
import { parseSonyXml } from '../core/sonyXml.ts';
import type { ClipMeta } from '../core/types.ts';
import { probe } from './ffmpeg.ts';

export const VIDEO_EXT = new Set(['.mp4', '.mov', '.mxf', '.mts', '.m2ts', '.m4v', '.avi', '.mkv', '.3gp', '.mpg', '.insv']);
// Звук рекордеров, телефонов и диктофонов — всё, что читает FFmpeg: WAV/BWF и длинные RF64/W64, M4A (AAC, ALAC),
// MP3/MP2, AAC, FLAC, AIFF, CAF (iPhone), OGG/Opus, WMA, AC3/E-AC3, DTS, AMR (телефоны), WavPack, APE, MKA.
export const AUDIO_EXT = new Set([
  '.wav', '.bwf', '.rf64', '.w64', '.m4a', '.mp3', '.mp2', '.aac', '.flac', '.alac', '.aif', '.aiff', '.aifc', '.caf',
  '.ogg', '.oga', '.opus', '.wma', '.ac3', '.eac3', '.dts', '.amr', '.3ga', '.wv', '.ape', '.mka',
]);
const PROXY_EXT = new Set(['.lrv', '.lrf']);
const NEEDS_SDK_EXT = new Set(['.braw', '.r3d', '.crm', '.ari', '.arx', '.nev']);
const PROXY_DIRS = /^(proxy|proxies|sub|прокси)$/i;
const SKIP_DIRS = /^(\$recycle\.bin|system volume information|\.trashes|\.spotlight-v100|\.fseventsd|thmbnl|cache|\.cache)$/i;
const MAX_DEPTH = 8;
const PROBE_CONCURRENCY = 6;

export interface ScanResult {
  clips: ClipMeta[];
  needsSdk: string[];
  unreadable: string[];
  skipped: string[]; // перетащенные файлы, которые не видео и не звук
  folders: string[]; // откуда клипы: перетащенные папки и папки перетащенных файлов
}

// Сайдкары и служебные файлы камер. Если их перетащили вместе с клипами, молча пропускаем.
const SIDECAR_EXT = new Set([
  '.xml', '.thm', '.jpg', '.jpeg', '.png', '.bim', '.smi', '.ppn', '.cpi', '.mpl', '.bdm', '.xmp', '.ind', '.ini',
  '.txt', '.db', '.srt', '.sav', '.dat', '.bin', '.log', '.cfa', '.pek', '.ttl',
]);

interface Found {
  path: string;
  isProxy: boolean;
  dropped: boolean; // файл перетащили сам по себе, а не нашли в папке
}

async function walk(dir: string, depth: number, inProxyDir: boolean, out: Found[], needsSdk: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH && !SKIP_DIRS.test(e.name)) {
        await walk(full, depth + 1, inProxyDir || PROXY_DIRS.test(e.name), out, needsSdk);
      }
      continue;
    }
    if (e.isFile()) addFile(full, inProxyDir, false, out, needsSdk);
  }
}

// false — файл не видео, не звук и не RAW.
function addFile(full: string, inProxyDir: boolean, dropped: boolean, out: Found[], needsSdk: string[]): boolean {
  const name = basename(full);
  if (name.startsWith('._')) return true; // служебные файлы macOS на картах exFAT
  const ext = extname(name).toLowerCase();
  if (NEEDS_SDK_EXT.has(ext)) {
    needsSdk.push(full);
  } else if (PROXY_EXT.has(ext)) {
    out.push({ path: full, isProxy: true, dropped });
  } else if (VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext)) {
    out.push({ path: full, isProxy: inProxyDir, dropped });
  } else {
    return false;
  }
  return true;
}

// Ключ для сопоставления клипа и его прокси: C0001S03 → C0001, GL010001 → G*010001.
function proxyKey(name: string): string {
  let base = basename(name, extname(name)).toUpperCase();
  base = base.replace(/S03$/, '');
  base = base.replace(/^G[HXLS](\d{6})$/, 'G*$1');
  return base;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function hashId(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `c${(h >>> 0).toString(36)}`;
}

async function findSonyXml(path: string, siblings: Map<string, string[]>): Promise<string | null> {
  const dir = dirname(path);
  const base = basename(path, extname(path)).toUpperCase();
  const names = siblings.get(dir) ?? [];
  const hit = names.find((n) => n.toUpperCase() === `${base}M01.XML`);
  return hit ? join(dir, hit) : null;
}

export interface Collected {
  media: { path: string; proxyPath: string | null }[];
  needsSdk: string[];
  skipped: string[];
  folders: string[];
}

// Что читать из перетащенной пачки: папки обходятся целиком, файлы берутся как есть.
// Прокси (LRV/LRF, папки Sub/Proxy) достаются клипу с тем же именем — с той же карты, если имена повторяются.
// Прокси, перетащенный без своего клипа, читается как обычный клип: маленькое видео лучше, чем ничего.
export async function collectPaths(paths: string[]): Promise<Collected> {
  const found: Found[] = [];
  const needsSdk: string[] = [];
  const skipped: string[] = [];
  const folders = new Set<string>();
  for (const p of new Set(paths)) {
    const st = await stat(p).catch(() => null);
    if (st?.isFile()) {
      folders.add(dirname(p));
      const name = basename(p);
      const known = addFile(p, PROXY_DIRS.test(basename(dirname(p))), true, found, needsSdk);
      if (!known && !name.startsWith('.') && !SIDECAR_EXT.has(extname(name).toLowerCase())) skipped.push(p);
    } else if (st?.isDirectory()) {
      folders.add(p);
      await walk(p, 0, false, found, needsSdk);
    } else {
      skipped.push(p);
    }
  }

  const unique = [...new Map(found.map((f) => [f.path, f])).values()];
  const proxies = new Map<string, string[]>();
  for (const f of unique) if (f.isProxy) proxies.set(proxyKey(f.path), [...(proxies.get(proxyKey(f.path)) ?? []), f.path]);
  const usedProxies = new Set<string>();
  const media = unique.filter((f) => !f.isProxy).map((f) => {
    const candidates = proxies.get(proxyKey(f.path)) ?? [];
    const proxyPath = candidates.reduce<string | null>((best, c) => (best === null || commonPrefix(c, f.path) > commonPrefix(best, f.path) ? c : best), null);
    if (proxyPath) usedProxies.add(proxyPath);
    return { path: f.path, proxyPath };
  });
  for (const f of unique) if (f.isProxy && f.dropped && !usedProxies.has(f.path)) media.push({ path: f.path, proxyPath: null });
  return { media, needsSdk, skipped, folders: [...folders] };
}

// Пачка папок и файлов, перетащенная на одну дорожку, читается одной задачей с общим ходом.
export async function scanPaths(paths: string[], onProgress: (done: number, total: number) => void): Promise<ScanResult> {
  const { media, needsSdk, skipped, folders } = await collectPaths(paths);

  const siblings = new Map<string, string[]>();
  for (const dir of new Set(media.map((m) => dirname(m.path)))) {
    try {
      siblings.set(dir, await readdir(dir));
    } catch {
      siblings.set(dir, []);
    }
  }

  const clips: ClipMeta[] = [];
  const unreadable: string[] = [];
  let done = 0;
  onProgress(0, media.length);

  let next = 0;
  async function worker(): Promise<void> {
    while (next < media.length) {
      const item = media[next++];
      try {
        const st = await stat(item.path);
        const xmlPath = await findSonyXml(item.path, siblings);
        const sony = xmlPath ? parseSonyXml(await readFile(xmlPath, 'utf8')) : null;
        const pr = await probe(item.path);
        if (!pr || !pr.streams?.length) {
          unreadable.push(item.path);
        } else {
          clips.push(buildClipMeta({
            id: hashId(item.path),
            path: item.path,
            name: basename(item.path),
            sizeBytes: st.size,
            mtimeMs: st.mtimeMs,
            probe: pr,
            sony,
            proxyPath: item.proxyPath,
          }));
        }
      } catch {
        unreadable.push(item.path);
      }
      done++;
      onProgress(done, media.length);
    }
  }
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));
  clips.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { clips, needsSdk, unreadable, skipped, folders };
}

// Одна папка или один файл — для проверок из командной строки.
export function scanFolder(folder: string, onProgress: (done: number, total: number) => void): Promise<ScanResult> {
  return scanPaths([folder], onProgress);
}
