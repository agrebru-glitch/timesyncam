import type { IssueAction } from '../../core/types.ts';
import { formatShift } from '../../core/format.ts';
import { useApp } from '../App.tsx';
import { api } from '../api.ts';
import { buildReport } from '../report.ts';
import { IconAlert, IconError, IconInfo } from '../icons.tsx';
import { useState } from 'react';

export function ErrorsPage() {
  const { state, dispatch, issues, synced, placements, fps } = useApp();

  const run = (a: IssueAction) => {
    if (a.kind === 'open-faq') dispatch({ type: 'tab', tab: 'faq', faqAnchor: a.anchor });
    if (a.kind === 'shift-camera') {
      dispatch({ type: 'shift-camera', cameraId: a.cameraId, deltaSec: a.seconds });
      dispatch({ type: 'toast', text: `Камера сдвинута на ${formatShift(a.seconds, fps)}` });
    }
    if (a.kind === 'exclude-clips') {
      dispatch({ type: 'exclude-clips', cameraId: a.cameraId, clipIds: a.clipIds });
      dispatch({ type: 'toast', text: `Убрано с таймлинии: ${a.clipIds.length}. Файлы на диске не тронуты — вернуть можно в карточке камеры.` });
    }
    if (a.kind === 'make-follower') {
      dispatch({ type: 'set-follower', cameraId: a.cameraId, on: true });
      dispatch({ type: 'toast', text: `«${camName(a.cameraId)}» теперь ведомая: сверяется по другим камерам с допуском и их не сдвигает. Нажмите «Синхронизировать».` });
    }
    if (a.kind === 'show-clip') {
      const p = placements.find((x) => x.clipId === a.clipId);
      dispatch({ type: 'tab', tab: 'sync' });
      dispatch({ type: 'select-clip', clipId: a.clipId });
      if (p) {
        dispatch({ type: 'playhead', at: p.start });
        if (state.viewport) {
          const span = Math.max(60, (p.end - p.start) * 6);
          dispatch({ type: 'viewport', viewport: { start: p.start - span / 3, secPerPx: span / 1100 } });
        }
      }
    }
  };

  const label = (a: IssueAction) => {
    if (a.kind === 'open-faq') return 'Как исправить';
    if (a.kind === 'show-clip') return 'Показать на таймлинии';
    if (a.kind === 'exclude-clips') return 'Убрать с таймлинии';
    if (a.kind === 'make-follower') return `Сделать «${camName(a.cameraId)}» ведомой`;
    return `Сдвинуть на ${formatShift(a.seconds, fps).replace(/:00$/, '')}`;
  };

  const camName = (id: string | null) => state.cameras.find((c) => c.id === id)?.name ?? 'Общее';
  const hasClips = state.cameras.some((c) => c.clips.length > 0);

  // Имя с датой и временем, чтобы несколько отчётов не путались.
  const stamp = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  };
  // Расширенный отчёт: один архив со всем, что нужно разобрать съёмку, — звук без видео, сведения, решения.
  const [collecting, setCollecting] = useState<{ done: number; total: number } | null>(null);
  const saveReport = async () => {
    const clips = state.cameras.flatMap((c) => c.clips.map((k) => ({ camera: c.name, path: k.path, audioChannels: k.audioChannels })));
    setCollecting({ done: 0, total: clips.length + 1 });
    const off = api.onReportProgress((p) => setCollecting(p));
    try {
      const path = await api.saveExtendedReport(`TimesynCam-расширенный-отчёт-${stamp()}.zip`, clips, buildReport(state, issues));
      if (path) dispatch({ type: 'toast', text: 'Расширенный отчёт сохранён — отправьте этот архив разработчику', revealPath: path });
    } catch {
      dispatch({ type: 'toast', text: 'Не получилось собрать отчёт — проверьте, что на диске хватает места' });
    } finally {
      off();
      setCollecting(null);
    }
  };

  return (
    <div className="page">
      <div className="report-box">
        <div>
          <b>Синхронизация ошиблась?</b>
          <span>Сохраните расширенный отчёт и отправьте разработчику. В архиве — звук клипов без видео (около 20 МБ на час записи), сведения о файлах и решения программы. Видео и полных путей на диске в нём нет. Займёт несколько минут.</span>
        </div>
        <button className="btn" onClick={() => void saveReport()} disabled={!hasClips || !!collecting}>
          {collecting ? `Собираю отчёт ${collecting.done} из ${collecting.total}…` : 'Сохранить расширенный отчёт'}
        </button>
      </div>
      <h1>Ошибки и предупреждения</h1>
      <p className="lead">
        {!hasClips
          ? 'Добавьте папки камер на вкладке «Синхронизация» — здесь появится всё, что мешает точной стыковке.'
          : !synced
            ? 'Часть проверок появится после синхронизации.'
            : 'Красное мешает экспорту без потерь, жёлтое стоит проверить, серое — для сведения.'}
      </p>
      {issues.length === 0 ? (
        <div className="empty-state">{hasClips && synced ? 'Всё в порядке: камеры синхронизированы без замечаний.' : 'Пока замечаний нет.'}</div>
      ) : (
        <div className="issue-list">
          {issues.map((i) => (
            <div className="issue" key={i.id}>
              {i.severity === 'error' ? <IconError className="sev error" /> : i.severity === 'warning' ? <IconAlert className="sev warning" /> : <IconInfo className="sev info" />}
              <span className="cam">{camName(i.cameraId)}</span>
              <div>
                <div className="title">{i.title}</div>
                {i.details && <div className="details">{i.details}</div>}
              </div>
              <div className="acts">
                {i.actions.map((a, k) => (
                  <button key={k} className="btn small" onClick={() => run(a)}>{label(a)}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
