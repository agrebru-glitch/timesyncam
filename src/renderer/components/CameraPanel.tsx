import { useMemo, useState } from 'react';
import type { Camera, CameraSync, TimecodeTrust } from '../../core/types.ts';
import type { State } from '../state.ts';
import type { AudioCameraResult } from '../../core/audioSync.ts';
import { checkLimit, formatSigned } from '../../core/audioSync.ts';
import { formatClockTime, formatDate, formatDurationHuman, formatShift, formatSize, pluralRu } from '../../core/format.ts';
import { useApp } from '../App.tsx';
import { api, cameraColor } from '../api.ts';
import { IconCamera, IconFolder, IconHeadphones, IconPlus, IconX } from '../icons.tsx';

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
    // Откуда это известно — на примере первого клипа: что пишет тайм-код и что показывали часы камеры.
    const ex = [...cam.clips].filter((c) => c.tc && c.clock && c.clock.source !== 'file').sort((a, b) => a.clock!.epochSec - b.clock!.epochSec)[0];
    const example = ex ? ` Например, ${ex.name}: тайм-код ${ex.tc!.text.slice(0, 8)}, часы камеры ${formatClockTime(ex.clock!.epochSec, ex.clock!.tzOffsetMin ?? -new Date().getTimezoneOffset(), true)}.` : '';
    return {
      title: 'Тайм-код + часы камеры',
      sub: `Паузы между клипами — точно до кадра. Тайм-код ${off < 0 ? 'убегает вперёд' : 'отстаёт'} от часов на ${formatDurationHuman(off)} — это учтено.${example}`,
    };
  }
  return {
    title: 'Только часы камеры',
    sub: cs.recRun ? 'Тайм-код шёл только во время записи. Точность около секунды.' : 'Точность около секунды. Точно подгоните по хлопку.',
  };
}

// Контрольный кадр: отмечен ли, прочитан ли экран синхронизации и насколько точно.
function controlText(state: State, cam: Camera, synced: boolean): { title: string; sub?: string; tone?: 'warn' | 'ok' } | null {
  const marked = Object.values(state.controlFrames).filter((f) => f.cameraId === cam.id).length;
  if (!marked) return null;
  if (state.qrRun) return { title: 'Читаю экран синхронизации…' };
  if (!synced || state.syncMode !== 'control' || !state.control) {
    return { title: 'Контрольный кадр отмечен', sub: 'Синхронизировать → «Контрольный кадр + тайм-код + звук»' };
  }
  const c = state.control[cam.id];
  if (!c) return { title: 'Экран синхронизации не прочитан', sub: 'Камера осталась по тайм-коду и звуку', tone: 'warn' };
  const ms = Math.max(1, Math.round(c.precisionSec * 1000));
  return {
    title: `По экрану синхронизации, ${formatSigned(c.correction)}`,
    sub: c.transitions ? `Точность ±${ms} мс · смен кода: ${c.transitions}` : `Точность около ±${ms} мс — экран снят меньше секунды`,
    tone: c.transitions ? 'ok' : 'warn',
  };
}

// Точность по звуку — в миллисекундах: «±0,0 с» о ней ничего не скажет.
function accuracyText(sec: number): string {
  return `точность ±${sec < 1 ? `${Math.max(1, Math.round(sec * 1000))} мс` : formatDurationHuman(sec)}`;
}

function audioText(au: AudioCameraResult | undefined, cam: Camera, running: boolean): { title: string; sub?: string; tone?: 'warn' | 'ok' } | null {
  if (running) return { title: 'Сверяю…' };
  if (!au) return null;
  const clips = au.anchors.filter((a) => a.role !== 'weak' && a.role !== 'ignored').length;
  // Точность по звуку — без расстояния до сцены: звук идёт около 3 мс на метр, его по звуку не видно.
  const acc = au.accuracySec != null ? ` · ${accuracyText(au.accuracySec)}` : '';
  switch (au.status) {
    case 'reference':
      return { title: 'Опорная для сверки', sub: 'По её звуку выравниваются остальные камеры' };
    case 'checked':
      return au.correction !== null && Math.abs(au.correction) > checkLimit(au.anchors)
        ? { title: `Расходится по звуку на ${formatSigned(au.correction)}`, sub: 'Тайм-код точный, раскладка не менялась. Возможно, камеры стояли далеко друг от друга.', tone: 'warn' }
        : { title: 'Звук совпал с тайм-кодом', tone: 'ok' };
    case 'confirmed':
      return { title: 'Звук подтвердил раскладку', sub: `Точек сверки: ${clips}${acc || ', расхождение меньше кадра'}`, tone: 'ok' };
    case 'applied': {
      const wide = au.wideShift != null ? `Найдена по звуку: часы сбиты на ${formatDurationHuman(Math.abs(au.wideShift))}. ` : '';
      if (au.model === 'per-clip' && cam.clips.length > 0 && cam.clips.every((c) => !c.hasVideo)) {
        return { title: `Поправлена по звуку на ${formatSigned(au.correction ?? 0)}`, sub: `${wide}Точек сверки: ${clips}${acc}. Ход часов рекордера измерен по звуку`, tone: 'ok' };
      }
      if (au.model === 'per-clip') return { title: 'Поправлена по звуку', sub: `${wide}Своя поправка у клипов с общим звуком (${clips}), остальным — по ближайшей точке${acc}`, tone: 'ok' };
      if (au.model === 'per-anchor') return { title: `Поправка менялась по ходу съёмки: ${au.steps.length} шага`, sub: `${wide}В начале ${formatSigned(au.steps[0].correction)}, в конце ${formatSigned(au.steps[au.steps.length - 1].correction)}${acc}`, tone: 'ok' };
      return { title: `Поправлена по звуку на ${formatSigned(au.correction ?? 0)}`, sub: `${wide}Точек сверки: ${clips}${acc}`, tone: 'ok' };
    }
    case 'no-overlap':
      return { title: 'Не с чем сверить', sub: 'Нет общего звука с другими камерами' };
    case 'no-match':
      return { title: 'Совпадения по звуку нет', sub: 'Проверьте стыковку по хлопку', tone: 'warn' };
    case 'silent':
      return { title: 'В звуке тишина', sub: 'Микрофон камеры был выключен или уровень стоял на нуле', tone: 'warn' };
    case 'no-audio':
      return { title: 'Без звука' };
    case 'disabled':
      return cam.audioAssist ? null : { title: 'Поправка по звуку выключена' };
  }
}

function CameraCard({ cam, index }: { cam: Camera; index: number }) {
  const { state, dispatch, synced, issues, fps, addFolders } = useApp();
  const [editing, setEditing] = useState(false);
  const [drop, setDrop] = useState(false);
  // Карточка коротко: имя, что за запись и как она встала. Подробности и ручные настройки — по «Подробнее».
  const [open, setOpen] = useState(false);
  const cs = state.sync?.cameras.find((c) => c.cameraId === cam.id);
  const tz = state.sync?.displayTzOffsetMin ?? -new Date().getTimezoneOffset();

  const info = useMemo(() => {
    const clips = cam.clips;
    const video = clips.filter((c) => c.hasVideo);
    return {
      model: mostCommon(clips.map((c) => c.camera.model)),
      count: clips.length,
      audioOnly: clips.length > 0 && video.length === 0,
      duration: clips.reduce((s, c) => s + c.durationSec, 0),
      size: clips.reduce((s, c) => s + c.sizeBytes, 0),
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
  const au = synced ? state.audio?.cameras.find((c) => c.cameraId === cam.id) : undefined;
  const at = synced ? audioText(au, cam, !!state.audioRun) : null;
  const qt = controlText(state, cam, synced);
  const isActive = state.activeCameraId === cam.id;
  // Одна строка итога: экран синхронизации, иначе звук (с точностью), иначе откуда время. На сколько поправлена
  // камера — в «Подробнее»: для монтажа важно, что она встала и насколько точно.
  const accText = au?.accuracySec != null ? accuracyText(au.accuracySec) : undefined;
  const placedBySound = au && (au.status === 'applied' || au.status === 'confirmed');
  const brief = qt ?? (at ? { title: placedBySound && at.tone !== 'warn' ? 'Встала по звуку' : at.title, sub: accText, tone: at.tone } : synced ? { title: ts.title, sub: undefined, tone: undefined } : null);
  const toneColor = (tone?: 'warn' | 'ok') => (tone === 'warn' ? 'var(--warning)' : tone === 'ok' ? 'var(--success)' : undefined);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDrop(false);
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length) void addFolders(cam.id, paths);
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
          <IconCamera className="icon cam-kind" style={{ color: cameraColor(index) }} />
          <span style={{ fontWeight: 600 }}>{cam.name}</span>
          {state.cameras.length > 1 && (
            <button className="btn small ghost" aria-label="Убрать камеру" onClick={() => dispatch({ type: 'remove-camera', cameraId: cam.id })}><IconX /></button>
          )}
        </div>
        <p style={{ margin: '4px 0 10px' }}>Перетащите сюда папку или файлы этой камеры или рекордера</p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn small" onClick={async () => { const f = await api.pickFolders(); if (f) void addFolders(cam.id, f); }}>
            <IconFolder /> Выбрать папку
          </button>
          <button className="btn small" onClick={async () => { const f = await api.pickFiles(); if (f) void addFolders(cam.id, f); }}>
            Выбрать файлы
          </button>
        </div>
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
        {/* Значок вида записи в цвете дорожки — и вид, и цвет в одном знаке, как на таймлинии. */}
        {info.audioOnly ? <IconHeadphones className="icon cam-kind" style={{ color: cameraColor(index) }} /> : <IconCamera className="icon cam-kind" style={{ color: cameraColor(index) }} />}
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
          <div className="card-summary">
            <span className="what">{[info.model, pluralRu(info.count, 'клип', 'клипа', 'клипов'), formatDurationHuman(info.duration)].filter(Boolean).join(' · ')}</span>
          </div>
          {brief && (
            <div className="card-line" style={{ color: toneColor(brief.tone) }}>
              {brief.title}{brief.sub && <span className="muted"> · {brief.sub}</span>}
            </div>
          )}
          {info.speedActive > 0 && <div className="card-line" style={{ color: 'var(--danger)' }}>S&Q: {pluralRu(info.speedActive, 'клип', 'клипа', 'клипов')} — помечены красным</div>}
          {cam.follower && (
            <div className="card-line">
              Ведомая — встаёт по звуку других и их не сдвигает{' '}
              <button className="btn small ghost inline" onClick={(e) => { e.stopPropagation(); dispatch({ type: 'set-follower', cameraId: cam.id, on: false }); }}>Сделать ведущей</button>
            </div>
          )}
          {info.excluded > 0 && (
            <div className="card-line">
              Убрано с таймлинии: {pluralRu(info.excluded, 'клип', 'клипа', 'клипов')}{' '}
              <button className="btn small ghost inline" onClick={(e) => { e.stopPropagation(); dispatch({ type: 'restore-clips', cameraId: cam.id }); }}>Вернуть</button>
            </div>
          )}
          {cam.manualShiftSec !== 0 && (
            <div className="card-line">
              Сдвинута вручную: {formatShift(cam.manualShiftSec, fps)}{' '}
              <button className="btn small ghost inline" onClick={(e) => { e.stopPropagation(); dispatch({ type: 'shift-camera', cameraId: cam.id, absoluteSec: 0 }); }}>Сбросить</button>
            </div>
          )}
          <button className="card-more" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
            {open ? 'Свернуть' : 'Подробнее'}
          </button>
          {open && (
          <>
          <dl className="facts">
            {/* Объектив, частота и разрешение меняются по ходу съёмки — свойством камеры они не служат, их здесь нет. */}
            <dt>Материал</dt>
            <dd className="num">{pluralRu(info.count, 'клип', 'клипа', 'клипов')} · {formatDurationHuman(info.duration)} · {formatSize(info.size)}</dd>
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
            {qt && (
              <>
                <dt>Экран</dt>
                <dd style={{ color: qt.tone === 'warn' ? 'var(--warning)' : qt.tone === 'ok' ? 'var(--success)' : undefined }}>
                  {qt.title}
                  {qt.sub && <span className="sub">{qt.sub}</span>}
                </dd>
              </>
            )}
            {at && (
              <>
                <dt>Звук</dt>
                <dd style={{ color: at.tone === 'warn' ? 'var(--warning)' : at.tone === 'ok' ? 'var(--success)' : undefined }}>
                  {at.title}
                  {at.sub && <span className="sub">{at.sub}</span>}
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
          {info.channels > 0 && (
            <label className="check" onClick={(e) => e.stopPropagation()} title="Используется в режиме «Тайм-код + звук»">
              <input type="checkbox" checked={cam.audioAssist} onChange={(e) => dispatch({ type: 'set-audio-assist', cameraId: cam.id, on: e.target.checked })} />
              Поправлять по звуку
            </label>
          )}

          </>
          )}
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
