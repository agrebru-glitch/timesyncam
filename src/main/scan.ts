// Чтение папки камеры: находит клипы, их сайдкары и прокси, читает метаданные.
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { buildClipMeta } from '../core/clipMeta.ts';
import { parseSonyXml } from '../core/sonyXml.ts';
import type { ClipMeta } from '../core/types.ts';
import { probe } from './ffmpeg.ts';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mxf', '.mts', '.m2ts', '.m4v', '.avi', '.mkv', '.3gp', '.mpg', '.insv']);
const AUDIO_EXT = new Set(['.wav', '.bwf']);
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
}

interface Found {
  path: string;
  isProxy: boolean;
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
    if (!e.isFile() || e.name.startsWith('._')) continue;
    const ext = extname(e.name).toLowerCase();
    if (NEEDS_SDK_EXT.has(ext)) {
      needsSdk.push(full);
    } else if (PROXY_EXT.has(ext)) {
      out.push({ path: full, isProxy: true });
    } else if (VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext)) {
      out.push({ path: full, isProxy: inProxyDir });
    }
  }
}

// Ключ для сопоставления клипа и его прокси: C0001S03 → C0001, GL010001 → G*010001.
function proxyKey(name: string): string {
  let base = basename(name, extname(name)).toUpperCase();
  base = base.replace(/S03$/, '');
  base = base.replace(/^G[HXLS](\d{6})$/, 'G*$1');
  return base;
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

export async function scanFolder(folder: string, onProgress: (done: number, total: number) => void): Promise<ScanResult> {
  const found: Found[] = [];
  const needsSdk: string[] = [];
  await walk(folder, 0, false, found, needsSdk);

  const proxies = new Map<string, string>();
  for (const f of found) if (f.isProxy) proxies.set(proxyKey(f.path), f.path);
  const media = found.filter((f) => !f.isProxy);

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
            proxyPath: proxies.get(proxyKey(item.path)) ?? null,
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
  return { clips, needsSdk, unreadable };
}
