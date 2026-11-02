// Расширенный отчёт для разработчика — один ZIP-архив: отчёт программы, звук каждого клипа без видео
// (сжатый Opus), сведения о файлах, служебные файлы камер (XML Sony и подобные) и сведения о системе.
// По нему можно разобрать сверку на настоящей съёмке, не пересылая видео. Полных путей на диске в архиве нет:
// только имена папок и файлов. Промежуточная папка удаляется, когда архив готов.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { arch, cpus, freemem, platform, release, tmpdir, totalmem } from 'node:os';
import { basename, dirname, extname, join, relative } from 'node:path';
import { isXavc } from '../core/clipMeta.ts';
import type { FfprobeResult } from '../core/clipMeta.ts';
import { privacyMask } from '../core/mp4Boxes.ts';
import { runTool } from './ffmpeg.ts';
import { readBoxMap, readEmbeddedSonyXml } from './mp4File.ts';
import { writeZip } from './zip.ts';

const BOX_EXT = new Set(['.mp4', '.mov', '.m4v', '.3gp', '.insv', '.m4a']);

export interface MaterialClip {
  camera: string; // имя дорожки
  path: string;
  audioChannels: number;
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').trim() || 'без имени';

const README = `Расширенный отчёт TimesynCam

Здесь нет видео — только звук каждого клипа (сжатый, формат Opus), сведения о файлах,
служебные файлы камер (XML) и сведения о компьютере. По ним разработчик разберёт,
как программа синхронизировала съёмку. Отправьте этот архив разработчику целиком.

report.json — отчёт программы: клипы, их время, раскладка, решения сверки по звуку, сообщения.
system.json — версия программы, Windows, процессор, память, версия FFmpeg.
Папки — по дорожкам программы: <файл>.opus — звук, <файл>.ffprobe.json — сведения о файле,
<файл>.boxes.json — устройство файла MP4/MOV (где камера хранит время), XML — служебные файлы камеры,
лежавшие рядом с клипом, <файл>.nrtm.xml — такой же XML Sony изнутри файла, если рядом его не было.
Серийные номера и координаты съёмки убраны.
`;

// Версия первой строкой: «ffmpeg version n9.0 ...».
async function toolVersion(name: 'ffmpeg' | 'ffprobe'): Promise<string> {
  try {
    const r = await runTool(name, ['-version'], 10000);
    return r.stdout.toString('utf8').split(/\r?\n/)[0] ?? '';
  } catch {
    return 'нет';
  }
}

async function filesIn(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesIn(p)));
    else out.push(p);
  }
  return out;
}

export async function extendedReport(outZip: string, appVersion: string, clips: MaterialClip[], report: string, onProgress: (done: number, total: number) => void): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'timesyncam-report-'));
  try {
    await writeFile(join(tmp, 'system.json'), JSON.stringify({
      app: appVersion,
      os: `${platform()} ${release()} ${arch()}`,
      cpu: `${cpus()[0]?.model ?? ''} × ${cpus().length}`,
      memoryGb: { total: +(totalmem() / 2 ** 30).toFixed(1), free: +(freemem() / 2 ** 30).toFixed(1) },
      ffmpeg: await toolVersion('ffmpeg'),
      ffprobe: await toolVersion('ffprobe'),
    }, null, 1), 'utf8');
    await collectMaterials(tmp, clips, report, (done, total) => onProgress(done, total + 1));
    const files = await filesIn(tmp);
    await writeZip(outZip, files.map((p) => ({ name: relative(tmp, p), path: p })));
    onProgress(clips.length + 1, clips.length + 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function collectMaterials(outDir: string, clips: MaterialClip[], report: string, onProgress: (done: number, total: number) => void): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'report.json'), report, 'utf8');
  await writeFile(join(outDir, 'Прочитайте.txt'), README, 'utf8');
  let done = 0;
  onProgress(done, clips.length);
  const sidecarsSeen = new Set<string>();
  const mask = privacyMask(randomBytes(8).toString('hex'));
  for (const c of clips) {
    const dir = join(outDir, safe(c.camera));
    await mkdir(dir, { recursive: true });
    const name = basename(c.path);
    // Сведения о файле — без строки с полным путём и без координат съёмки (телефоны пишут их в теги).
    let info: FfprobeResult & { format?: { filename?: string } } = {};
    try {
      const r = await runTool('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', c.path], 60000);
      if (r.code === 0) {
        info = JSON.parse(r.stdout.toString('utf8'));
        if (info.format) info.format.filename = name;
        for (const tags of [info.format?.tags, ...(info.streams ?? []).map((s) => s.tags)]) {
          for (const k of Object.keys(tags ?? {})) if (/location|gps/i.test(k)) tags![k] = '…';
        }
        await writeFile(join(dir, `${name}.ffprobe.json`), JSON.stringify(info, null, 1), 'utf8');
      }
    } catch {
      // сведения необязательны
    }
    // Звук: тот же канал или два, как в клипе, — программа сама выбирает более чистый. Без тегов файла: ffmpeg
    // переносит их в Opus, а телефоны пишут туда координаты съёмки.
    if (c.audioChannels > 0) {
      await runTool('ffmpeg', ['-v', 'error', '-y', '-i', c.path, '-vn', '-map', '0:a:0', '-map_metadata', '-1', '-map_metadata:s:a', '-1', '-ac', String(Math.min(2, c.audioChannels)), '-c:a', 'libopus', '-b:a', '48k', join(dir, `${name}.opus`)], 30 * 60 * 1000);
    }
    // Служебные файлы камеры рядом с клипом: C0001M01.XML, C0001.XML и подобные.
    let sidecarXml = false;
    try {
      const stem = basename(c.path, extname(c.path)).toLowerCase();
      for (const f of await readdir(dirname(c.path))) {
        const low = f.toLowerCase();
        if (!/\.(xml|xmp)$/.test(low) || !low.startsWith(stem)) continue;
        if (low.endsWith('.xml')) sidecarXml = true;
        const src = join(dirname(c.path), f);
        if (sidecarsSeen.has(src)) continue;
        sidecarsSeen.add(src);
        await writeFile(join(dir, f), mask(await readFile(src, 'utf8')), 'utf8');
      }
    } catch {
      // служебных файлов может не быть
    }
    // XML Sony внутри MP4 — если рядом с клипом его не было: по нему стресс-проверка восстановит тайм-код и время.
    if (!sidecarXml && isXavc(info)) {
      const xml = await readEmbeddedSonyXml(c.path);
      if (xml) await writeFile(join(dir, `${name}.nrtm.xml`), mask(xml), 'utf8');
    }
    // Карта коробок MP4/MOV — где камера хранит время и метаданные. По ней разбирается незнакомая камера без видео.
    if (BOX_EXT.has(extname(c.path).toLowerCase())) {
      const map = await readBoxMap(c.path, mask);
      if (map) await writeFile(join(dir, `${name}.boxes.json`), JSON.stringify(map, null, 1), 'utf8');
    }
    done++;
    onProgress(done, clips.length);
  }
}
