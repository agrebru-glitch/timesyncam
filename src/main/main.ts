import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { scanFolder } from './scan.ts';
import { grabFrame, toolsAvailable } from './ffmpeg.ts';
import { audioEnvelope } from './audio.ts';

// Встроенный плеер получает доступ только к файлам, которые программа сама нашла при сканировании.
const allowedMedia = new Set<string>();

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { stream: true, supportFetchAPI: true, bypassCSP: true, standard: true, secure: true } },
]);

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.lrv': 'video/mp4', '.lrf': 'video/mp4',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.wav': 'audio/wav',
};

function registerMediaProtocol(): void {
  protocol.handle('media', async (request) => {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!allowedMedia.has(path)) return new Response('Forbidden', { status: 403 });
    const st = await stat(path);
    const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
    const range = request.headers.get('range');
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }
    const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
    return new Response(stream, { headers: { 'Content-Type': type, 'Content-Length': String(st.size), 'Accept-Ranges': 'bytes' } });
  });
}

let win: BrowserWindow | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#17181b',
    autoHideMenuBar: true,
    title: 'TimesynCam',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.SYNC_DEV_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));

  win.webContents.on('did-finish-load', () => {
    const auto = process.env.SYNC_AUTOLOAD;
    if (auto) {
      win?.webContents.send('app:autoload', {
        folders: auto.split('|'),
        sync: process.env.SYNC_AUTOSYNC === '1',
        tab: process.env.SYNC_TAB,
        at: process.env.SYNC_PLAYHEAD,
        menu: process.env.SYNC_MENU === '1',
      });
    }
    const shot = process.env.SYNC_SHOT;
    if (shot) {
      const delay = Number(process.env.SYNC_SHOT_DELAY ?? 4000);
      setTimeout(async () => {
        const img = await win!.webContents.capturePage();
        await writeFile(shot, img.toPNG());
        app.quit();
      }, delay);
    }
  });
}

ipcMain.handle('dialog:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'multiSelections'], title: 'Папка с клипами камеры' });
  return r.canceled ? null : r.filePaths;
});

ipcMain.handle('scan:folder', async (event, scanId: string, folder: string) => {
  const result = await scanFolder(folder, (done, total) => event.sender.send('scan:progress', { scanId, done, total }));
  for (const c of result.clips) {
    allowedMedia.add(c.path);
    if (c.proxyPath) allowedMedia.add(c.proxyPath);
  }
  return result;
});

ipcMain.handle('media:grab', async (_e, path: string, seconds: number) => {
  if (!allowedMedia.has(path)) return null;
  return grabFrame(path, seconds);
});

ipcMain.handle('audio:envelope', async (_e, path: string, startSec: number, durSec: number) => {
  if (!allowedMedia.has(path)) return null;
  return audioEnvelope(path, startSec, durSec);
});

ipcMain.handle('export:save', async (_e, defaultName: string, content: string) => {
  const r = await dialog.showSaveDialog(win!, {
    title: 'Сохранить таймлинию',
    defaultPath: defaultName,
    filters: [{ name: 'Final Cut Pro 7 XML (Premiere Pro, DaVinci Resolve)', extensions: ['xml'] }],
  });
  if (r.canceled || !r.filePath) return null;
  await writeFile(r.filePath, content, 'utf8');
  return r.filePath;
});

ipcMain.handle('shell:reveal', (_e, path: string) => shell.showItemInFolder(path));
ipcMain.handle('app:tools', () => toolsAvailable());

app.whenReady().then(() => {
  registerMediaProtocol();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
