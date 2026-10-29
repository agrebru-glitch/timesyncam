import { useMemo, useState } from 'react';
import type { Camera, CameraSync, TimecodeTrust } from '../../core/types.ts';
import { formatClockTime, formatDate, formatDurationHuman, formatFps, formatShift, formatSize, parseShift, pluralRu, resolutionLabel } from '../../core/format.ts';
import { rateValue } from '../../core/timecode.ts';
import { useApp } from '../App.tsx';
import { api, cameraColor } from '../api.ts';
import { IconFolder, IconPlus, IconX } from '../icons.tsx';

function mostCommon(values: (string | undefined | null)[]): string | undefined {
  const m = new Map<string, number>();
  for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function uniq(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

const TRUST_LABELS: Record<TimecodeTrust, string> = {
  auto: 'Определить автоматически',
  absolute: 'Точный — синхронизирован (Tentacle, jam sync)',
  relative: 'Не синхронизирован — только паузы между клипами',
  ignore: 'Не использовать тайм-код',
};

function timeSourceText(cs: CameraSync | undefined, cam: Camera): { title: string; sub: string } {
  if (!cs || !cs.timeSource) return { title: 'Ещё не синхронизирована', sub: 'Нажмите «Синхронизировать»' };
  if (cs.timeSource === 'timecode') {
    return {
      title: 'Точный тайм-код',
      sub: cam.timecodeTrust === 'absolute'
        ? 'Опорная камера: клипы стоят по тайм-коду, точно до кадра'
        : 'Тайм-код совпадает с часами камеры — клипы стоят по нему, точно до кадра',
    };
  }
  if (cs.timeSource === 'timecode-and-clock') {
    const off = cs.timecodeVsClockSec ?? 0;
    return {
      title: 'Тайм-код + часы камеры',
      sub: `Паузы между клипами — точно до кадра. Тайм-код ${off < 0 ? 'убегает вперёд' : 'отстаёт'} от часов на ${formatDurationHuman(off)} — это учтено.`,
    };
  }
  return {
    title: 'Только часы камеры',
    sub: cs.recRun ? 'Тайм-код шёл только во время записи. Точность около секунды.' : 'Точность около секунды. Точно подгоните по хлопку.',
  };
}

function CameraCard({ cam, index }: { cam: Camera; index: number }) {
  const { state, dispatch, synced, issues, fps, addFolders } = useApp();
  const [editing, setEditing] = useState(false);
  const [shiftText, setShiftText] = useState<string | null>(null);
  const [drop, setDrop] = useState(false);
  const cs = state.sync?.cameras.find((c) => c.cameraId === cam.id);
  const tz = state.sync?.displayTzOffsetMin ?? -new Date().getTimezoneOffset();

  const info = useMemo(() => {
    const clips = cam.clips;
    const video = clips.filter((c) => c.hasVideo);
    const fpsList = uniq(video.map((c) => (c.rate ? formatFps(rateValue(c.rate)) : null))).sort((a, b) => parseFloat(a) - parseFloat(b));
    return {
      model: mostCommon(clips.map((c) => c.camera.model)),
      lens: mostCommon(clips.map((c) => c.camera.lens)),
      gamma: uniq(clips.map((c) => c.camera.gamma)).join(', '),
      count: clips.length,
      audioOnly: clips.length > 0 && video.length === 0,
      duration: clips.reduce((s, c) => s + c.durationSec, 0),
      size: clips.reduce((s, c) => s + c.sizeBytes, 0),
      res: uniq(video.map((c) => resolutionLabel(c.width, c.height))).join(', '),
      fps: fpsList.join(', '),
      speedActive: video.filter((c) => c.captureFps !== null && !cam.excludedClipIds.includes(c.id)).length,
      excluded: cam.excludedClipIds.length,
      codec: uniq(clips.map((c) => c.codecLabel)).slice(0, 2).join(', '),
      channels: Math.max(0, ...clips.map((c) => c.audioChannels)),
      proxies: clips.filter((c) => c.proxyPath).length,
      playable: clips.filter((c) => c.proxyPath || c.playable).length,
    };
  }, [cam.clips, cam.excludedClipIds]);

  const camIssues = issues.filter((i) => i.cameraId === cam.id);
  const status = cam.scanning
    ? { cls: 'wait', text: cam.scanning.total ? `Читаю ${cam.scanning.done} из ${cam.scanning.total}` : 'Ищу клипы…' }
    : cam.clips.length === 0
      ? { cls: 'idle', text: 'Пусто' }
      : !synced
        ? { cls: 'wait', text: 'Нужна синхронизация' }
        : camIssues.some((i) => i.severity === 'error')
          ? { cls: 'err', text: 'Есть ошибки' }
          : camIssues.some((i) => i.severity === 'warning')
            ? { cls: 'warn', text: 'Проверьте' }
            : { cls: 'ok', text: 'Готово' };

  const ts = timeSourceText(synced ? cs : undefined, cam);
  const isActive = state.activeCameraId === cam.id;

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDrop(false);
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length) void addFolders(cam.id, paths);
  };

  const commitShift = () => {
    if (shiftText === null) return;
    const v = parseShift(shiftText, fps);
    if (v !== null) dispatch({ type: 'shift-camera', cameraId: cam.id, absoluteSec: v });
    setShiftText(null);
  };

  if (cam.clips.length === 0 && !cam.scanning) {
    return (
      <div
        className={`card empty-card ${drop ? 'drop' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDrop(true); }}
        onDragLeave={() => setDrop(false)}
        onDrop={onDrop}
      >
        <div className="card-head" style={{ justifyContent: 'center' }}>
          <span className="cam-dot" style={{ background: cameraColor(index) }} />
          <span style={{ fontWeight: 600 }}>{cam.name}</span>
          {state.cameras.length > 1 && (
            <button className="btn small ghost" aria-label="Убрать камеру" onClick={() => dispatch({ type: 'remove-camera', cameraId: cam.id })}><IconX /></button>
          )}
        </div>
        <p style={{ margin: '4px 0 10px' }}>Перетащите сюда папку с клипами этой камеры</p>
        <button className="btn small" onClick={async () => { const f = await api.pickFolders(); if (f) void addFolders(cam.id, f); }}>
          <IconFolder /> Выбрать папку
        </button>
      </div>
    );
  }

  return (
    <div
      className={`card ${isActive ? 'active' : ''} ${drop ? 'drop' : ''}`}
      onClick={() => dispatch({ type: 'view-mode', mode: state.viewMode, cameraId: cam.id })}
      onDragOver={(e) => { e.preventDefault(); setDrop(true); }}
      onDragLeave={() => setDrop(false)}
      onDrop={onDrop}
    >
      <div className="card-head">
        <span className="cam-dot" style={{ background: cameraColor(index) }} />
        <span className="cam-name" onDoubleClick={() => setEditing(true)} title="Двойной щелчок — переименовать">
          {editing ? (
            <input
              autoFocus
              defaultValue={cam.name}
              onBlur={(e) => { dispatch({ type: 'rename-camera', cameraId: cam.id, name: e.target.value.trim() }); setEditing(false); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(false); }}
            />
          ) : cam.name}
        </span>
        <span className={`status ${status.cls}`}>{status.text}</span>
        <button className="btn small ghost" aria-label="Убрать камеру из проекта" title="Убрать камеру из проекта (файлы не удаляются)" onClick={(e) => { e.stopPropagation(); dispatch({ type: 'remove-camera', cameraId: cam.id }); }}><IconX /></button>
      </div>
      {cam.scanning && cam.scanning.total > 0 && (
        <div className="progress"><div style={{ width: `${(cam.scanning.done / cam.scanning.total) * 100}%` }} /></div>
      )}
      {cam.clips.length > 0 && (
        <>
          <dl className="facts">
            <dt>Камера</dt>
            <dd>{info.model ?? 'Неизвестная модель'}{info.lens && <span className="sub">{info.lens}</span>}</dd>
            <dt>Материал</dt>
            <dd className="num">{pluralRu(info.count, 'клип', 'клипа', 'клипов')} · {formatDurationHuman(info.duration)} · {formatSize(info.size)}</dd>
            {!info.audioOnly && (
              <>
                <dt>Видео</dt>
                <dd>
                  {[info.res, info.fps, info.gamma].filter(Boolean).join(' · ')}
                  {info.codec && <span className="sub">{info.codec}</span>}
                  {info.speedActive > 0 && (
                    <span className="sub" style={{ color: 'var(--danger)' }}>
                      S&Q: {info.speedActive} — помечены красным
                    </span>
                  )}
                </dd>
              </>
            )}
            <dt>Звук</dt>
            <dd>{info.channels ? pluralRu(info.channels, 'канал', 'канала', 'каналов') : 'нет'}{info.audioOnly && <span className="sub">{info.codec}</span>}</dd>
            {synced && cs?.start != null && cs.end != null && (
              <>
                <dt>Съёмка</dt>
                <dd className="num">{formatDate(cs.start, tz)}, {formatClockTime(cs.start, tz, false)}–{formatClockTime(cs.end, tz, false)}</dd>
              </>
            )}
            {!info.audioOnly && (
              <>
                <dt>Просмотр</dt>
                <dd>
                  {info.proxies ? `Прокси для ${info.proxies} из ${info.count}` : info.playable ? 'Оригиналы' : 'Стоп-кадры'}
                  {info.playable < info.count && <span className="sub">Без прокси клипы показываются стоп-кадрами</span>}
                </dd>
              </>
            )}
            <dt>Время</dt>
            <dd>{ts.title}<span className="sub">{ts.sub}</span></dd>
            {info.excluded > 0 && (
              <>
                <dt>Убрано</dt>
                <dd>
                  {pluralRu(info.excluded, 'клип', 'клипа', 'клипов')} не попадут на таймлинию
                  <span className="sub">
                    Файлы на диске не тронуты.{' '}
                    <button className="btn small ghost" style={{ height: 20, padding: '0 6px' }} onClick={(e) => { e.stopPropagation(); dispatch({ type: 'restore-clips', cameraId: cam.id }); }}>Вернуть</button>
                  </span>
                </dd>
              </>
            )}
          </dl>

          <div className="section-label">Тайм-код камеры</div>
          <select
            className="select"
            value={cam.timecodeTrust}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => dispatch({ type: 'set-trust', cameraId: cam.id, trust: e.target.value as TimecodeTrust })}
          >
            {(Object.keys(TRUST_LABELS) as TimecodeTrust[]).map((k) => <option key={k} value={k}>{TRUST_LABELS[k]}</option>)}
          </select>

          <div className="section-label">Сдвинуть все клипы камеры</div>
          <div className="shift-row" onClick={(e) => e.stopPropagation()}>
            <button className="btn small" title="На секунду раньше" onClick={() => dispatch({ type: 'shift-camera', cameraId: cam.id, deltaSec: -1 })}>−1 с</button>
            <button className="btn small" title="На кадр раньше" onClick={() => dispatch({ type: 'shift-camera', cameraId: cam.id, deltaSec: -1 / fps })}>−1 к</button>
            <input
              className="shift-value"
              value={shiftText ?? formatShift(cam.manualShiftSec, fps)}
              onChange={(e) => setShiftText(e.target.value)}
              onBlur={commitShift}
              onKeyDown={(e) => { if (e.key === 'Enter') commitShift(); if (e.key === 'Escape') setShiftText(null); }}
              title="Часы:минуты:секунды:кадры. Минус — раньше, плюс — позже"
            />
            <button className="btn small" title="На кадр позже" onClick={() => dispatch({ type: 'shift-camera', cameraId: cam.id, deltaSec: 1 / fps })}>+1 к</button>
            <button className="btn small" title="На секунду позже" onClick={() => dispatch({ type: 'shift-camera', cameraId: cam.id, deltaSec: 1 })}>+1 с</button>
            {cam.manualShiftSec !== 0 && (
              <button className="btn small ghost reset" onClick={() => dispatch({ type: 'shift-camera', cameraId: cam.id, absoluteSec: 0 })}>Сбросить сдвиг</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function CameraPanel() {
  const { state, dispatch } = useApp();
  return (
    <aside className="side">
      {state.cameras.map((cam, i) => <CameraCard key={cam.id} cam={cam} index={i} />)}
      <button className="btn" style={{ justifyContent: 'center' }} onClick={() => dispatch({ type: 'add-camera' })}>
        <IconPlus /> Добавить камеру
      </button>
    </aside>
  );
}
