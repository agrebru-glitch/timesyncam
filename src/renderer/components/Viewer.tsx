import { useEffect, useMemo, useRef, useState } from 'react';
import type { Camera, ClipMeta, Placement } from '../../core/types.ts';
import { formatDate, formatDurationHuman, formatTimecodeAt } from '../../core/format.ts';
import { PREVIEW_KEY, useApp } from '../App.tsx';
import { api, cameraColor, mediaUrl } from '../api.ts';
import { getWaveform, useWaveformVersion } from '../waveforms.ts';
import { WAVE_RATE } from '../../core/audioSync.ts';
import { IconFrameBack, IconFrameFwd, IconNext, IconPause, IconPlay, IconPrev } from '../icons.tsx';

interface Hit {
  placement: Placement;
  clip: ClipMeta;
}

function clipAt(cam: Camera, placements: Placement[], t: number | null): { hit: Hit | null; next: Placement | null } {
  if (t === null) return { hit: null, next: null };
  let next: Placement | null = null;
  for (const p of placements) {
    if (p.cameraId !== cam.id) continue;
    if (p.start <= t && t < p.end) {
      const clip = cam.clips.find((c) => c.id === p.clipId);
      if (clip) return { hit: { placement: p, clip }, next: null };
    }
    if (p.start > t && (!next || p.start < next.start)) next = p;
  }
  return { hit: null, next };
}

const AUDIO_WINDOW = 6; // секунд звука по обе стороны от курсора

// Камера только со звуком (рекордер): вместо видео — полупрозрачная волна вокруг курсора.
function AudioTile({ cam, index, hit, next }: { cam: Camera; index: number; hit: Hit | null; next: Placement | null }) {
  const { state, synced } = useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const waveVersion = useWaveformVersion();
  const wave = hit ? getWaveform(hit.clip.id) : undefined;
  const local = hit && state.playhead !== null ? state.playhead - hit.placement.start : 0;

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    cv.width = Math.floor(w * dpr);
    cv.height = Math.floor(h * dpr);
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!wave) return;
    const mid = h / 2;
    const amp = h * 0.38;
    const secPerPx = (AUDIO_WINDOW * 2) / w;
    g.fillStyle = cameraColor(index);
    g.globalAlpha = 0.45;
    for (let px = 0; px < w; px++) {
      const t0 = local - AUDIO_WINDOW + px * secPerPx;
      const i0 = Math.floor(t0 * WAVE_RATE);
      const i1 = Math.max(i0 + 1, Math.ceil((t0 + secPerPx) * WAVE_RATE));
      let peak = 0;
      for (let i = Math.max(0, i0); i < Math.min(wave.length, i1); i++) if (wave[i] > peak) peak = wave[i];
      if (peak < 4) continue;
      const a = Math.max(0.5, (peak / 255) * amp);
      g.fillRect(px, mid - a, 1, a * 2);
    }
    g.globalAlpha = 1;
    g.fillStyle = '#ff5f57';
    g.fillRect(Math.round(w / 2), 0, 1.5, h);
  }, [wave, local, index, waveVersion]);

  return (
    <>
      <canvas ref={canvasRef} className="tile-wave" />
      <div className="tile-audio-note">
        <span className="tile-audio-title">Только звук</span>
        {!hit && (
          <span>
            {!synced
              ? next ? 'Между записями' : 'Записи рекордера закончились'
              : next && state.playhead !== null ? `Не писал в этот момент. Следующая запись через ${formatDurationHuman(next.start - state.playhead)}` : 'Не писал в этот момент'}
          </span>
        )}
        {hit && !wave && <span>Строю волну…</span>}
      </div>
    </>
  );
}

function Tile({ cam, index, big }: { cam: Camera; index: number; big: boolean }) {
  const { state, dispatch, placements, synced } = useApp();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [still, setStill] = useState<string | null>(null);
  const { hit, next } = clipAt(cam, placements, state.playhead);
  const source = hit ? (hit.clip.proxyPath ?? (hit.clip.playable ? hit.clip.path : null)) : null;
  const expected = hit && state.playhead !== null ? state.playhead - hit.placement.start : 0;
  const isActive = state.activeCameraId === cam.id || (state.activeCameraId === null && index === 0);
  const muted = !isActive;

  // Видео: держим кадр в соответствии с курсором таймлинии.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !source) return;
    if (state.playing) {
      if (v.paused) void v.play().catch(() => undefined);
      if (Math.abs(v.currentTime - expected) > 0.25) v.currentTime = expected;
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - expected) > 0.02) v.currentTime = expected;
    }
  }, [source, expected, state.playing]);

  // Без прокси — стоп-кадр через ffmpeg, когда курсор остановился.
  const stillKey = hit && hit.clip.hasVideo && !source && !state.playing ? `${hit.clip.path}@${expected.toFixed(2)}` : null;
  useEffect(() => {
    if (!stillKey || !hit) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const img = await api.grabFrame(hit.clip.path, expected);
      if (!cancelled && img) setStill(img);
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [stillKey]);
  useEffect(() => {
    if (!hit) setStill(null);
  }, [hit?.clip.id]);

  const flag = !hit || !hit.clip.hasVideo ? null : source ? (hit.clip.proxyPath ? 'прокси' : 'оригинал') : 'стоп-кадр';
  const audioOnly = cam.clips.length > 0 && cam.clips.every((c) => !c.hasVideo);

  return (
    <div
      className={`tile ${isActive && !big ? 'active' : ''}`}
      onClick={() => dispatch({ type: 'view-mode', mode: state.viewMode, cameraId: cam.id })}
      onDoubleClick={() => dispatch({ type: 'view-mode', mode: big ? 'multi' : 'single', cameraId: cam.id })}
      title={big ? 'Двойной щелчок — вернуться к мультивью' : 'Двойной щелчок — показать крупно'}
    >
      {source && hit && (
        <video
          ref={videoRef}
          src={mediaUrl(source)}
          muted={muted}
          preload="auto"
          onLoadedMetadata={(e) => { (e.target as HTMLVideoElement).currentTime = expected; }}
        />
      )}
      {!source && hit && hit.clip.hasVideo && still && <img src={still} alt="" />}
      {audioOnly && <AudioTile cam={cam} index={index} hit={hit} next={next} />}
      {!audioOnly && hit && !hit.clip.hasVideo && <div className="tile-note">Только звук · {hit.clip.name}</div>}
      {!audioOnly && !hit && (
        <div className="tile-note">
          {cam.clips.length === 0
            ? 'Добавьте папку этой камеры'
            : !synced
              ? next ? 'Между клипами' : 'Клипы этой камеры закончились'
            : next && state.playhead !== null
              ? `Камера не снимала. Следующий клип через ${formatDurationHuman(next.start - state.playhead)}`
              : 'Камера не снимала в этот момент'}
        </div>
      )}
      {flag && <span className="tile-flag">{flag}</span>}
      <div className="tile-label">
        <span className="cam-dot" style={{ background: cameraColor(index) }} />
        <span>{cam.name}</span>
        {hit && <span style={{ color: 'var(--text-2)' }}>{hit.clip.name}</span>}
      </div>
    </div>
  );
}

export function Viewer() {
  const { state, dispatch, placements, synced, fps } = useApp();
  const tz = state.sync?.displayTzOffsetMin ?? -new Date().getTimezoneOffset();
  const cams = state.cameras;
  const single = state.viewMode === 'single' || cams.length === 1;
  const active = cams.find((c) => c.id === state.activeCameraId) ?? cams[0];
  const shown = single ? [active] : cams;
  const cols = shown.length <= 1 ? 1 : shown.length <= 4 ? 2 : shown.length <= 9 ? 3 : 4;
  const rows = Math.ceil(shown.length / cols);

  const starts = useMemo(() => [...new Set(placements.map((p) => p.start))].sort((a, b) => a - b), [placements]);
  const jump = (dir: 1 | -1) => {
    const t = state.playhead ?? 0;
    const target = dir > 0 ? starts.find((s) => s > t + 0.01) : [...starts].reverse().find((s) => s < t - 0.01);
    if (target !== undefined) dispatch({ type: 'playhead', at: target });
  };
  const setPreview = (on: boolean) => {
    dispatch({ type: 'preview', on });
    try {
      localStorage.setItem(PREVIEW_KEY, on ? '1' : '0');
    } catch {
      // запоминать необязательно
    }
  };
  const step = (dir: 1 | -1) => {
    if (state.playhead === null) return;
    dispatch({ type: 'play', playing: false });
    const at = state.playhead + dir / fps;
    dispatch({ type: 'playhead', at: starts.length ? Math.min(Math.max(at, starts[0]), Math.max(...placements.map((p) => p.end))) : at });
  };

  return (
    <section className="viewer">
      <div className="viewer-bar">
        {cams.length > 1 && (
          <div className="seg">
            <button className={!single ? 'on' : ''} onClick={() => dispatch({ type: 'view-mode', mode: 'multi' })}>Мультивью</button>
            <button className={single ? 'on' : ''} onClick={() => dispatch({ type: 'view-mode', mode: 'single' })}>Одна камера</button>
          </div>
        )}
        <button
          className={`btn small ${state.previewOn ? '' : 'ghost'}`}
          aria-pressed={state.previewOn}
          onClick={() => setPreview(!state.previewOn)}
          title={state.previewOn ? 'Выключить показ видео — программа станет легче на слабом компьютере' : 'Включить показ видео'}
        >
          {state.previewOn ? 'Предпросмотр вкл.' : 'Предпросмотр выкл.'}
        </button>
        <span className="spacer" />
        {state.playhead !== null && (
          <>
            {/* До синхронизации времени суток ещё нет — показываем место в кучке клипов. */}
            <span className="tc-date">{synced ? formatDate(state.playhead, tz) : 'до синхронизации'}</span>
            <span className="tc-big">{formatTimecodeAt(state.playhead, synced ? tz : 0, fps)}</span>
          </>
        )}
      </div>
      {state.previewOn ? (
        <div className="tiles" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
          {shown.map((cam) => <Tile key={cam.id} cam={cam} index={cams.indexOf(cam)} big={single && cams.length > 1} />)}
        </div>
      ) : (
        <div className="tiles preview-off">
          <div className="preview-off-box">
            <b>Предпросмотр выключен</b>
            <span>Видео не читается и не проигрывается — синхронизация и экспорт работают как обычно, курсор по таймлинии ходит.</span>
            <button className="btn small" onClick={() => setPreview(true)}>Включить</button>
          </div>
        </div>
      )}
      <div className="transport">
        <button className="round" aria-label="Предыдущий клип" title="Предыдущий клип" onClick={() => jump(-1)}><IconPrev /></button>
        <button className="round" aria-label="Кадр назад" title="Кадр назад (←)" onClick={() => step(-1)}><IconFrameBack /></button>
        <button
          className="round play"
          aria-label={state.playing ? 'Пауза' : 'Воспроизвести'}
          title="Пробел"
          onClick={() => state.playhead !== null && dispatch({ type: 'play', playing: !state.playing })}
        >
          {state.playing ? <IconPause /> : <IconPlay />}
        </button>
        <button className="round" aria-label="Кадр вперёд" title="Кадр вперёд (→)" onClick={() => step(1)}><IconFrameFwd /></button>
        <button className="round" aria-label="Следующий клип" title="Следующий клип" onClick={() => jump(1)}><IconNext /></button>
      </div>
    </section>
  );
}
