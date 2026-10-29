import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Placement } from '../../core/types.ts';
import { formatClockTime, formatDate, pluralRu } from '../../core/format.ts';
import { useApp } from '../App.tsx';
import { api, cameraColor } from '../api.ts';
import { IconPlus } from '../icons.tsx';
import type { Viewport } from '../state.ts';
import { getWaveform, useWaveformVersion } from '../waveforms.ts';
import { WAVE_RATE } from '../../core/audioSync.ts';

const RULER_H = 30;
const ROW_H = 52;
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600];
const WAVES_KEY = 'timesyncam.showWaves';

// Уровни огрублённой волны: на каждом следующем — максимум из двух соседних точек.
const pyramids = new WeakMap<Uint8Array, Uint8Array[]>();
function pyramid(w: Uint8Array): Uint8Array[] {
  let p = pyramids.get(w);
  if (p) return p;
  p = [w];
  while (p[p.length - 1].length > 64) {
    const prev = p[p.length - 1];
    const next = new Uint8Array(Math.ceil(prev.length / 2));
    for (let i = 0; i < next.length; i++) next[i] = Math.max(prev[2 * i], prev[2 * i + 1] ?? 0);
    p.push(next);
  }
  pyramids.set(w, p);
  return p;
}

export function Timeline() {
  const { state, dispatch, placements, synced, issues, addFolders } = useApp();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 240 });
  const [dropRow, setDropRow] = useState<number | 'new' | null>(null);
  const [showWaves, setShowWaves] = useState(() => {
    try {
      return localStorage.getItem(WAVES_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const waveVersion = useWaveformVersion();
  const [menu, setMenu] = useState<{ x: number; y: number; clipId: string; cameraId: string } | null>(null);
  const tz = state.sync?.displayTzOffsetMin ?? -new Date().getTimezoneOffset();

  const lanesByCam = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of state.cameras) {
      const cs = synced ? state.sync?.cameras.find((x) => x.cameraId === c.id) : undefined;
      m.set(c.id, Math.max(1, cs?.lanes ?? 1));
    }
    return m;
  }, [state.cameras, state.sync, synced]);

  const rows = useMemo(() => {
    let y = RULER_H;
    return state.cameras.map((c, i) => {
      const h = ROW_H * (lanesByCam.get(c.id) ?? 1);
      const r = { cam: c, index: i, y, h };
      y += h;
      return r;
    });
  }, [state.cameras, lanesByCam]);

  const extent = useMemo(() => {
    if (!placements.length) return null;
    return { start: Math.min(...placements.map((p) => p.start)), end: Math.max(...placements.map((p) => p.end)) };
  }, [placements]);

  const fitViewport = useCallback((): Viewport | null => {
    if (!extent) return null;
    const span = Math.max(60, extent.end - extent.start);
    return { start: extent.start - span * 0.02, secPerPx: (span * 1.04) / Math.max(200, size.w) };
  }, [extent, size.w]);

  const vp = state.viewport ?? fitViewport();

  useEffect(() => {
    if (!state.viewport && extent) {
      const f = fitViewport();
      if (f) dispatch({ type: 'viewport', viewport: f });
    }
  }, [extent, state.viewport, fitViewport, dispatch]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const errorClips = useMemo(() => new Set(issues.filter((i) => i.severity === 'error' && i.clipId).map((i) => i.clipId!)), [issues]);
  const speedClips = useMemo(() => new Set(state.cameras.flatMap((c) => c.clips.filter((x) => x.captureFps !== null).map((x) => x.id))), [state.cameras]);

  // Отрисовка.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.floor(size.w * dpr);
    cv.height = Math.floor(size.h * dpr);
    cv.style.width = `${size.w}px`;
    cv.style.height = `${size.h}px`;
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.w, size.h);

    // Полосы дорожек.
    rows.forEach((r) => {
      g.fillStyle = r.index % 2 ? '#1d1e22' : '#1a1b1f';
      g.fillRect(0, r.y, size.w, r.h);
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fillRect(0, r.y + r.h - 1, size.w, 1);
    });
    g.fillStyle = '#16171a';
    g.fillRect(0, 0, size.w, RULER_H);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(0, RULER_H - 1, size.w, 1);
    if (!vp) return;

    const x = (t: number) => (t - vp.start) / vp.secPerPx;
    const t0 = vp.start;
    const t1 = vp.start + size.w * vp.secPerPx;

    // Линейка: время суток.
    const step = STEPS.find((s) => s / vp.secPerPx >= 90) ?? 21600;
    const minor = step / 5;
    g.font = '11px "Cascadia Mono", Consolas, monospace';
    g.textBaseline = 'middle';
    const wallStart = Math.floor((t0 + tz * 60) / minor) * minor - tz * 60;
    for (let t = wallStart; t <= t1; t += minor) {
      const xx = Math.round(x(t)) + 0.5;
      const isMajor = Math.abs(((t + tz * 60) / step) - Math.round((t + tz * 60) / step)) < 1e-6;
      g.fillStyle = isMajor ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.12)';
      g.fillRect(xx, isMajor ? 14 : 22, 1, isMajor ? RULER_H - 14 : RULER_H - 22);
      if (isMajor) {
        g.fillStyle = '#a4a6ad';
        const wall = ((t + tz * 60) % 86400 + 86400) % 86400;
        const label = wall < 1 ? `${formatDate(t, tz)}` : formatClockTime(t, tz, step < 60);
        g.fillText(label, xx + 4, 9);
        g.fillStyle = 'rgba(255,255,255,0.035)';
        g.fillRect(xx, RULER_H, 1, size.h - RULER_H);
      }
    }

    // Клипы.
    const byCam = new Map<string, Placement[]>();
    for (const p of placements) {
      if (p.end < t0 || p.start > t1) continue;
      const arr = byCam.get(p.cameraId) ?? [];
      arr.push(p);
      byCam.set(p.cameraId, arr);
    }
    g.font = '11px "Segoe UI Variable Text", "Segoe UI", sans-serif';
    for (const r of rows) {
      const list = byCam.get(r.cam.id) ?? [];
      const color = cameraColor(r.index);
      for (const p of list) {
        const x0 = x(p.start);
        const w = Math.max(2, x(p.end) - x0);
        const y0 = r.y + 6 + p.lane * ROW_H;
        const h = ROW_H - 12;
        const isSpeed = speedClips.has(p.clipId);
        g.globalAlpha = isSpeed ? 0.95 : synced ? (p.method === 'clock' ? 0.78 : 1) : 0.35;
        g.fillStyle = isSpeed ? '#ff5f57' : synced ? color : '#8a8d96';
        g.beginPath();
        g.roundRect(x0, y0, w, h, Math.min(4, w / 2));
        g.fill();
        g.globalAlpha = 1;

        // Волна звука внутри клипа: одинаковые всплески у разных камер стоят на одной вертикали.
        const wave = showWaves ? getWaveform(p.clipId) : undefined;
        if (wave && w > 3) {
          const levels = pyramid(wave);
          const perPx = vp.secPerPx * WAVE_RATE;
          const level = Math.max(0, Math.min(levels.length - 1, Math.floor(Math.log2(Math.max(1, perPx)))));
          const data = levels[level];
          const scale = WAVE_RATE / 2 ** level;
          const top = y0 + 16;
          const mid = top + (h - 18) / 2;
          const amp = (h - 18) / 2;
          g.fillStyle = synced || isSpeed ? 'rgba(0,0,0,0.42)' : 'rgba(255,255,255,0.4)';
          const pxFrom = Math.max(0, Math.floor(x0));
          const pxTo = Math.min(size.w, Math.ceil(x0 + w));
          for (let px = pxFrom; px < pxTo; px++) {
            const local0 = vp.start + px * vp.secPerPx - p.start;
            const i0 = Math.max(0, Math.floor(local0 * scale));
            const i1 = Math.min(data.length, Math.max(i0 + 1, Math.ceil((local0 + vp.secPerPx) * scale)));
            let peak = 0;
            for (let i = i0; i < i1; i++) if (data[i] > peak) peak = data[i];
            if (peak < 4) continue;
            const a = Math.max(0.5, (peak / 255) * amp);
            g.fillRect(px, mid - a, 1, a * 2);
          }
        }

        if (errorClips.has(p.clipId) && !isSpeed) {
          g.strokeStyle = '#ff5f57';
          g.lineWidth = 2;
          g.stroke();
        }
        if (state.selectedClipId === p.clipId) {
          g.strokeStyle = '#ffffff';
          g.lineWidth = 2;
          g.stroke();
        }
        if (w > 54) {
          const clip = r.cam.clips.find((c) => c.id === p.clipId);
          g.save();
          g.beginPath();
          g.rect(x0 + 6, y0, w - 10, h);
          g.clip();
          g.fillStyle = synced || isSpeed ? 'rgba(0,0,0,0.78)' : '#e0e1e5';
          g.fillText(isSpeed ? `S&Q · ${clip?.name ?? ''}` : clip?.name ?? '', x0 + 6, y0 + 13);
          g.restore();
        }
      }
    }

    // Точки сверки по звуку: зелёная — задала или сменила поправку, белая — подтвердила, серая — отброшена.
    if (synced && state.audio) {
      for (const camRes of state.audio.cameras) {
        const row = rows.find((r) => r.cam.id === camRes.cameraId);
        if (!row) continue;
        for (const a of camRes.anchors) {
          const ax = x(a.at);
          if (ax < -6 || ax > size.w + 6) continue;
          const ay = row.y + ROW_H - 7;
          g.fillStyle = a.role === 'start' || a.role === 'shift' ? '#3ccf7e' : a.role === 'confirm' ? 'rgba(255,255,255,0.9)' : '#6f727a';
          g.strokeStyle = 'rgba(0,0,0,0.6)';
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(ax, ay - 5);
          g.lineTo(ax + 5, ay);
          g.lineTo(ax, ay + 5);
          g.lineTo(ax - 5, ay);
          g.closePath();
          g.fill();
          g.stroke();
        }
      }
    }

    // Курсор.
    if (state.playhead !== null) {
      const px = Math.round(x(state.playhead)) + 0.5;
      if (px >= 0 && px <= size.w) {
        g.fillStyle = '#ff5f57';
        g.fillRect(px - 0.5, 0, 1.5, size.h);
        g.beginPath();
        g.moveTo(px - 6, 0);
        g.lineTo(px + 6, 0);
        g.lineTo(px, 9);
        g.closePath();
        g.fill();
      }
    }
  }, [size, vp, rows, placements, synced, state.playhead, state.selectedClipId, state.audio, errorClips, speedClips, tz, showWaves, waveVersion]);

  // Мышь: щелчок ставит курсор и выделяет клип, по линейке можно водить.
  const timeAt = (clientX: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return vp ? vp.start + (clientX - rect.left) * vp.secPerPx : 0;
  };
  const clipUnder = (clientX: number, clientY: number): Placement | null => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const y = clientY - rect.top;
    const row = rows.find((r) => y >= r.y && y < r.y + r.h);
    if (!row) return null;
    const lane = Math.floor((y - row.y) / ROW_H);
    const t = timeAt(clientX);
    const slack = vp ? 3 * vp.secPerPx : 0;
    return placements.find((p) => p.cameraId === row.cam.id && p.lane === lane && p.start - slack <= t && t <= p.end + slack) ?? null;
  };

  const removeClip = (cameraId: string, clipId: string) => {
    const name = state.cameras.find((c) => c.id === cameraId)?.clips.find((c) => c.id === clipId)?.name ?? 'Клип';
    dispatch({ type: 'exclude-clips', cameraId, clipIds: [clipId] });
    dispatch({ type: 'toast', text: `${name} удалён с таймлинии. Файл на диске не тронут — вернуть можно в карточке камеры.` });
  };

  // Правая кнопка по клипу — меню клипа.
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const hit = clipUnder(e.clientX, e.clientY);
    if (!hit) {
      setMenu(null);
      return;
    }
    const rect = wrapRef.current!.getBoundingClientRect();
    dispatch({ type: 'select-clip', clipId: hit.clipId });
    setMenu({ x: Math.min(e.clientX - rect.left, rect.width - 230), y: Math.min(e.clientY - rect.top, rect.height - 96), clipId: hit.clipId, cameraId: hit.cameraId });
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  // Delete — удалить выделенный клип с таймлинии.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' || state.tab !== 'sync' || !state.selectedClipId) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT') return;
      const p = placements.find((x) => x.clipId === state.selectedClipId);
      if (p) removeClip(p.cameraId, p.clipId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onMouseDown = (e: React.MouseEvent) => {
    if (!vp || e.button !== 0) return;
    const hit = clipUnder(e.clientX, e.clientY);
    dispatch({ type: 'select-clip', clipId: hit?.clipId ?? null });
    if (hit) dispatch({ type: 'view-mode', mode: state.viewMode, cameraId: hit.cameraId });
    dispatch({ type: 'play', playing: false });
    dispatch({ type: 'playhead', at: timeAt(e.clientX) });
    const move = (ev: MouseEvent) => dispatch({ type: 'playhead', at: timeAt(ev.clientX) });
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!vp) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const k = Math.exp(e.deltaY * 0.0015);
        const cursorT = vp.start + (e.clientX - rect.left) * vp.secPerPx;
        const secPerPx = Math.min(Math.max(vp.secPerPx * k, 0.002), 400);
        dispatch({ type: 'viewport', viewport: { secPerPx, start: cursorT - (e.clientX - rect.left) * secPerPx } });
      } else {
        const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * vp.secPerPx;
        dispatch({ type: 'viewport', viewport: { ...vp, start: vp.start + d } });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [vp, dispatch]);

  // Перетаскивание папок на дорожки.
  const rowAtY = (clientY: number): number | 'new' | null => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const y = clientY - rect.top;
    const r = rows.find((row) => y >= row.y && y < row.y + row.h);
    if (r) return r.index;
    return y > (rows.at(-1)?.y ?? 0) + (rows.at(-1)?.h ?? 0) ? 'new' : null;
  };
  const onDrop = (e: React.DragEvent, target: number | 'new' | null) => {
    e.preventDefault();
    setDropRow(null);
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (!paths.length || target === null) return;
    const cam = target === 'new' ? null : state.cameras[target];
    void addFolders(cam?.id ?? null, paths);
  };

  const zoom = (k: number) => {
    if (!vp) return;
    const mid = vp.start + (size.w / 2) * vp.secPerPx;
    const secPerPx = Math.min(Math.max(vp.secPerPx * k, 0.002), 400);
    dispatch({ type: 'viewport', viewport: { secPerPx, start: mid - (size.w / 2) * secPerPx } });
  };

  return (
    <div className="timeline">
      <div className="tl-heads">
        <div className="tl-ruler-head">
          <button className="btn small ghost" title="Показать всю съёмку" onClick={() => { const f = fitViewport(); if (f) dispatch({ type: 'viewport', viewport: f }); }}>Всё</button>
          <button className="btn small ghost" aria-label="Отдалить" onClick={() => zoom(1.6)}>−</button>
          <button className="btn small ghost" aria-label="Приблизить" onClick={() => zoom(1 / 1.6)}>+</button>
          <button
            className={`btn small ghost ${showWaves ? 'on' : ''}`}
            title={showWaves ? 'Скрыть волну звука на клипах' : 'Показать волну звука на клипах'}
            aria-pressed={showWaves}
            onClick={() => {
              setShowWaves(!showWaves);
              try {
                localStorage.setItem(WAVES_KEY, showWaves ? '0' : '1');
              } catch {
                // запоминать необязательно
              }
            }}
          >
            Волна
          </button>
        </div>
        {rows.map((r) => (
          <div
            key={r.cam.id}
            className={`tl-head ${dropRow === r.index ? 'drop' : ''}`}
            style={{ height: r.h }}
            onClick={() => dispatch({ type: 'view-mode', mode: state.viewMode, cameraId: r.cam.id })}
            onDragOver={(e) => { e.preventDefault(); setDropRow(r.index); }}
            onDragLeave={() => setDropRow(null)}
            onDrop={(e) => onDrop(e, r.index)}
          >
            <span className="t"><span className="cam-dot" style={{ background: cameraColor(r.index) }} />{r.cam.name}</span>
            <span className="s">
              {r.cam.scanning
                ? `Читаю ${r.cam.scanning.done} из ${r.cam.scanning.total || '…'}`
                : r.cam.clips.length
                  ? pluralRu(r.cam.clips.length, 'клип', 'клипа', 'клипов')
                  : 'Перетащите папку сюда'}
            </span>
          </div>
        ))}
        <div
          className={`tl-add ${dropRow === 'new' ? 'drop' : ''}`}
          onClick={() => dispatch({ type: 'add-camera' })}
          onDragOver={(e) => { e.preventDefault(); setDropRow('new'); }}
          onDragLeave={() => setDropRow(null)}
          onDrop={(e) => onDrop(e, 'new')}
        >
          <IconPlus /> Добавить камеру
        </div>
      </div>
      <div
        className="tl-canvas-wrap"
        ref={wrapRef}
        onDragOver={(e) => { e.preventDefault(); setDropRow(rowAtY(e.clientY)); }}
        onDragLeave={() => setDropRow(null)}
        onDrop={(e) => onDrop(e, rowAtY(e.clientY))}
      >
        <canvas ref={canvasRef} onMouseDown={onMouseDown} onContextMenu={onContextMenu} />
        {menu && (() => {
          const clip = state.cameras.find((c) => c.id === menu.cameraId)?.clips.find((c) => c.id === menu.clipId);
          if (!clip) return null;
          return (
            <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} role="menu" onMouseDown={(e) => e.stopPropagation()}>
              <div className="ctx-title">{clip.name}</div>
              <button role="menuitem" className="ctx-item danger" onClick={() => { removeClip(menu.cameraId, menu.clipId); setMenu(null); }}>
                Удалить с таймлинии
                <span className="ctx-hint">Del · файл на диске останется</span>
              </button>
              <button role="menuitem" className="ctx-item" onClick={() => { void api.reveal(clip.path); setMenu(null); }}>
                Показать файл в папке
              </button>
            </div>
          );
        })()}
        {!extent && (
          <div className="tl-hint">
            Перетащите папку с клипами камеры на дорожку.<br />Каждая камера — на свою дорожку.
          </div>
        )}
        {extent && !synced && !state.cameras.some((c) => c.scanning) && (
          <div className="tl-hint" style={{ top: 'auto', bottom: 12, transform: 'translateX(-50%)', color: 'var(--text-2)' }}>
            Клипы стоят по часам камер — нажмите «Синхронизировать»
          </div>
        )}
      </div>
    </div>
  );
}
