import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import type { Dispatch } from 'react';
import type { Issue, Placement } from '../core/types.ts';
import { pilePlacements, runSync } from '../core/sync.ts';
import { heardCameras, refineByAudio } from '../core/audioSync.ts';
import { controlCorrections } from '../core/qrSync.ts';
import type { ControlFrame, QrResult } from '../core/qrSync.ts';
import { defaultTimelineRate } from '../core/fcp7.ts';
import { rateValue } from '../core/timecode.ts';
import { pluralRu } from '../core/format.ts';
import { api } from './api.ts';
import { canExport, initialState, isScanning, needsSync, newCamera, reducer } from './state.ts';
import type { Action, ControlInfo, State, SyncMode } from './state.ts';
import { QrScreen } from './components/QrScreen.tsx';
import { SyncMenu } from './components/SyncMenu.tsx';
import { requestWaveforms } from './waveforms.ts';
import { IconExport, IconHeart, IconLock, IconQr, IconSync, IconX, LogoMark } from './icons.tsx';
import { CameraPanel } from './components/CameraPanel.tsx';
import { Viewer } from './components/Viewer.tsx';
import { Timeline } from './components/Timeline.tsx';
import { ErrorsPage } from './components/ErrorsPage.tsx';
import { FaqPage } from './components/FaqPage.tsx';
import { ExportDialog } from './components/ExportDialog.tsx';
import { isMac } from './platform.ts';

interface Ctx {
  state: State;
  dispatch: Dispatch<Action>;
  placements: Placement[];
  synced: boolean;
  issues: Issue[];
  fps: number;
  addFolders: (cameraId: string | null, folders: string[]) => Promise<void>;
  doSync: (mode?: SyncMode) => void;
}

const MODE_KEY = 'timesyncam.syncMode';
function savedMode(): SyncMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === 'timecode' || v === 'control' ? v : 'audio';
  } catch {
    return 'audio';
  }
}

export const PREVIEW_KEY = 'timesyncam.preview';
function savedPreview(): boolean {
  try {
    return localStorage.getItem(PREVIEW_KEY) !== '0';
  } catch {
    return true;
  }
}

const AppContext = createContext<Ctx | null>(null);
export function useApp(): Ctx {
  const c = useContext(AppContext);
  if (!c) throw new Error('AppContext');
  return c;
}

let scanIssueSeq = 0;
let controlIssueSeq = 0;

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState, (s) => ({ ...s, syncMode: savedMode(), previewOn: savedPreview() }));
  const stateRef = useRef(state);
  stateRef.current = state;

  const synced = !!state.sync && !needsSync(state);
  const placements = useMemo(
    () => (synced && state.sync ? state.sync.placements : pilePlacements(state.cameras)),
    [synced, state.sync, state.cameras],
  );
  const issues = useMemo(() => {
    const list = [...state.scanIssues, ...(synced && state.sync ? state.sync.issues : []), ...(synced && state.audio ? state.audio.issues : []), ...(synced ? state.controlIssues : [])];
    if (state.tools && !state.tools.ffprobe) {
      list.unshift({
        id: 'tools', severity: 'error', cameraId: null,
        title: 'Не найден ffprobe — программа не может читать клипы',
        details: isMac
          ? 'Переустановите программу из образа .dmg с GitHub — FFmpeg входит в него. Или установите FFmpeg (например, brew install ffmpeg).'
          : 'Положите ffprobe.exe и ffmpeg.exe в папку bin рядом с программой или установите FFmpeg и добавьте его в PATH.',
        actions: [],
      });
    }
    const order = { error: 0, warning: 1, info: 2 };
    return list.sort((a, b) => order[a.severity] - order[b.severity]);
  }, [state.scanIssues, state.sync, state.audio, state.controlIssues, synced, state.tools]);
  const fps = useMemo(() => rateValue(defaultTimelineRate(state.cameras)), [state.cameras]);

  const addFolders = useCallback(async (cameraId: string | null, folders: string[]) => {
    let targetId = cameraId;
    if (!targetId) {
      const cam = newCamera(stateRef.current.cameras.length + 1);
      dispatch({ type: 'add-camera', camera: cam });
      targetId = cam.id;
    }
    for (const folder of folders) {
      dispatch({ type: 'scan-start', cameraId: targetId, folder });
      const res = await api.scanFolder(targetId, folder);
      const camName = stateRef.current.cameras.find((c) => c.id === targetId)?.name ?? 'Камера';
      const scanIssues: Issue[] = [];
      if (res.needsSdk.length) {
        scanIssueSeq += 1;
        scanIssues.push({
          id: `s${scanIssueSeq}`, severity: 'warning', cameraId: targetId,
          title: `«${camName}»: ${pluralRu(res.needsSdk.length, 'файл', 'файла', 'файлов')} в формате, который пока не читается`,
          details: `${res.needsSdk.slice(0, 4).map((p) => p.split(/[\\/]/).pop()).join(', ')}${res.needsSdk.length > 4 ? '…' : ''}. BRAW, R3D, Canon RAW и ARRIRAW нужно сначала перегнать в ProRes или MP4 с сохранением тайм-кода.`,
          actions: [{ kind: 'open-faq', anchor: 'raw' }],
        });
      }
      if (res.unreadable.length) {
        scanIssueSeq += 1;
        scanIssues.push({
          id: `s${scanIssueSeq}`, severity: 'error', cameraId: targetId,
          title: `«${camName}»: не удалось прочитать ${pluralRu(res.unreadable.length, 'файл', 'файла', 'файлов')}`,
          details: `${res.unreadable.slice(0, 4).map((p) => p.split(/[\\/]/).pop()).join(', ')}${res.unreadable.length > 4 ? '…' : ''}. Файлы могут быть повреждены или недокопированы.`,
          actions: [],
        });
      }
      if (res.clips.length === 0 && !res.needsSdk.length && !res.unreadable.length) {
        scanIssueSeq += 1;
        scanIssues.push({
          id: `s${scanIssueSeq}`, severity: 'warning', cameraId: targetId,
          title: res.isFile
            ? `«${camName}»: ${folder.split(/[\\/]/).pop()} — не видео и не звук`
            : `«${camName}»: в папке не нашлось видео и звука`,
          details: res.isFile ? `${folder}. Программа читает видео MP4, MOV, MXF, MTS, AVI, MKV и звук WAV, M4A, MP3, AAC, FLAC, AIFF, OGG, Opus, WMA и другие.` : folder,
          actions: [],
        });
      }
      dispatch({ type: 'scan-done', cameraId: targetId, clips: res.clips, issues: scanIssues });
      requestWaveforms(res.clips);
    }
  }, []);

  // Синхронизация: тайм-код и часы; в режиме с контрольным кадром — сначала экран синхронизации;
  // затем — если выбрано — сверка по звуку.
  const doSync = useCallback(async (mode?: SyncMode) => {
    const s = stateRef.current;
    if (isScanning(s) || s.audioRun || s.qrRun) return;
    const chosen = mode ?? s.syncMode;
    dispatch({ type: 'sync-menu', open: false });
    dispatch({ type: 'control-hint-close' });
    if (mode) {
      dispatch({ type: 'sync-mode', mode });
      try {
        localStorage.setItem(MODE_KEY, mode);
      } catch {
        // запоминать режим необязательно
      }
    }
    const cameras = s.cameras;
    const version = s.version;
    const coarse = runSync(cameras);
    dispatch({ type: 'synced', result: coarse, fit: true });
    const noFfmpeg = stateRef.current.tools?.ffmpeg === false;

    // Контрольные кадры: читаем экран синхронизации.
    let pre: Record<string, number> = {};
    let fixed = new Set<string>();
    let controlClips = new Set<string>();
    const frames = Object.values(s.controlFrames).filter((f) => cameras.some((c) => c.id === f.cameraId && c.clips.some((x) => x.id === f.clipId)));
    if (chosen === 'control' && frames.length && !noFfmpeg) {
      dispatch({ type: 'qr-start', total: frames.length });
      const found: { frame: ControlFrame; result: QrResult }[] = [];
      const qrIssues: Issue[] = [];
      for (const [i, f] of frames.entries()) {
        const cam = cameras.find((c) => c.id === f.cameraId)!;
        const clip = cam.clips.find((c) => c.id === f.clipId)!;
        const key = `${clip.id}@${f.localSec.toFixed(2)}`;
        let result = stateRef.current.qrResults[key];
        if (result === undefined && clip.rate && clip.width && clip.height) {
          result = (await api.scanQr(clip.path, f.localSec, rateValue(clip.rate), clip.width, clip.height, clip.durationSec))?.result ?? null;
          dispatch({ type: 'qr-result', key, result });
        }
        dispatch({ type: 'qr-progress', done: i + 1 });
        controlIssueSeq += 1;
        if (!result) {
          qrIssues.push({
            id: `q${controlIssueSeq}`, severity: 'warning', cameraId: cam.id, clipId: clip.id,
            title: `«${cam.name}»: в контрольном кадре ${clip.name} экран синхронизации не найден`,
            details: 'Проверьте, что QR-код целиком в кадре, не смазан и без бликов, и что отмечен кадр, где экран виден. Камера осталась по тайм-коду и звуку.',
            actions: [{ kind: 'show-clip', clipId: clip.id }, { kind: 'open-faq', anchor: 'qr-screen' }],
          });
          continue;
        }
        found.push({ frame: f, result });
        if (result.transitions === 0) {
          qrIssues.push({
            id: `q${controlIssueSeq}`, severity: 'info', cameraId: cam.id, clipId: clip.id,
            title: `«${cam.name}»: экран синхронизации снят меньше секунды`,
            details: 'Код прочитан, но его смены не видно, поэтому точность — около полсекунды. Снимайте экран 5–10 секунд — тогда точность будет до четверти кадра.',
            actions: [{ kind: 'open-faq', anchor: 'qr-screen' }],
          });
        }
      }
      const clockOnly = new Set(coarse.cameras.filter((c) => c.timeSource === 'clock').map((c) => c.cameraId));
      const outcome = controlCorrections(found, coarse.placements, clockOnly);
      pre = outcome.pre;
      fixed = outcome.fixed;
      controlClips = outcome.clips;
      const info: Record<string, ControlInfo> = {};
      for (const [camId, c] of outcome.cameras) info[camId] = c;
      dispatch({ type: 'qr-done', control: info, issues: qrIssues, pre, fixed: [...fixed] });
    } else {
      dispatch({ type: 'qr-done', control: null, issues: [], pre: {}, fixed: [] });
    }

    if (chosen === 'timecode' || noFfmpeg) {
      dispatch({ type: 'audio-done', result: null });
      if (Object.keys(pre).length) dispatch({ type: 'synced', result: runSync(cameras, pre, fixed), fit: true });
      return;
    }
    dispatch({ type: 'audio-start' });
    try {
      const audio = await refineByAudio(cameras, coarse, {
        features: (clip, start, dur) => api.audioFeatures(clip.path, start, dur),
        samples: (clip, start, dur, ch) => api.audioSamples(clip.path, start, dur, ch),
      }, {
        searchSec: 10,
        maxAnchors: 8,
        isEnabled: (id) => cameras.find((c) => c.id === id)?.audioAssist ?? true,
        followers: new Set(cameras.filter((c) => c.follower).map((c) => c.id)),
        onProgress: (done, total) => dispatch({ type: 'audio-progress', done, total }),
        pre,
        fixed,
        controlClips,
      });
      if (stateRef.current.version !== version) {
        dispatch({ type: 'audio-done', result: null });
        return;
      }
      dispatch({ type: 'audio-done', result: audio });
      // Звук и контрольные кадры могли передвинуть камеры на часы — заново показываем всю съёмку.
      dispatch({ type: 'synced', result: runSync(stateRef.current.cameras, audio.corrections, new Set([...heardCameras(audio), ...fixed])), fit: true });
    } catch {
      dispatch({ type: 'audio-done', result: null });
      if (Object.keys(pre).length) dispatch({ type: 'synced', result: runSync(cameras, pre, fixed), fit: true });
      dispatch({ type: 'toast', text: 'Сверить по звуку не получилось — камеры остались по тайм-коду и часам.' });
    }
  }, []);

  // Ручная подгонка и удаление клипов с таймлинии сразу пересчитывают уже сделанную синхронизацию.
  const shiftKey = state.cameras.map((c) => `${c.id}:${c.manualShiftSec}:${c.excludedClipIds.length}`).join('|');
  useEffect(() => {
    const s = stateRef.current;
    if (s.sync && s.syncedVersion === s.version && !s.audioRun && !s.qrRun) {
      const heard = new Set([...heardCameras(s.audio), ...s.controlFixed]);
      dispatch({ type: 'synced', result: runSync(s.cameras, s.audio?.corrections ?? s.controlPre, heard), fit: false });
    }
  }, [shiftKey]);

  useEffect(() => {
    const off = api.onScanProgress((p) => dispatch({ type: 'scan-progress', cameraId: p.scanId, done: p.done, total: p.total }));
    void api.tools().then((tools) => dispatch({ type: 'tools', tools }));
    void api.checkUpdate().then((update) => update && dispatch({ type: 'update', update }));
    // Автозагрузка папок из переменных окружения — для проверки сборки без ручных действий.
    api.onAutoload(async ({ folders, sync, tab, at, menu, view, control, mode, qr, preview }) => {
      if (preview === '0') dispatch({ type: 'preview', on: false });
      const first = stateRef.current.cameras[0];
      for (let i = 0; i < folders.length; i++) {
        await addFolders(i === 0 && first.clips.length === 0 ? first.id : null, [folders[i]]);
      }
      // Контрольные кадры для проверки: «номер камеры:имя клипа@секунда;…».
      for (const spec of (control ?? '').split(';')) {
        const m = /^(\d+):([^@]+)@([\d.]+)$/.exec(spec.trim());
        const cam = m ? stateRef.current.cameras[Number(m[1]) - 1] : undefined;
        const clip = cam?.clips.find((c) => c.name === m![2]);
        if (cam && clip) dispatch({ type: 'set-control', frame: { cameraId: cam.id, clipId: clip.id, localSec: Number(m![3]) } });
      }
      if (qr) dispatch({ type: 'qr-screen', open: true });
      const syncMode = mode === 'audio' || mode === 'timecode' || mode === 'control' ? mode : undefined;
      if (sync) setTimeout(() => void doSync(syncMode), 50);
      if (tab === 'errors' || tab === 'faq') setTimeout(() => dispatch({ type: 'tab', tab }), 100);
      if (menu) setTimeout(() => dispatch({ type: 'sync-menu', open: true }), 200);
      const m = at ? /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(at) : null;
      if (m) {
        setTimeout(() => {
          const s = stateRef.current.sync;
          if (!s) return;
          const tzSec = s.displayTzOffsetMin * 60;
          const dayStart = Math.floor((s.start + tzSec) / 86400) * 86400 - tzSec;
          dispatch({ type: 'playhead', at: dayStart + Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) });
        }, 150);
      }
      const v = view ? /^(\d{1,2}):(\d{2}):(\d{2})-(\d{1,2}):(\d{2}):(\d{2})$/.exec(view) : null;
      if (v) {
        // Масштаб таймлинии для проверки: применяется после сверки по звуку.
        const apply = () => {
          const s = stateRef.current;
          if (!s.sync || s.audioRun) return setTimeout(apply, 300);
          const tzSec = s.sync.displayTzOffsetMin * 60;
          const dayStart = Math.floor((s.sync.start + tzSec) / 86400) * 86400 - tzSec;
          const a = dayStart + Number(v[1]) * 3600 + Number(v[2]) * 60 + Number(v[3]);
          const b = dayStart + Number(v[4]) * 3600 + Number(v[5]) * 60 + Number(v[6]);
          dispatch({ type: 'viewport', viewport: { start: a, secPerPx: (b - a) / 1280 } });
        };
        setTimeout(apply, 500);
      }
    });
    return off;
  }, [addFolders, doSync]);

  // Проигрывание: курсор идёт в реальном времени.
  useEffect(() => {
    if (!state.playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const s = stateRef.current;
      const dt = (now - last) / 1000;
      last = now;
      const end = Math.max(0, ...placements.map((p) => p.end));
      const next = (s.playhead ?? 0) + dt;
      if (next >= end) {
        dispatch({ type: 'play', playing: false });
        return;
      }
      dispatch({ type: 'playhead', at: next });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state.playing, placements]);

  // Клавиши как в монтажке: пробел, стрелки (Shift — по секунде), Home/End.
  // На Mac без клавиш Home/End то же делают ⌘ + ← →.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
      const s = stateRef.current;
      if (s.tab !== 'sync') return;
      const home = e.code === 'Home' || (isMac && e.metaKey && e.code === 'ArrowLeft');
      const end = e.code === 'End' || (isMac && e.metaKey && e.code === 'ArrowRight');
      if (home || end) {
        e.preventDefault();
        if (!placements.length) return;
        dispatch({ type: 'playhead', at: home ? Math.min(...placements.map((p) => p.start)) : Math.max(...placements.map((p) => p.end)) });
      } else if (e.code === 'Space') {
        e.preventDefault();
        if (s.playhead !== null) dispatch({ type: 'play', playing: !s.playing });
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        if (s.playhead === null) return;
        const step = (e.shiftKey ? 1 : 1 / fps) * (e.code === 'ArrowLeft' ? -1 : 1);
        dispatch({ type: 'play', playing: false });
        // Не дальше начала и конца съёмки.
        const lo = Math.min(...placements.map((p) => p.start));
        const hi = Math.max(...placements.map((p) => p.end));
        dispatch({ type: 'playhead', at: placements.length ? Math.min(Math.max(s.playhead + step, lo), hi) : s.playhead + step });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fps, placements]);

  const ctx: Ctx = { state, dispatch, placements, synced, issues, fps, addFolders, doSync };
  const scanning = isScanning(state);
  const wantSync = needsSync(state) && !scanning;
  const exportOk = canExport(state);
  // Пока программа читает клипы, экран синхронизации или сверяет звук — кнопка светится и заполняется по ходу работы.
  const busy = scanning || !!state.audioRun || !!state.qrRun;
  const scanDone = state.cameras.reduce((n, c) => n + (c.scanning?.done ?? 0), 0);
  const scanTotal = state.cameras.reduce((n, c) => n + (c.scanning?.total ?? 0), 0);
  const progress = state.qrRun
    ? state.qrRun.done / Math.max(1, state.qrRun.total)
    : state.audioRun
      ? state.audioRun.frac
      : scanning && scanTotal ? scanDone / scanTotal : 0;
  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.severity] += 1;
  const badge = counts.error ? 'danger' : counts.warning ? 'warning' : 'info';
  const badgeCount = counts.error + counts.warning || counts.info;

  const exportTitle = scanning
    ? 'Дождитесь, пока программа дочитает клипы'
    : state.qrRun
      ? 'Дождитесь, пока программа прочитает экран синхронизации'
    : state.audioRun
      ? 'Дождитесь окончания сверки по звуку'
    : !state.sync
      ? 'Сначала синхронизируйте камеры'
      : needsSync(state)
        ? 'Камеры изменились — синхронизируйте ещё раз'
        : 'Сохранить таймлинию для Premiere Pro и DaVinci Resolve';

  return (
    <AppContext.Provider value={ctx}>
      <div className="app">
        <header className="topbar">
          <nav className="tabs">
            <button className={`tab ${state.tab === 'sync' ? 'on' : ''}`} onClick={() => dispatch({ type: 'tab', tab: 'sync' })}>Синхронизация</button>
            <button className={`tab ${state.tab === 'errors' ? 'on' : ''}`} onClick={() => dispatch({ type: 'tab', tab: 'errors' })}>
              Ошибки {badgeCount > 0 && <span className={`badge ${badge}`}>{badgeCount}</span>}
            </button>
            <button className={`tab ${state.tab === 'faq' ? 'on' : ''}`} onClick={() => dispatch({ type: 'tab', tab: 'faq' })}>Настройка камер</button>
            <button className="tab tab-qr" onClick={() => dispatch({ type: 'qr-screen', open: true })} title="QR-код с точным временем — снимите его каждой камерой 5–10 секунд">
              <IconQr className="icon" /> Экран синхронизации
            </button>
            <button className="tab tab-support" onClick={() => void api.openLink('support')} title="Откроется страница CloudTips в браузере">
              <IconHeart className="icon" /> Поддержать проект
            </button>
          </nav>
          <span className="spacer" />
          <div className="sync-wrap">
            <button
              className={`btn ${wantSync && !busy ? 'primary pulse' : ''} ${busy ? 'busy' : ''}`}
              style={busy ? ({ '--progress': `${Math.round(progress * 100)}%` } as React.CSSProperties) : undefined}
              aria-busy={busy}
              onClick={() => !busy && dispatch({ type: 'sync-menu', open: !state.syncMenuOpen })}
              title={scanning ? 'Дождитесь, пока программа дочитает клипы' : busy ? 'Идёт синхронизация' : wantSync ? 'Есть новые клипы — разложите их по времени' : 'Пересчитать синхронизацию'}
            >
              <IconSync className={`icon ${busy ? 'spin' : ''}`} />
              <span>
                {scanning
                  ? 'Читаю клипы…'
                  : state.qrRun
                    ? `Читаю экран синхронизации ${state.qrRun.done} из ${state.qrRun.total}`
                  : state.audioRun
                    ? `Сверяю звук${state.audioRun.total ? ` ${Math.round(state.audioRun.frac * 100)} %` : '…'}`
                    : 'Синхронизировать'}
              </span>
            </button>
            {state.syncMenuOpen && <SyncMenu />}
          </div>
          <button
            className={`btn ${exportOk ? 'primary' : 'locked'}`}
            onClick={() => (exportOk ? dispatch({ type: 'export-open', open: true }) : dispatch({ type: 'toast', text: exportTitle }))}
            title={exportTitle}
          >
            {exportOk ? <IconExport /> : <IconLock />} Экспорт
          </button>
        </header>

        {state.tab === 'sync' && <SyncWorkspace />}
        {state.tab === 'errors' && <ErrorsPage />}
        {state.tab === 'faq' && <FaqPage />}
        <footer className="statusbar">
          <LogoMark className="statusbar-logo" />
          <span className="statusbar-name">TimesynCam {__APP_VERSION__}</span>
        </footer>
        {state.exportOpen && <ExportDialog />}
        {state.qrScreenOpen && <QrScreen />}
        {state.update && <UpdatePopup version={state.update.version} />}

        <div className="toasts">
          {state.toasts.map((t) => (
            <Toast key={t.id} id={t.id} text={t.text} revealPath={t.revealPath} />
          ))}
        </div>
      </div>
    </AppContext.Provider>
  );
}

function Toast({ id, text, revealPath }: { id: number; text: string; revealPath?: string }) {
  const { dispatch } = useApp();
  useEffect(() => {
    const t = setTimeout(() => dispatch({ type: 'toast-dismiss', id }), revealPath ? 9000 : 4000);
    return () => clearTimeout(t);
  }, [id, revealPath, dispatch]);
  return (
    <div className="toast">
      <span style={{ flex: 1 }}>{text}</span>
      {revealPath && <button className="btn small" onClick={() => void api.reveal(revealPath)}>Показать в папке</button>}
      <button className="btn small ghost" aria-label="Закрыть" onClick={() => dispatch({ type: 'toast-dismiss', id })}><IconX /></button>
    </div>
  );
}

// Вышла новая версия: окошко под верхней панелью справа. Щелчок открывает страницу релиза в браузере,
// крестик прячет окошко до следующего запуска.
function UpdatePopup({ version }: { version: string }) {
  const { dispatch } = useApp();
  return (
    <div className="update-pop" role="status" onClick={() => void api.openLink('release')} title="Откроется страница релиза в браузере">
      <span className="update-pop-icon"><IconExport /></span>
      <div className="update-pop-body">
        <b>Вышла TimesynCam {version}</b>
        <span>Скачайте новую версию со страницы релиза — установщик для Windows или .dmg для Mac.</span>
        <div className="update-pop-actions">
          <button className="btn small primary">Скачать</button>
        </div>
      </div>
      <button
        className="btn small ghost update-pop-close"
        aria-label="Закрыть"
        onClick={(e) => {
          e.stopPropagation();
          dispatch({ type: 'update', update: null });
        }}
      >
        <IconX />
      </button>
    </div>
  );
}

// Напоминание, когда на таймлинии появилась вторая (и каждая следующая) камера.
// Стоит слева внизу над таймлинией, чтобы не закрывать начало дорожек — там обычно и лежит клип с экраном.
function ControlHint() {
  const { dispatch } = useApp();
  useEffect(() => {
    const t = setTimeout(() => dispatch({ type: 'control-hint-close' }), 25000);
    return () => clearTimeout(t);
  }, [dispatch]);
  return (
    <div className="control-hint" role="status">
      <span className="control-hint-icon"><IconQr /></span>
      <div className="control-hint-body">
        <b>Не забудьте отметить контрольный кадр</b>
        <span>
          Это кадр с QR-кодом экрана синхронизации, снятый до или после съёмки всеми камерами или несколькими из них.
          Найдите его в клипе и нажмите правой кнопкой → «Выбрать контрольным кадром».
        </span>
        <div className="control-hint-actions">
          <button className="btn small" onClick={() => dispatch({ type: 'tab', tab: 'faq', faqAnchor: 'qr-screen' })}>Как снять экран</button>
          <button className="btn small ghost" onClick={() => dispatch({ type: 'control-hint-close' })}>Понятно</button>
        </div>
      </div>
      <button className="btn small ghost control-hint-close" aria-label="Закрыть" onClick={() => dispatch({ type: 'control-hint-close' })}><IconX /></button>
    </div>
  );
}

function SyncWorkspace() {
  const { state } = useApp();
  const wrapRef = useRef<HTMLDivElement>(null);
  const onSplitter = (e: React.MouseEvent) => {
    const el = wrapRef.current;
    if (!el) return;
    const startY = e.clientY;
    const startH = el.querySelector<HTMLElement>('.timeline')?.offsetHeight ?? 300;
    const move = (ev: MouseEvent) => {
      const h = Math.min(Math.max(160, startH - (ev.clientY - startY)), el.offsetHeight - 260);
      el.style.setProperty('--timeline-h', `${h}px`);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return (
    <div className="workspace" ref={wrapRef}>
      <div className="upper">
        <CameraPanel />
        <Viewer />
        {state.controlHint !== null && <ControlHint key={state.controlHint} />}
      </div>
      <div className="splitter" onMouseDown={onSplitter} />
      <Timeline />
    </div>
  );
}
