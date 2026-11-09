import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Camera, Placement } from '../../core/types.ts';
import { formatClockTime, formatDate, pluralRu, rulerTicks } from '../../core/format.ts';
import { useApp } from '../App.tsx';
import { api, cameraColor } from '../api.ts';
import { IconCamera, IconHeadphones, IconPlus } from '../icons.tsx';
import { audible, newCamera } from '../state.ts';
import type { Viewport } from '../state.ts';
import { getWaveform, useWaveformVersion } from '../waveforms.ts';
import { isMac } from '../platform.ts';
import { WAVE_RATE } from '../../core/audioSync.ts';
import { driftJobs } from '../../core/driftExport.ts';
import type { DriftJob } from '../../core/driftExport.ts';
import { ALONE_NOTE, unsureDetails, unsureNote, unsureOf } from '../../core/unsure.ts';
import { trackOrder } from '../../core/trackOrder.ts';

const RULER_H = 30;
const EDGE_PX = 24; // поле до начала и после конца съёмки
const ROW_H = 52;
const ADD_H = 44; // строка «+ Камера + Звук» — всегда внизу колонки дорожек, не уезжает при прокрутке
// Шаг крупных делений линейки: от секунды до лет — линейка не захлёбывается метками при любом масштабе.
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 2 * 86400, 7 * 86400, 30 * 86400, 91 * 86400, 365 * 86400, 5 * 365 * 86400, 25 * 365 * 86400];
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

// Сведения о дорожке, как в монтажке: «2 клипа · 29,97 к/с · стерео», у рекордера — «4 клипа · 48 кГц · моно».
function trackInfo(cam: Camera): string {
  const most = <T,>(xs: T[]): T | undefined => {
    const m = new Map<T, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  // Частота кадров меняется по ходу съёмки — о камере она ничего не говорит; у звука — частота дискретизации.
  const parts = [pluralRu(cam.clips.length, 'клип', 'клипа', 'клипов')];
  const sr = most(cam.clips.filter((c) => c.audioSampleRate).map((c) => c.audioSampleRate!));
  if (sr && cam.clips.every((c) => !c.hasVideo)) parts.push(`${String(sr / 1000).replace('.', ',')} кГц`);
  const ch = most(cam.clips.map((c) => c.audioChannels)) ?? 0;
  parts.push(ch === 0 ? 'без звука' : ch === 1 ? 'моно' : ch === 2 ? 'стерео' : `${ch} кан.`);
  return parts.join(' · ');
}

export function Timeline() {
  const { state, dispatch, placements, synced, issues, addFolders } = useApp();
  const stateRef = useRef(state);
  stateRef.current = state;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 240 });
  // Дорожек больше, чем помещается, — их можно прокручивать: колёсиком над названиями или Alt + колёсико.
  const [scrollY, setScrollY] = useState(0);
  const headsRef = useRef<HTMLDivElement>(null);
  const [dropRow, setDropRow] = useState<number | 'new' | null>(null);
  const [showWaves, setShowWaves] = useState(() => {
    try {
      return localStorage.getItem(WAVES_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const waveVersion = useWaveformVersion();
  const [menu, setMenu] = useState<{ x: number; y: number; clipId: string; cameraId: string; localSec: number } | null>(null);
  const tz = state.sync?.displayTzOffsetMin ?? -new Date().getTimezoneOffset();

  const lanesByCam = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of state.cameras) {
      const cs = synced ? state.sync?.cameras.find((x) => x.cameraId === c.id) : undefined;
      m.set(c.id, Math.max(1, cs?.lanes ?? 1));
    }
    return m;
  }, [state.cameras, state.sync, synced]);

  const rowsHeight = state.cameras.reduce((s, c) => s + ROW_H * (lanesByCam.get(c.id) ?? 1), 0);
  const viewH = Math.max(0, size.h - RULER_H - ADD_H);
  const maxScroll = Math.max(0, rowsHeight - viewH);
  const sy = Math.min(scrollY, maxScroll);
  const rows = useMemo(() => {
    let y = RULER_H - sy;
    // Сверху — дорожки с меньшим количеством материала, звук — под камерами (core/trackOrder.ts). index — место
    // дорожки в проекте: по нему цвет и куда бросать файлы; pos — место на экране.
    return trackOrder(state.cameras).map((c, pos) => {
      const h = ROW_H * (lanesByCam.get(c.id) ?? 1);
      const r = { cam: c, index: state.cameras.indexOf(c), pos, y, h };
      y += h;
      return r;
    });
  }, [state.cameras, lanesByCam, sy]);
  // Колонка названий прокручивается вместе с дорожками.
  useEffect(() => {
    const el = headsRef.current;
    if (el && Math.abs(el.scrollTop - sy) > 0.5) el.scrollTop = sy;
  }, [sy]);
  // Добавили дорожку — показываем её.
  const camCount = useRef(state.cameras.length);
  useEffect(() => {
    if (state.cameras.length > camCount.current) setScrollY(Infinity);
    camCount.current = state.cameras.length;
  }, [state.cameras.length]);

  const extent = useMemo(() => {
    if (!placements.length) return null;
    return { start: Math.min(...placements.map((p) => p.start)), end: Math.max(...placements.map((p) => p.end)) };
  }, [placements]);

  // У таймлинии есть начало и конец — первый и последний клип. Дальше них не прокрутить и не отдалить:
  // вся съёмка — самый мелкий масштаб, а если она уже окна, клипы прижаты к началу.
  const clampViewport = useCallback((v: Viewport | null): Viewport | null => {
    if (!v || !extent) return v;
    const usable = Math.max(100, size.w - 2 * EDGE_PX);
    const secPerPx = Math.min(Math.max(v.secPerPx, 0.002), Math.max(0.002, (extent.end - extent.start) / usable));
    const minStart = extent.start - EDGE_PX * secPerPx;
    const maxStart = extent.end + EDGE_PX * secPerPx - size.w * secPerPx;
    return { start: Math.max(minStart, Math.min(v.start, maxStart)), secPerPx };
  }, [extent, size.w]);

  const fitViewport = useCallback((): Viewport | null => (extent ? clampViewport({ start: extent.start, secPerPx: Infinity }) : null), [extent, clampViewport]);

  const vp = clampViewport(state.viewport ?? fitViewport());

  useEffect(() => {
    if (!state.viewport && extent) {
      const f = fitViewport();
      if (f) dispatch({ type: 'viewport', viewport: f });
    }
  }, [extent, state.viewport, fitViewport, dispatch]);

  // До синхронизации клипы лежат кучкой от нуля, после — по времени суток. Когда раскладка меняется
  // или в кучке появились новые клипы, показываем её целиком и ставим курсор в начало, если он вне клипов.
  const pileKey = synced ? 'synced' : state.cameras.map((c) => c.clips.length).join(',');
  useEffect(() => {
    if (synced || !extent) return;
    const f = fitViewport();
    if (f) dispatch({ type: 'viewport', viewport: f });
    const at = stateRef.current.playhead;
    if (at === null || at < extent.start || at > extent.end) dispatch({ type: 'playhead', at: extent.start });
  }, [pileKey]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const errorClips = useMemo(() => new Set(issues.filter((i) => i.severity === 'error' && i.clipId).map((i) => i.clipId!)), [issues]);
  // Клипы без сверки: звук не подтвердил их место или подтвердил хуже кадра — обведены пунктиром.
  const unsureClips = useMemo(() => (synced ? state.audio?.unsure ?? {} : {}), [synced, state.audio]);
  const aloneClips = useMemo(() => new Set(synced ? state.audio?.alone ?? [] : []), [synced, state.audio]);
  const unsureByCam = useMemo(() => new Map(state.cameras.map((c) => [c.id, synced ? unsureOf(c, state.audio) : unsureOf(c, null)])), [state.cameras, state.audio, synced]);
  const speedClips = useMemo(() => new Set(state.cameras.flatMap((c) => c.clips.filter((x) => x.captureFps !== null).map((x) => x.id))), [state.cameras]);
  // Записи с ходом часов: в таймлинию монтажки вместо них встанут выровненные копии — оригиналы не меняются.
  const driftClips = useMemo(
    () => new Map<string, DriftJob>(synced && state.sync ? driftJobs(state.cameras, state.sync, state.audio).map((j) => [j.clipId, j]) : []),
    [synced, state.cameras, state.sync, state.audio],
  );

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

    // Полосы дорожек — только в видимой части, между линейкой и строкой добавления.
    const clipRows = () => {
      g.save();
      g.beginPath();
      g.rect(0, RULER_H, size.w, viewH);
      g.clip();
    };
    clipRows();
    rows.forEach((r) => {
      g.fillStyle = r.pos % 2 ? '#1d1e22' : '#1a1b1f';
      g.fillRect(0, r.y, size.w, r.h);
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fillRect(0, r.y + r.h - 1, size.w, 1);
    });
    g.restore();
    g.fillStyle = '#16171a';
    g.fillRect(0, 0, size.w, RULER_H);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(0, RULER_H - 1, size.w, 1);
    if (!vp) return;

    const x = (t: number) => (t - vp.start) / vp.secPerPx;
    const t0 = vp.start;
    const t1 = vp.start + size.w * vp.secPerPx;

    // Линейка: время суток, а до синхронизации — время от начала кучки.
    const rulerTz = synced ? tz : 0;
    const step = STEPS.find((s) => s / vp.secPerPx >= 90) ?? STEPS[STEPS.length - 1];
    const minor = step / 5;
    // Страховка: меток не больше, чем пикселей на экране.
    const ticks = (t1 - t0) / minor;
    g.font = '11px "Cascadia Mono", ui-monospace, Menlo, Consolas, monospace';
    g.textBaseline = 'middle';
    for (const { t, major: isMajor } of ticks < size.w * 2 ? rulerTicks(t0, t1, step, rulerTz) : []) {
      if (!synced && t < -1e-6) continue;
      const xx = Math.round(x(t)) + 0.5;
      g.fillStyle = isMajor ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.12)';
      g.fillRect(xx, isMajor ? 14 : 22, 1, isMajor ? RULER_H - 14 : RULER_H - 22);
      if (isMajor) {
        g.fillStyle = '#a4a6ad';
        const wall = ((t + tz * 60) % 86400 + 86400) % 86400;
        const label = !synced ? formatClockTime(t, 0, step < 60) : wall < 1 || step >= 86400 ? `${formatDate(t, tz)}` : formatClockTime(t, tz, step < 60);
        g.fillText(label, xx + 4, 9);
        g.fillStyle = 'rgba(255,255,255,0.035)';
        g.fillRect(xx, RULER_H, 1, size.h - RULER_H);
      }
    }

    // Клипы.
    clipRows();
    const byCam = new Map<string, Placement[]>();
    for (const p of placements) {
      if (p.end < t0 || p.start > t1) continue;
      const arr = byCam.get(p.cameraId) ?? [];
      arr.push(p);
      byCam.set(p.cameraId, arr);
    }
    g.font = '11px "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif';
    const keyClips = new Set(Object.keys(state.controlFrames));
    for (const r of rows) {
      const list = byCam.get(r.cam.id) ?? [];
      const color = cameraColor(r.index);
      for (const p of list) {
        const x0 = x(p.start);
        const w = Math.max(2, x(p.end) - x0);
        const y0 = r.y + 6 + p.lane * ROW_H;
        const h = ROW_H - 12;
        const isSpeed = speedClips.has(p.clipId);
        // До синхронизации клипы серые, а клип с контрольным кадром — в цвет камеры: видно, где экран уже отмечен.
        const colored = synced || keyClips.has(p.clipId);
        g.globalAlpha = isSpeed ? 0.95 : synced ? (p.method === 'clock' ? 0.78 : 1) : colored ? 0.8 : 0.35;
        g.fillStyle = isSpeed ? '#ff5f57' : colored ? color : '#8a8d96';
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
          g.fillStyle = colored || isSpeed ? 'rgba(0,0,0,0.42)' : 'rgba(255,255,255,0.4)';
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

        // Выравнивание хода часов: в таймлинию монтажки вместо этой записи встанет выровненная копия. Штриховка
        // по нижнему краю — та же запись, растянутая; в подписи — имя копии.
        const drift = driftClips.get(p.clipId);
        if (drift && w > 3) {
          const band = Math.min(7, h / 3);
          g.save();
          g.clip();
          g.fillStyle = 'rgba(0,0,0,0.38)';
          g.fillRect(x0, y0 + h - band, w, band);
          g.strokeStyle = 'rgba(255,255,255,0.85)';
          g.lineWidth = 1.5;
          g.beginPath();
          for (let sx = Math.floor(x0 / 7) * 7 - band; sx < x0 + w; sx += 7) {
            g.moveTo(sx, y0 + h);
            g.lineTo(sx + band, y0 + h - band);
          }
          g.stroke();
          g.restore();
          // Контур клипа — снова текущий путь: по нему ниже рисуются рамки ошибки и выделения.
          g.beginPath();
          g.roundRect(x0, y0, w, h, Math.min(4, w / 2));
        }

        // Клип с контрольным кадром до синхронизации светится в цвет камеры.
        if (!synced && keyClips.has(p.clipId) && !isSpeed) {
          g.save();
          g.shadowColor = color;
          g.shadowBlur = 14;
          g.strokeStyle = color;
          g.lineWidth = 2;
          g.stroke();
          g.restore();
        }
        if (errorClips.has(p.clipId) && !isSpeed) {
          g.strokeStyle = '#ff5f57';
          g.lineWidth = 2;
          g.stroke();
        } else if (unsureClips[p.clipId] && !isSpeed && w > 3) {
          // Без сверки — пунктир: тёмная подложка и светлая штриховка видны на клипе любого цвета.
          g.save();
          g.lineWidth = 2;
          g.strokeStyle = 'rgba(0,0,0,0.55)';
          g.stroke();
          g.setLineDash([5, 4]);
          g.strokeStyle = '#ffd60a';
          g.stroke();
          g.restore();
        } else if (aloneClips.has(p.clipId) && !isSpeed && w > 3) {
          // Не с чем сверить — тонкая серая точка: это не недочёт, а единственная запись в это время.
          g.save();
          g.lineWidth = 1;
          g.setLineDash([2, 3]);
          g.strokeStyle = 'rgba(255,255,255,0.45)';
          g.stroke();
          g.restore();
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
          g.fillStyle = colored || isSpeed ? 'rgba(0,0,0,0.78)' : '#e0e1e5';
          const copyName = drift?.outName.split('/').pop();
          g.fillText(isSpeed ? `S&Q · ${clip?.name ?? ''}` : copyName ? `${clip?.name ?? ''} → ${copyName}` : clip?.name ?? '', x0 + 6, y0 + 13);
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

    // Контрольные кадры — флажок там, где камера сняла экран синхронизации.
    for (const f of Object.values(state.controlFrames)) {
      const p = placements.find((q) => q.clipId === f.clipId);
      const row = p && rows.find((r) => r.cam.id === p.cameraId);
      if (!p || !row) continue;
      const fx = Math.round(x(p.start + f.localSec));
      if (fx < -16 || fx > size.w + 16) continue;
      const top = row.y + 2 + p.lane * ROW_H;
      const bottom = row.y + ROW_H - 2 + p.lane * ROW_H;
      const ok = !synced || !state.controlIssues.some((i) => i.clipId === f.clipId && i.severity !== 'info');
      const glow = ok ? cameraColor(row.index) : '#ff9f0a';
      // Белый флажок со свечением в цвет камеры: виден и на сером клипе, и на клипе того же цвета.
      // Если экран в этом кадре не прочитался — флажок оранжевый.
      const flag = () => {
        g.fillRect(fx - 1, top, 2.5, bottom - top);
        g.beginPath();
        g.moveTo(fx + 1, top);
        g.lineTo(fx + 19, top + 7);
        g.lineTo(fx + 1, top + 14);
        g.closePath();
        g.fill();
      };
      g.save();
      g.fillStyle = ok ? '#ffffff' : '#ff9f0a';
      g.shadowColor = glow;
      g.shadowBlur = 14;
      flag();
      flag();
      g.shadowColor = 'rgba(0,0,0,0.55)';
      g.shadowBlur = 3;
      flag();
      g.restore();
    }

    g.restore();

    // За началом и концом съёмки — затемнение и граница.
    if (extent) {
      const xs = Math.round(x(extent.start));
      const xe = Math.round(x(extent.end));
      g.fillStyle = 'rgba(0,0,0,0.42)';
      if (xs > 0) g.fillRect(0, 0, xs, size.h);
      if (xe < size.w) g.fillRect(xe, 0, size.w - xe, size.h);
      g.fillStyle = 'rgba(255,255,255,0.22)';
      if (xs >= 0 && xs <= size.w) g.fillRect(xs, 0, 1, size.h);
      if (xe >= 0 && xe <= size.w) g.fillRect(xe, 0, 1, size.h);
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
  }, [size, viewH, vp, extent, rows, placements, synced, state.playhead, state.selectedClipId, state.audio, state.controlFrames, state.controlIssues, errorClips, unsureClips, aloneClips, speedClips, driftClips, tz, showWaves, waveVersion]);

  // К следующему клипу дорожки без сверки: выделить, поставить курсор на начало и показать, если он за краем.
  const nextUnsure = (cameraId: string) => {
    const ids = new Set(unsureByCam.get(cameraId)?.ids ?? []);
    const list = placements.filter((p) => p.cameraId === cameraId && ids.has(p.clipId)).sort((a, b) => a.start - b.start);
    if (!list.length) return;
    const cur = list.findIndex((p) => p.clipId === state.selectedClipId);
    const p = cur >= 0 ? list[(cur + 1) % list.length] : list.find((q) => q.start > (state.playhead ?? -Infinity) + 1e-3) ?? list[0];
    dispatch({ type: 'select-clip', clipId: p.clipId });
    dispatch({ type: 'play', playing: false });
    dispatch({ type: 'playhead', at: p.start });
    if (vp) {
      const span = size.w * vp.secPerPx;
      if (p.start < vp.start || p.start > vp.start + span * 0.9) dispatch({ type: 'viewport', viewport: clampViewport({ ...vp, start: p.start - span * 0.3 })! });
    }
  };

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

  const markControl = (cameraId: string, clipId: string, localSec: number) => {
    const cam = state.cameras.find((c) => c.id === cameraId);
    const others = Object.values(state.controlFrames).filter((f) => f.cameraId !== cameraId).length;
    dispatch({ type: 'set-control', frame: { cameraId, clipId, localSec } });
    dispatch({
      type: 'toast',
      text: others
        ? `Контрольный кадр «${cam?.name ?? 'Камера'}» отмечен. Теперь «Синхронизировать» → «Контрольный кадр + тайм-код + звук».`
        : `Контрольный кадр «${cam?.name ?? 'Камера'}» отмечен. Отметьте его и на других камерах, снимавших экран.`,
    });
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
    const at = Math.min(Math.max(timeAt(e.clientX), hit.start), hit.end);
    dispatch({ type: 'play', playing: false });
    dispatch({ type: 'playhead', at });
    setMenu({ x: Math.min(e.clientX - rect.left, rect.width - 260), y: Math.max(0, Math.min(e.clientY - rect.top, rect.height - 200)), clipId: hit.clipId, cameraId: hit.cameraId, localSec: at - hit.start });
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => {
      setMenu(null);
    };
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

  // Delete — удалить выделенный клип с таймлинии. На клавиатуре Mac эта клавиша приходит как Backspace.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const del = e.key === 'Delete' || (isMac && e.key === 'Backspace');
      if (!del || state.tab !== 'sync' || !state.selectedClipId) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
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
    // Курсор не уходит за начало и конец съёмки.
    const at = (clientX: number) => (extent ? Math.min(Math.max(timeAt(clientX), extent.start), extent.end) : timeAt(clientX));
    dispatch({ type: 'playhead', at: at(e.clientX) });
    const move = (ev: MouseEvent) => dispatch({ type: 'playhead', at: at(ev.clientX) });
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
      if (e.altKey) {
        e.preventDefault();
        setScrollY((v) => Math.max(0, Math.min(maxScroll, Math.min(v, maxScroll) + e.deltaY)));
        return;
      }
      if (!vp) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        dispatch({ type: 'viewport', viewport: zoomAround(vp, Math.exp(e.deltaY * 0.0015), e.clientX - rect.left) });
      } else {
        const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * vp.secPerPx;
        dispatch({ type: 'viewport', viewport: clampViewport({ ...vp, start: vp.start + d })! });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  // Перетаскивание папок и файлов на дорожки: всё, что брошено на дорожку, — в её камеру.
  // Над линейкой — на первую дорожку, ниже последней — на новую.
  const rowAtY = (clientY: number): number | 'new' => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const y = clientY - rect.top;
    const r = rows.find((row) => y >= row.y && y < row.y + row.h);
    if (r) return r.index;
    return rows.length && y < rows[0].y ? rows[0].index : 'new';
  };
  const onDragOver = (e: React.DragEvent, target: number | 'new') => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropRow(target);
  };
  const onDrop = (e: React.DragEvent, target: number | 'new') => {
    e.preventDefault();
    e.stopPropagation();
    setDropRow(null);
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    const cam = target === 'new' ? null : state.cameras[target];
    void addFolders(cam?.id ?? null, paths);
  };

  // Масштаб вокруг точки экрана: точка остаётся на месте, пока не упрёмся в начало или конец съёмки.
  const zoomAround = (v: Viewport, k: number, px: number): Viewport => {
    const t = v.start + px * v.secPerPx;
    const secPerPx = clampViewport({ start: v.start, secPerPx: v.secPerPx * k })!.secPerPx;
    return clampViewport({ secPerPx, start: t - px * secPerPx })!;
  };
  const zoom = (k: number) => {
    if (vp) dispatch({ type: 'viewport', viewport: zoomAround(vp, k, size.w / 2) });
  };

  const tracksBottom = rows.length ? rows[rows.length - 1].y + rows[rows.length - 1].h : RULER_H;
  const hintBelow = size.h - tracksBottom >= 44;

  return (
    <div className="timeline">
      <div
        className="tl-heads"
        onDragOver={(e) => onDragOver(e, 'new')}
        onDragLeave={() => setDropRow(null)}
        onDrop={(e) => onDrop(e, 'new')}
      >
        <div
          className="tl-ruler-head"
          onDragOver={(e) => { e.stopPropagation(); onDragOver(e, rows[0]?.index ?? 'new'); }}
          onDrop={(e) => onDrop(e, rows[0]?.index ?? 'new')}
        >
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
        <div className="tl-rows" ref={headsRef} style={{ height: viewH }} onScroll={(e) => setScrollY(e.currentTarget.scrollTop)}>
        {rows.map((r) => (
          <div
            key={r.cam.id}
            className={`tl-head ${dropRow === r.index ? 'drop' : ''}`}
            style={{ height: r.h }}
            onClick={() => dispatch({ type: 'view-mode', mode: state.viewMode, cameraId: r.cam.id })}
            onDragOver={(e) => { e.stopPropagation(); onDragOver(e, r.index); }}
            onDragLeave={() => setDropRow(null)}
            onDrop={(e) => onDrop(e, r.index)}
          >
            <span className="t">
              {r.cam.clips.length > 0 && r.cam.clips.every((c) => !c.hasVideo)
                ? <IconHeadphones className="icon track-kind" style={{ color: cameraColor(r.index) }} />
                : <IconCamera className="icon track-kind" style={{ color: cameraColor(r.index) }} />}
              <span className="name">{r.cam.name}</span>
              {(() => {
                const u = unsureByCam.get(r.cam.id);
                if (!u?.ids.length || r.cam.scanning) return null;
                return (
                  <button
                    className="tl-unsure"
                    title={`Без сверки по звуку — ${pluralRu(u.ids.length, 'клип', 'клипа', 'клипов')} (на дорожке обведены пунктиром). Обычно они стоят верно, по тайм-коду и часам, но звук этого не подтвердил:\n${unsureDetails(u)}\n\nЩелчок — к следующему такому клипу.`}
                    onClick={(e) => { e.stopPropagation(); nextUnsure(r.cam.id); }}
                  >
                    {u.ids.length} без сверки
                  </button>
                );
              })()}
            </span>
            <span className="s-row">
              <span className="s">
                {r.cam.scanning
                  ? `Читаю ${r.cam.scanning.done} из ${r.cam.scanning.total || '…'}`
                  : r.cam.clips.length
                    ? trackInfo(r.cam)
                    : 'Перетащите папку или файлы'}
              </span>
              {state.soundOn && r.cam.clips.some((c) => c.audioChannels > 0) && (
                <span className="tl-mix" onClick={(e) => e.stopPropagation()}>
                  <button
                    className={`mix-btn ${state.mix.muted.includes(r.cam.id) ? 'on mute' : ''} ${!audible(state.mix, r.cam.id) ? 'silent' : ''}`}
                    title="Mute — выключить звук дорожки при проигрывании"
                    aria-pressed={state.mix.muted.includes(r.cam.id)}
                    onClick={() => dispatch({ type: 'mix', cameraId: r.cam.id, kind: 'mute' })}
                  >M</button>
                  <button
                    className={`mix-btn ${state.mix.solo.includes(r.cam.id) ? 'on solo' : ''}`}
                    title="Solo — слушать только эту дорожку (можно несколько): так слышно, совпадают ли две записи"
                    aria-pressed={state.mix.solo.includes(r.cam.id)}
                    onClick={() => dispatch({ type: 'mix', cameraId: r.cam.id, kind: 'solo' })}
                  >S</button>
                </span>
              )}
            </span>
          </div>
        ))}
        </div>
        <div
          className={`tl-add ${dropRow === 'new' ? 'drop' : ''}`}
          onDragOver={(e) => { e.stopPropagation(); onDragOver(e, 'new'); }}
          onDragLeave={() => setDropRow(null)}
          onDrop={(e) => onDrop(e, 'new')}
        >
          <button className="tl-add-btn" onClick={() => dispatch({ type: 'add-camera' })} title="Новая дорожка для камеры">
            <IconPlus /> <IconCamera className="icon" /> Камера
          </button>
          <button
            className="tl-add-btn"
            onClick={() => dispatch({ type: 'add-camera', camera: { ...newCamera(state.cameras.length + 1), name: `Звук ${state.cameras.filter((c) => /^Звук \d+$/.test(c.name)).length + 1}` } })}
            title="Новая дорожка для рекордера, петлички или звука с телефона"
          >
            <IconPlus /> <IconHeadphones className="icon" /> Звук
          </button>
        </div>
      </div>
      <div
        className="tl-canvas-wrap"
        ref={wrapRef}
        onDragOver={(e) => onDragOver(e, rowAtY(e.clientY))}
        onDragLeave={() => setDropRow(null)}
        onDrop={(e) => onDrop(e, rowAtY(e.clientY))}
      >
        <canvas ref={canvasRef} onMouseDown={onMouseDown} onContextMenu={onContextMenu} />
        {dropRow !== null && (() => {
          // Куда упадут файлы: подсветка дорожки на всю ширину или места под дорожками для новой.
          const r = dropRow === 'new' ? null : rows.find((row) => row.index === dropRow);
          const top = r ? r.y : tracksBottom;
          const height = r ? r.h : Math.max(44, size.h - tracksBottom);
          return <div className={`tl-drop ${r ? '' : 'new'}`} style={{ top, height }}>{r ? '' : 'Новая дорожка'}</div>;
        })()}
        {menu && (() => {
          const clip = state.cameras.find((c) => c.id === menu.cameraId)?.clips.find((c) => c.id === menu.clipId);
          if (!clip) return null;
          return (
            <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} role="menu" onMouseDown={(e) => e.stopPropagation()}>
              <div className="ctx-title">{clip.name}</div>
              {unsureClips[clip.id] && <div className="ctx-note">{unsureNote(unsureClips[clip.id])}</div>}
              {aloneClips.has(clip.id) && <div className="ctx-note muted">{ALONE_NOTE}</div>}
              <button role="menuitem" className="ctx-item" onClick={() => { markControl(menu.cameraId, menu.clipId, menu.localSec); setMenu(null); }}>
                {state.controlFrames[clip.id] ? 'Перенести контрольный кадр сюда' : 'Выбрать контрольным кадром'}
                <span className="ctx-hint">здесь в кадре экран синхронизации</span>
              </button>
              {state.controlFrames[clip.id] && (
                <button role="menuitem" className="ctx-item" onClick={() => { dispatch({ type: 'clear-control', clipId: clip.id }); setMenu(null); }}>
                  Убрать контрольный кадр
                </button>
              )}
              <button role="menuitem" className="ctx-item danger" onClick={() => { removeClip(menu.cameraId, menu.clipId); setMenu(null); }}>
                Удалить с таймлинии
                <span className="ctx-hint">{isMac ? '⌫' : 'Del'} · файл на диске останется</span>
              </button>
              <button role="menuitem" className="ctx-item" onClick={() => { void api.reveal(clip.path); setMenu(null); }}>
                Показать файл в папке
              </button>
            </div>
          );
        })()}
        {!extent && (
          <div className="tl-hint">
            Перетащите папку или файлы камеры либо рекордера на дорожку.<br />Каждая камера и рекордер — на свою дорожку.
          </div>
        )}
        {extent && !synced && !state.cameras.some((c) => c.scanning) && (
          // Под дорожками есть место — подсказка там; нет — плашкой со своим фоном, чтобы не сливаться с клипами.
          <div className={`tl-hint ${hintBelow ? 'below' : 'pill'}`} style={hintBelow ? { top: tracksBottom + (size.h - tracksBottom) / 2 } : undefined}>
            Клипы лежат подряд, по порядку съёмки. Отметьте контрольные кадры и нажмите «Синхронизировать»
          </div>
        )}
      </div>
    </div>
  );
}
