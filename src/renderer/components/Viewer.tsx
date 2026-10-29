import { useEffect, useMemo, useRef, useState } from 'react';
import type { Camera, ClipMeta, Placement } from '../../core/types.ts';
import { formatDate, formatDurationHuman, formatTimecodeAt } from '../../core/format.ts';
import { useApp } from '../App.tsx';
import { api, cameraColor, mediaUrl } from '../api.ts';
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

function Tile({ cam, index, big }: { cam: Camera; index: number; big: boolean }) {
  const { state, dispatch, placements } = useApp();
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
      {hit && !hit.clip.hasVideo && <div className="tile-note">Только звук · {hit.clip.name}</div>}
      {!hit && (
        <div className="tile-note">
          {cam.clips.length === 0
            ? 'Добавьте папку этой камеры'
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
  const { state, dispatch, placements, fps } = useApp();
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
  const step = (dir: 1 | -1) => {
    if (state.playhead === null) return;
    dispatch({ type: 'play', playing: false });
    dispatch({ type: 'playhead', at: state.playhead + dir / fps });
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
        <span className="spacer" />
        {state.playhead !== null && (
          <>
            <span className="tc-date">{formatDate(state.playhead, tz)}</span>
            <span className="tc-big">{formatTimecodeAt(state.playhead, tz, fps)}</span>
          </>
        )}
      </div>
      <div className="tiles" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
        {shown.map((cam) => <Tile key={cam.id} cam={cam} index={cams.indexOf(cam)} big={single && cams.length > 1} />)}
      </div>
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
