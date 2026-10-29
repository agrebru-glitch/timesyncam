import { useMemo, useState } from 'react';
import { buildFcp7Xml, defaultResolution, defaultTimelineRate, TIMELINE_PRESETS } from '../../core/fcp7.ts';
import { rateValue } from '../../core/timecode.ts';
import { formatClockTime, formatDate } from '../../core/format.ts';
import { useApp } from '../App.tsx';
import { api } from '../api.ts';

const RESOLUTIONS = [
  { w: 1920, h: 1080, label: 'Full HD 1920×1080' },
  { w: 3840, h: 2160, label: '4K UHD 3840×2160' },
  { w: 4096, h: 2160, label: 'DCI 4K 4096×2160' },
  { w: 1080, h: 1920, label: 'Вертикаль 1080×1920' },
];

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

  const cams = state.cameras.filter((c) => sync.placements.some((p) => p.cameraId === c.id));
  const clipsCount = sync.placements.length;
  const errors = sync.issues.filter((i) => i.severity === 'error').length;

  const save = async () => {
    setBusy(true);
    const [num, den] = rateKey.split('/').map(Number);
    const [w, h] = resKey.split('x').map(Number);
    const xml = buildFcp7Xml(state.cameras, sync, { name: name.trim() || 'TimesynCam', rate: { num, den }, width: w, height: h });
    const safe = (name.trim() || 'TimesynCam').replace(/[\\/:*?"<>|]/g, '_');
    const path = await api.saveExport(`${safe}.xml`, xml);
    setBusy(false);
    if (path) {
      dispatch({ type: 'export-open', open: false });
      dispatch({ type: 'toast', text: 'Таймлиния сохранена', revealPath: path });
    }
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
          <label>Формат</label>
          <span>XML для Premiere Pro и DaVinci Resolve</span>
        </div>
        <div className="note">
          Оригинальные файлы не меняются — в XML только ссылки на них и их места на таймлинии. Каждая камера — на своей дорожке,
          тайм-код таймлинии показывает время съёмки ({rateValue({ num: Number(rateKey.split('/')[0]), den: Number(rateKey.split('/')[1]) }).toFixed(3).replace(/\.?0+$/, '')} к/с).
          {errors > 0 && <><br /><b style={{ color: 'var(--danger)' }}>Есть ошибки ({errors}):</b> накладывающиеся клипы уйдут на дополнительную дорожку камеры.</>}
          <br />Resolve: File → Import → Timeline. Premiere Pro: File → Import.
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={() => dispatch({ type: 'export-open', open: false })}>Отмена</button>
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Сохраняю…' : 'Сохранить XML'}</button>
        </div>
      </div>
    </div>
  );
}
