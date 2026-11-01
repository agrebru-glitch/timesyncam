import { useMemo, useState } from 'react';
import { buildFcp7Xml, defaultResolution, defaultTimelineRate, TIMELINE_PRESETS } from '../../core/fcp7.ts';
import { buildFcpxml } from '../../core/fcpxml.ts';
import { rateValue } from '../../core/timecode.ts';
import { formatClockTime, formatDate, formatDurationHuman, formatSize } from '../../core/format.ts';
import { driftJobs, withDriftCopies } from '../../core/driftExport.ts';
import { useApp } from '../App.tsx';
import { api } from '../api.ts';

const RESOLUTIONS = [
  { w: 1920, h: 1080, label: 'Full HD 1920×1080' },
  { w: 3840, h: 2160, label: '4K UHD 3840×2160' },
  { w: 4096, h: 2160, label: 'DCI 4K 4096×2160' },
  { w: 1080, h: 1920, label: 'Вертикаль 1080×1920' },
];

type Format = 'fcp7' | 'fcpxml';
const FORMAT_KEY = 'timesyncam.exportFormat';
const DRIFT_KEY = 'timesyncam.driftCorrection';
// Выравнивание хода часов включено по умолчанию; какие записи выравнивать, решает программа.
function savedDrift(): boolean {
  try {
    return localStorage.getItem(DRIFT_KEY) !== '0';
  } catch {
    return true;
  }
}
// По умолчанию — FCPXML для DaVinci: в нём стерео одной дорожкой. Выбор запоминается.
function savedFormat(): Format {
  try {
    return localStorage.getItem(FORMAT_KEY) === 'fcp7' ? 'fcp7' : 'fcpxml';
  } catch {
    return 'fcpxml';
  }
}

export function ExportDialog() {
  const { state, dispatch } = useApp();
  const sync = state.sync!;
  const tz = sync.displayTzOffsetMin;

  const defaults = useMemo(() => {
    const folder = state.cameras.flatMap((c) => c.folders)[0] ?? '';
    const folderName = folder.split(/[\\/]/).filter(Boolean).pop() ?? 'Съёмка';
    const rate = defaultTimelineRate(state.cameras);
    const res = defaultResolution(state.cameras);
    return { name: folderName, rate, res };
  }, [state.cameras]);

  const [name, setName] = useState(defaults.name);
  const [rateKey, setRateKey] = useState(`${defaults.rate.num}/${defaults.rate.den}`);
  const resOptions = RESOLUTIONS.some((r) => r.w === defaults.res.width && r.h === defaults.res.height)
    ? RESOLUTIONS
    : [{ w: defaults.res.width, h: defaults.res.height, label: `${defaults.res.width}×${defaults.res.height}` }, ...RESOLUTIONS];
  const [resKey, setResKey] = useState(`${defaults.res.width}x${defaults.res.height}`);
  const [busy, setBusy] = useState(false);
  const [format, setFormat] = useState<Format>(savedFormat);
  const hasRecorder = state.cameras.some((c) => c.clips.some((x) => !x.hasVideo && x.audioChannels > 0 && sync.placements.some((p) => p.clipId === x.id)));

  const [driftOn, setDriftOn] = useState(savedDrift);
  const [progress, setProgress] = useState<string | null>(null);
  const jobs = useMemo(() => driftJobs(state.cameras, sync, state.audio), [state.cameras, sync, state.audio]);
  const drifting = (state.audio?.drift ?? []).filter((d) => d.apply && jobs.some((j) => state.cameras.find((c) => c.id === d.cameraId)?.clips.some((k) => k.id === j.clipId)));
  const copiesSize = jobs.reduce((s, j) => s + (state.cameras.flatMap((c) => c.clips).find((k) => k.id === j.clipId)?.sizeBytes ?? 0), 0);

  const cams = state.cameras.filter((c) => sync.placements.some((p) => p.cameraId === c.id));
  const clipsCount = sync.placements.length;
  const errors = sync.issues.filter((i) => i.severity === 'error').length;

  const save = async () => {
    setBusy(true);
    const [num, den] = rateKey.split('/').map(Number);
    const [w, h] = resKey.split('x').map(Number);
    const opts = { name: name.trim() || 'TimesynCam', rate: { num, den }, width: w, height: h };
    const build = (c: typeof state.cameras, s: typeof sync) => (format === 'fcpxml' ? buildFcpxml(c, s, opts) : buildFcp7Xml(c, s, opts));
    try {
      localStorage.setItem(FORMAT_KEY, format);
      localStorage.setItem(DRIFT_KEY, driftOn ? '1' : '0');
    } catch {
      // запоминать выбор необязательно
    }
    const safe = (name.trim() || 'TimesynCam').replace(/[\\/:*?"<>|]/g, '_');
    const fileName = `${safe}.${format === 'fcpxml' ? 'fcpxml' : 'xml'}`;
    if (!driftOn || !jobs.length) {
      const path = await api.saveExport(fileName, build(state.cameras, sync));
      setBusy(false);
      if (path) {
        dispatch({ type: 'export-open', open: false });
        dispatch({ type: 'toast', text: 'Таймлиния сохранена', revealPath: path });
      }
      return;
    }
    // С выравниванием: место для XML, копии звука рядом с ним, проверка каждой копии по звуку, потом XML.
    const path = await api.chooseExport(fileName);
    if (!path) {
      setBusy(false);
      return;
    }
    setProgress('Выравниваю звук…');
    const off = api.onDriftProgress(({ done, total }) => setProgress(`Выравниваю звук: запись ${Math.min(total, Math.floor(done) + 1)} из ${total}, ${Math.round((done / total) * 100)}%`));
    const done = await api.renderDrift(path, jobs).finally(off);
    setProgress(null);
    const mod = withDriftCopies(state.cameras, sync, jobs, done ?? []);
    const saved = await api.writeExport(path, build(mod.cameras, mod.sync));
    setBusy(false);
    if (!saved) return;
    const ok = (done ?? []).filter((r) => r.ok).length;
    dispatch({ type: 'export-open', open: false });
    dispatch({
      type: 'toast',
      text: ok < jobs.length
        ? `Таймлиния сохранена. Выровнено записей: ${ok} из ${jobs.length} — остальные не прошли проверку по звуку, в XML их оригиналы`
        : `Таймлиния сохранена, звук выровнен: ${ok} ${ok === 1 ? 'запись' : ok < 5 ? 'записи' : 'записей'}`,
      revealPath: path,
    });
  };

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) dispatch({ type: 'export-open', open: false }); }}>
      <div className="dialog" role="dialog" aria-label="Экспорт таймлинии">
        <h2>Экспорт таймлинии</h2>
        <p className="lead">
          {cams.length} {cams.length === 1 ? 'камера' : cams.length < 5 ? 'камеры' : 'камер'}, {clipsCount} клипов ·{' '}
          {formatDate(sync.start, tz)}, {formatClockTime(sync.start, tz, false)}–{formatClockTime(sync.end, tz, false)}
        </p>
        <div className="field">
          <label htmlFor="ex-name">Название</label>
          <input id="ex-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ex-rate">Частота таймлинии</label>
          <select id="ex-rate" value={rateKey} onChange={(e) => setRateKey(e.target.value)}>
            {TIMELINE_PRESETS.map((p) => (
              <option key={p.label} value={`${p.rate.num}/${p.rate.den}`}>
                {p.label} кадров/с{p.rate.num === defaults.rate.num && p.rate.den === defaults.rate.den ? ' — как у камер' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ex-res">Разрешение</label>
          <select id="ex-res" value={resKey} onChange={(e) => setResKey(e.target.value)}>
            {resOptions.map((r) => <option key={`${r.w}x${r.h}`} value={`${r.w}x${r.h}`}>{r.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ex-format">Для какой монтажки</label>
          <select id="ex-format" value={format} onChange={(e) => setFormat(e.target.value as Format)}>
            <option value="fcpxml">DaVinci Resolve — FCPXML: стерео одной дорожкой, звук рекордера до сэмпла</option>
            <option value="fcp7">Premiere Pro — XML (Final Cut Pro 7)</option>
          </select>
        </div>
        {drifting.length > 0 && (
          <div className="drift-option">
            <label className="check">
              <input type="checkbox" checked={driftOn} onChange={(e) => setDriftOn(e.target.checked)} />
              Выровнять ход часов звука
            </label>
            <div className="hint">
              {drifting.map((d) => `«${state.cameras.find((c) => c.id === d.cameraId)?.name}»: часы ${d.ppm > 0 ? 'отстают' : 'спешат'} на ${Math.abs(d.ppm).toFixed(0)} ppm — за ${formatDurationHuman(d.longestSec)} это ${formatDurationHuman(2 * d.edgeErrorSec)}`).join('; ')}.
              {driftOn
                ? ` Программа сделает выровненные копии (${jobs.length} ${jobs.length === 1 ? 'файл' : jobs.length < 5 ? 'файла' : 'файлов'}, около ${formatSize(copiesSize)}) в папке «${name.trim() || 'TimesynCam'} — выровненный звук» рядом с XML, проверит каждую по звуку и поставит в таймлинию их. Оригиналы не меняются.`
                : ' Без выравнивания записи стоят по середине: к краям звук расходится с видео на половину этого.'}
            </div>
          </div>
        )}
        <div className="note">
          Оригинальные файлы не меняются — в XML только ссылки на них и их места на таймлинии. Каждая камера — на своей дорожке,
          таймлиния начинается с 00:00:00:00 — с первого клипа съёмки ({rateValue({ num: Number(rateKey.split('/')[0]), den: Number(rateKey.split('/')[1]) }).toFixed(3).replace(/\.?0+$/, '')} к/с).
          {errors > 0 && <><br /><b style={{ color: 'var(--danger)' }}>Есть ошибки ({errors}):</b> накладывающиеся клипы уйдут на дополнительную дорожку камеры.</>}
          {format === 'fcpxml'
            ? <><br />Видео встаёт на кадр, звук без видео — точно до сэмпла, как его нашла синхронизация.<br />Resolve: File → Import → Timeline.</>
            : <><br />В XML каждый канал звука — на своей дорожке: так устроен формат. Для DaVinci выбирайте FCPXML — там стерео одной дорожкой.{hasRecorder && <> Звук рекордера в XML встаёт с точностью до кадра.</>}<br />Premiere Pro: File → Import. Resolve: File → Import → Timeline.</>}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={() => dispatch({ type: 'export-open', open: false })}>Отмена</button>
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? progress ?? 'Сохраняю…' : format === 'fcpxml' ? 'Сохранить FCPXML' : 'Сохранить XML'}</button>
        </div>
      </div>
    </div>
  );
}
