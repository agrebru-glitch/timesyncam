import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell } from 'electron';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { AUDIO_EXT, scanPaths, VIDEO_EXT } from './scan.ts';
import { grabFrame, toolsAvailable } from './ffmpeg.ts';
import { audioFeatures, audioSamples, audioWaveform } from './audio.ts';
import { scanQr } from './qr.ts';
import { checkForUpdate } from './update.ts';

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
    icon: join(__dirname, '../icon.png'),
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
        view: process.env.SYNC_VIEW,
        control: process.env.SYNC_CONTROL,
        mode: process.env.SYNC_MODE,
        qr: process.env.SYNC_QR === '1',
        preview: process.env.SYNC_PREVIEW,
      });
    }
    const shot = process.env.SYNC_SHOT;
    if (shot) {
      const delay = Number(process.env.SYNC_SHOT_DELAY ?? 4000);
      setTimeout(async () => {
        // Для проверки меню: правый щелчок в заданной точке окна перед снимком.
        const rc = /^(\d+),(\d+)$/.exec(process.env.SYNC_RCLICK ?? '');
        if (rc) {
          const x = Number(rc[1]);
          const y = Number(rc[2]);
          win!.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
          win!.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
          await new Promise((r) => setTimeout(r, 600));
        }
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

// Отдельные файлы камеры или рекордера — на Windows диалог не умеет выбирать сразу и папки, и файлы.
ipcMain.handle('dialog:pick-files', async () => {
  const r = await dialog.showOpenDialog(win!, {
    properties: ['openFile', 'multiSelections'],
    title: 'Файлы камеры или рекордера',
    filters: [
      { name: 'Видео и звук', extensions: [...VIDEO_EXT, ...AUDIO_EXT].map((e) => e.slice(1)) },
      { name: 'Все файлы', extensions: ['*'] },
    ],
  });
  return r.canceled ? null : r.filePaths;
});

ipcMain.handle('scan:paths', async (event, scanId: string, paths: string[]) => {
  const result = await scanPaths(paths, (done, total) => event.sender.send('scan:progress', { scanId, done, total }));
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

ipcMain.handle('audio:features', async (_e, path: string, startSec: number, durSec: number) => {
  if (!allowedMedia.has(path)) return null;
  return audioFeatures(path, startSec, durSec);
});

ipcMain.handle('audio:samples', async (_e, path: string, startSec: number, durSec: number, channel: number) => {
  if (!allowedMedia.has(path)) return null;
  return audioSamples(path, startSec, durSec, channel);
});

ipcMain.handle('qr:scan', async (_e, path: string, localSec: number, fps: number, width: number, height: number, durationSec: number) => {
  if (!allowedMedia.has(path)) return null;
  return scanQr(path, localSec, fps, width, height, durationSec);
});

ipcMain.handle('audio:waveform', async (_e, path: string) => {
  if (!allowedMedia.has(path)) return null;
  return audioWaveform(path);
});

ipcMain.handle('export:save', async (_e, defaultName: string, content: string) => {
  const r = await dialog.showSaveDialog(win!, {
    title: 'Сохранить таймлинию',
    defaultPath: defaultName,
    filters: defaultName.endsWith('.fcpxml')
      ? [{ name: 'FCPXML (DaVinci Resolve)', extensions: ['fcpxml'] }]
      : [{ name: 'Final Cut Pro 7 XML (Premiere Pro, DaVinci Resolve)', extensions: ['xml'] }],
  });
  if (r.canceled || !r.filePath) return null;
  await writeFile(r.filePath, content, 'utf8');
  return r.filePath;
});

ipcMain.handle('shell:reveal', (_e, path: string) => shell.showItemInFolder(path));

// Внешние ссылки открываются в браузере — только эти, по имени, а не любой адрес из интерфейса.
const LINKS: Record<string, string> = {
  support: 'https://pay.cloudtips.ru/p/17376eab',
  github: 'https://github.com/agrebru-glitch/timesyncam',
  release: 'https://github.com/agrebru-glitch/timesyncam/releases/latest',
};
ipcMain.handle('shell:open-link', (_e, name: string) => {
  const url = LINKS[name];
  if (url) void shell.openExternal(url);
});
ipcMain.handle('app:tools', () => toolsAvailable());

// Новая версия: проверка один раз за запуск, в фоне. Без установки (разработка) и в проверке сборки (SYNC_AUTOLOAD) не идёт.
// SYNC_UPDATE_FROM=0.3.1 включает её с подменённой своей версией — чтобы посмотреть окошко о новой версии.
let updateCheck: Promise<{ version: string } | null> = Promise.resolve(null);
ipcMain.handle('app:update', () => updateCheck);

// Если программу запустили из терминала и закрыли его, запись в консоль падает с EPIPE —
// это не повод показывать пользователю окно с ошибкой.
for (const s of [process.stdout, process.stderr]) s?.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code !== 'EPIPE') throw e;
});

// Windows группирует окна на панели задач по этому имени — со значком TimesynCam, а не Electron.
if (process.platform === 'win32') app.setAppUserModelId('io.github.agrebru-glitch.timesyncam');

// На Mac меню программы всегда на виду в верхней строке экрана — делаем его русским.
// Пункт «Правка» нужен и для ⌘C / ⌘V в полях ввода.
function setMacMenu(): void {
  app.setAboutPanelOptions({
    applicationName: 'TimesynCam',
    applicationVersion: app.getVersion(),
    copyright: '© 2026 Andrey Grebenikov · GPL-3.0',
    website: LINKS.github,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'TimesynCam',
      submenu: [
        { role: 'about', label: 'О программе TimesynCam' },
        { type: 'separator' },
        { role: 'hide', label: 'Скрыть TimesynCam' },
        { role: 'hideOthers', label: 'Скрыть остальные' },
        { role: 'unhide', label: 'Показать все' },
        { type: 'separator' },
        { role: 'quit', label: 'Завершить TimesynCam' },
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Повторить' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Скопировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выбрать все' },
      ],
    },
    {
      label: 'Вид',
      submenu: [{ role: 'togglefullscreen', label: 'Полноэкранный режим' }],
    },
    {
      label: 'Окно',
      submenu: [
        { role: 'minimize', label: 'Свернуть' },
        { role: 'zoom', label: 'Изменить масштаб' },
        { type: 'separator' },
        { role: 'close', label: 'Закрыть окно' },
        { role: 'front', label: 'Все окна — на передний план' },
      ],
    },
    {
      role: 'help',
      label: 'Справка',
      submenu: [{ label: 'TimesynCam на GitHub', click: () => void shell.openExternal(LINKS.github) }],
    },
  ]));
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    setMacMenu();
    // Без установки (npm start) в Dock — значок Electron; ставим свой.
    if (!app.isPackaged) app.dock?.setIcon(join(__dirname, '../icon.png'));
  }
  registerMediaProtocol();
  const from = process.env.SYNC_UPDATE_FROM;
  if (from || (app.isPackaged && !process.env.SYNC_AUTOLOAD)) updateCheck = checkForUpdate(from ?? app.getVersion());
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
