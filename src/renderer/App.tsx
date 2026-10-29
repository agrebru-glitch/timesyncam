import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import type { Dispatch } from 'react';
import type { Issue, Placement } from '../core/types.ts';
import { previewPlacements, runSync } from '../core/sync.ts';
import { defaultTimelineRate } from '../core/fcp7.ts';
import { rateValue } from '../core/timecode.ts';
import { pluralRu } from '../core/format.ts';
import { api } from './api.ts';
import { canExport, initialState, isScanning, needsSync, newCamera, reducer } from './state.ts';
import type { Action, State } from './state.ts';
import { IconExport, IconLock, IconSync, IconX } from './icons.tsx';
import { CameraPanel } from './components/CameraPanel.tsx';
import { Viewer } from './components/Viewer.tsx';
import { Timeline } from './components/Timeline.tsx';
import { ErrorsPage } from './components/ErrorsPage.tsx';
import { FaqPage } from './components/FaqPage.tsx';
import { ExportDialog } from './components/ExportDialog.tsx';

interface Ctx {
  state: State;
  dispatch: Dispatch<Action>;
  placements: Placement[];
  synced: boolean;
  issues: Issue[];
  fps: number;
  addFolders: (cameraId: string | null, folders: string[]) => Promise<void>;
  doSync: () => void;
}

const AppContext = createContext<Ctx | null>(null);
export function useApp(): Ctx {
  const c = useContext(AppContext);
  if (!c) throw new Error('AppContext');
  return c;
}

let scanIssueSeq = 0;

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const synced = !!state.sync && !needsSync(state);
  const placements = useMemo(
    () => (synced && state.sync ? state.sync.placements : previewPlacements(state.cameras)),
    [synced, state.sync, state.cameras],
  );
  const issues = useMemo(() => {
    const list = [...state.scanIssues, ...(synced && state.sync ? state.sync.issues : [])];
    if (state.tools && !state.tools.ffprobe) {
      list.unshift({
        id: 'tools', severity: 'error', cameraId: null,
        title: 'Не найден ffprobe — программа не может читать клипы',
        details: 'Положите ffprobe.exe и ffmpeg.exe в папку bin рядом с программой или установите FFmpeg и добавьте его в PATH.',
        actions: [],
      });
    }
    const order = { error: 0, warning: 1, info: 2 };
    return list.sort((a, b) => order[a.severity] - order[b.severity]);
  }, [state.scanIssues, state.sync, synced, state.tools]);
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
          title: `«${camName}»: в папке не нашлось видео и звука`,
          details: folder,
          actions: [],
        });
      }
      dispatch({ type: 'scan-done', cameraId: targetId, clips: res.clips, issues: scanIssues });
    }
  }, []);

  const doSync = useCallback(() => {
    const s = stateRef.current;
    if (isScanning(s)) return;
    dispatch({ type: 'synced', result: runSync(s.cameras), fit: true });
  }, []);

  // Ручная подгонка и удаление клипов с таймлинии сразу пересчитывают уже сделанную синхронизацию.
  const shiftKey = state.cameras.map((c) => `${c.id}:${c.manualShiftSec}:${c.excludedClipIds.length}`).join('|');
  useEffect(() => {
    const s = stateRef.current;
    if (s.sync && s.syncedVersion === s.version) dispatch({ type: 'synced', result: runSync(s.cameras), fit: false });
  }, [shiftKey]);

  useEffect(() => {
    const off = api.onScanProgress((p) => dispatch({ type: 'scan-progress', cameraId: p.scanId, done: p.done, total: p.total }));
    void api.tools().then((tools) => dispatch({ type: 'tools', tools }));
    // Автозагрузка папок из переменных окружения — для проверки сборки без ручных действий.
    api.onAutoload(async ({ folders, sync, tab, at }) => {
      const first = stateRef.current.cameras[0];
      for (let i = 0; i < folders.length; i++) {
        await addFolders(i === 0 && first.clips.length === 0 ? first.id : null, [folders[i]]);
      }
      if (sync) setTimeout(() => doSync(), 50);
      if (tab === 'errors' || tab === 'faq') setTimeout(() => dispatch({ type: 'tab', tab }), 100);
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
      const end = s.sync?.end ?? Math.max(0, ...placements.map((p) => p.end));
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
      const s = stateRef.current;
      if (s.tab !== 'sync') return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (s.playhead !== null) dispatch({ type: 'play', playing: !s.playing });
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        if (s.playhead === null) return;
        const step = (e.shiftKey ? 1 : 1 / fps) * (e.code === 'ArrowLeft' ? -1 : 1);
        dispatch({ type: 'play', playing: false });
        dispatch({ type: 'playhead', at: s.playhead + step });
      } else if (e.code === 'Home' && placements.length) {
        dispatch({ type: 'playhead', at: Math.min(...placements.map((p) => p.start)) });
      } else if (e.code === 'End' && placements.length) {
        dispatch({ type: 'playhead', at: Math.max(...placements.map((p) => p.end)) });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fps, placements]);

  const ctx: Ctx = { state, dispatch, placements, synced, issues, fps, addFolders, doSync };
  const scanning = isScanning(state);
  const wantSync = needsSync(state) && !scanning;
  const exportOk = canExport(state);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.severity] += 1;
  const badge = counts.error ? 'danger' : counts.warning ? 'warning' : 'info';
  const badgeCount = counts.error + counts.warning || counts.info;

  const exportTitle = scanning
    ? 'Дождитесь, пока программа дочитает клипы'
    : !state.sync
      ? 'Сначала синхронизируйте камеры'
      : needsSync(state)
        ? 'Камеры изменились — синхронизируйте ещё раз'
        : 'Сохранить таймлинию для Premiere Pro и DaVinci Resolve';

  return (
    <AppContext.Provider value={ctx}>
      <div className="app">
        <header className="topbar">
          <span className="brand">TimesynCam</span>
          <nav className="tabs">
            <button className={`tab ${state.tab === 'sync' ? 'on' : ''}`} onClick={() => dispatch({ type: 'tab', tab: 'sync' })}>Синхронизация</button>
            <button className={`tab ${state.tab === 'errors' ? 'on' : ''}`} onClick={() => dispatch({ type: 'tab', tab: 'errors' })}>
              Ошибки {badgeCount > 0 && <span className={`badge ${badge}`}>{badgeCount}</span>}
            </button>
            <button className={`tab ${state.tab === 'faq' ? 'on' : ''}`} onClick={() => dispatch({ type: 'tab', tab: 'faq' })}>Настройка камер</button>
          </nav>
          <span className="spacer" />
          <button
            className={`btn ${wantSync ? 'primary pulse' : ''} ${scanning ? 'locked' : ''}`}
            onClick={doSync}
            title={scanning ? 'Дождитесь, пока программа дочитает клипы' : wantSync ? 'Есть новые клипы — разложите их по времени' : 'Пересчитать синхронизацию'}
          >
            <IconSync /> {scanning ? 'Читаю клипы…' : 'Синхронизировать'}
          </button>
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
        {state.exportOpen && <ExportDialog />}

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

function SyncWorkspace() {
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
      </div>
      <div className="splitter" onMouseDown={onSplitter} />
      <Timeline />
    </div>
  );
}
