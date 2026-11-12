import { useMemo, useState } from 'react';
import { buildFcp7Xml, defaultResolution, defaultTimelineRate, TIMELINE_PRESETS } from '../../core/fcp7.ts';
import { buildFcpxml } from '../../core/fcpxml.ts';
import { rateValue } from '../../core/timecode.ts';
import { formatClockTime, formatDate, formatDurationHuman, formatSize, pluralRu } from '../../core/format.ts';
import { driftJobs, withDriftCopies } from '../../core/driftExport.ts';
import { moveToEnd, problemClips } from '../../core/exportOptions.ts';
import { useApp } from '../App.tsx';
import { api } from '../api.ts';

const RESOLUTIONS = [
  { w: 1920, h: 1080, label: 'Full HD 1920×1080' },
  { w: 3840, h: 2160, label: '4K UHD 3840×2160' },
  { w: 4096, h: 2160, label: 'DCI 4K 4096×2160' },
  { w: 1080, h: 1920, label: 'Вертикаль 1080×1920' },
];

// fcp7 — XML для Premiere; resolve-xml — тот же XML для DaVinci: звук по камерам парами к видео. Корзины в файле те же,
// но DaVinci 21.2 папок из них не создаёт (проверено импортом через меню, и с XML по образцу PluralEyes тоже).
type Format = 'fcp7' | 'fcpxml' | 'resolve-xml';
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
    const v = localStorage.getItem(FORMAT_KEY);
    return v === 'fcp7' || v === 'resolve-xml' ? v : 'fcpxml';
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

  // Опции — выключены при каждом открытии: раскладку программы они не меняют, только то, что уйдёт в монтажку.
  const problems = useMemo(() => problemClips(state.cameras, state.audio), [state.cameras, state.audio]);
  const problemCount = sync.placements.filter((p) => problems.has(p.clipId)).length;
  const cameraHasAudio = state.cameras.some((c) => c.clips.some((x) => x.hasVideo && x.audioChannels > 0 && sync.placements.some((p) => p.clipId === x.id)));
  const [toEnd, setToEnd] = useState(false);
  const [noCamAudio, setNoCamAudio] = useState(false);
  const [multicam, setMulticam] = useState(false);

  const cams = state.cameras.filter((c) => sync.placements.some((p) => p.cameraId === c.id));
  const clipsCount = sync.placements.length;
  const errors = sync.issues.filter((i) => i.severity === 'error').length;

  const save = async () => {
    setBusy(true);
    const [num, den] = rateKey.split('/').map(Number);
    const [w, h] = resKey.split('x').map(Number);
    const opts = {
      name: name.trim() || 'TimesynCam',
      rate: { num, den },
      width: w,
      height: h,
      cameraAudio: !(noCamAudio && hasRecorder && cameraHasAudio),
      multicam: multicam && format === 'fcpxml',
    };
    const build = (c: typeof state.cameras, s0: typeof sync) => {
      const s = toEnd && problemCount ? moveToEnd(s0, problems) : s0;
      return format === 'fcpxml' ? buildFcpxml(c, s, opts) : buildFcp7Xml(c, s, { ...opts, audioOrder: format === 'resolve-xml' ? 'video' : undefined });
    };
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
    // Ход — и в окне, и в строке состояния: окно экспорта могут закрыть, а выравнивание идёт дальше.
    const show = (text: string | null) => {
      setProgress(text);
      dispatch({ type: 'export-run', text });
    };
    show('Выравниваю звук…');
    const off = api.onDriftProgress(({ done, total }) => show(`Выравниваю звук: запись ${Math.min(total, Math.floor(done) + 1)} из ${total}, ${Math.round((done / total) * 100)}%`));
    const done = await api.renderDrift(path, jobs).finally(() => {
      off();
      show(null);
    });
    const mod = withDriftCopies(state.cameras, sync, jobs, done ?? []);
    const saved = await api.writeExport(path, build(mod.cameras, mod.sync));
    setBusy(false);
    if (!saved) return;
    const ok = (done ?? []).filter((r) => r.ok).length;
    // Почему не выровнено — первая причина: не прошла проверку по звуку, не записалась копия или сбой потока.
    const why = done === null ? 'выравнивание прервалось' : done.find((r) => !r.ok)?.reason;
    dispatch({ type: 'export-open', open: false });
    dispatch({
      type: 'toast',
      text: ok < jobs.length
        ? `Таймлиния сохранена. Выровнено записей: ${ok} из ${jobs.length}, у остальных в XML оригиналы${why ? ` (${why})` : ''}`
        : `Таймлиния сохранена, звук выровнен: ${ok} ${ok === 1 ? 'запись' : ok < 5 ? 'записи' : 'записей'}`,
      revealPath: path,
    });
  };

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) dispatch({ type: 'export-open', open: false }); }}>
      <div className="dialog" role="dialog" aria-label="Экспорт таймлинии">
        <h2>Экспорт таймлинии</h2>
        <p className="lead">
          {pluralRu(cams.length, 'камера', 'камеры', 'камер')}, {pluralRu(clipsCount, 'клип', 'клипа', 'клипов')} ·{' '}
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
            <option value="resolve-xml">DaVinci Resolve — XML: звук каждой камеры на своих дорожках, парами к видео</option>
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
                ? ` Программа сделает выровненные копии (${jobs.length} ${jobs.length === 1 ? 'файл' : jobs.length < 5 ? 'файла' : 'файлов'}, около ${formatSize(copiesSize)}) в папке «${name.trim() || 'TimesynCam'} — выровненный звук» рядом с XML, по папкам дорожек, проверит каждую по звуку и поставит в таймлинию их. Оригиналы и их папки не меняются.`
                : ' Без выравнивания записи стоят по середине: к краям звук расходится с видео на половину этого.'}
            </div>
          </div>
        )}
        <div className="export-options">
          <div className="export-options-title">Дополнительно <span className="muted">· по умолчанию выключено</span></div>
          {problemCount > 0 && (
            <label className="check">
              <input type="checkbox" checked={toEnd} onChange={(e) => setToEnd(e.target.checked)} />
              <span>
                Ненайденные клипы — в конец таймлинии
                <span className="hint">
                  {pluralRu(problemCount, 'клип', 'клипа', 'клипов')}, чьё место звук не нашёл, встанут после конца съёмки, каждый на своей дорожке.
                  На таймлинии программы они обведены пунктиром.
                </span>
              </span>
            </label>
          )}
          {hasRecorder && cameraHasAudio && (
            <label className="check">
              <input type="checkbox" checked={noCamAudio} onChange={(e) => setNoCamAudio(e.target.checked)} />
              <span>
                Звук камер заменить звуком рекордеров
                <span className="hint">
                  {format === 'fcpxml'
                    ? 'У видео камер на таймлинии будет только картинка, звук — с дорожек рекордеров. Файлы не меняются, звук камеры можно включить в монтажке.'
                    : 'Дорожек звука камер в XML не будет — только звук рекордеров. Файлы не меняются, звук камеры есть в мастер-клипах корзины.'}
                </span>
              </span>
            </label>
          )}
          <label className={`check ${format === 'fcpxml' ? '' : 'disabled'}`}>
            <input type="checkbox" checked={multicam && format === 'fcpxml'} disabled={format !== 'fcpxml'} onChange={(e) => setMulticam(e.target.checked)} />
            <span>
              Мультикам-клип
              <span className="hint">
                {format === 'fcpxml'
                  ? 'Вместо дорожек — один мультикам-клип: каждая камера и рекордер — ракурсом. Картинка — с первой камеры, звук — с первого рекордера. В Resolve ракурсы переключаются в окне Multicam.'
                  : 'Только для DaVinci Resolve (FCPXML). В Premiere мультикам собирается из дорожек: выделите их и выберите «Create Multi-Camera Source Sequence» по тайм-коду.'}
              </span>
            </span>
          </label>
        </div>
        <div className="note">
          Оригинальные файлы не меняются — в XML только ссылки на них и их места на таймлинии. Каждая камера — на своей дорожке,
          таймлиния начинается с 00:00:00:00 — с первого клипа съёмки ({rateValue({ num: Number(rateKey.split('/')[0]), den: Number(rateKey.split('/')[1]) }).toFixed(3).replace(/\.?0+$/, '')} к/с).
          {errors > 0 && <><br /><b style={{ color: 'var(--danger)' }}>Есть ошибки ({errors}):</b> накладывающиеся клипы уйдут на дополнительную дорожку камеры.</>}
          {format === 'fcpxml'
            ? <><br />Видео встаёт на кадр, звук без видео — точно до сэмпла, как его нашла синхронизация.<br />Resolve: File → Import → Timeline.</>
            : format === 'resolve-xml'
              ? <><br />Звук камер — парами к видео: A1 и A2 — левый и правый канал камеры на V1, дальше вверх по видео; рекордеры — ниже всех. Картинка и звук клипа связаны. В XML каждый канал — на своей дорожке: так устроен формат.{hasRecorder && <> Звук рекордера встаёт с точностью до кадра.</>}<br />Resolve: File → Import → Timeline.</>
              : <><br />В XML каждый канал звука — на своей дорожке: так устроен формат.{hasRecorder && <> Звук рекордера в XML встаёт с точностью до кадра.</>}<br />Premiere Pro: File → Import.</>}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={() => dispatch({ type: 'export-open', open: false })}>Отмена</button>
          <button className="btn primary" disabled={busy || !!state.exportRun} onClick={save}>{busy ? progress ?? 'Сохраняю…' : format === 'fcpxml' ? 'Сохранить FCPXML' : 'Сохранить XML'}</button>
        </div>
      </div>
    </div>
  );
}
