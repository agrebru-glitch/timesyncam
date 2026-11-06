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

  // Замечания по важности: сначала то, что мешает точной стыковке, потом что стоит проверить, в конце — для
  // сведения (свёрнуто). Внутри группы — по камерам в порядке дорожек.
  const order = new Map(state.cameras.map((c, i) => [c.id, i]));
  const byCamera = (list: typeof issues) => [...list].sort((a, b) => (order.get(a.cameraId ?? '') ?? -1) - (order.get(b.cameraId ?? '') ?? -1));
  const groups = [
    { key: 'error', title: 'Мешает точной стыковке', hint: 'Исправьте до экспорта — иначе часть клипов встанет не на своё место.', list: byCamera(issues.filter((i) => i.severity === 'error')), open: true },
    { key: 'warning', title: 'Стоит проверить', hint: 'Программа решила сама, но здесь лучше взглянуть глазами — обычно хватает минуты.', list: byCamera(issues.filter((i) => i.severity === 'warning')), open: true },
    { key: 'info', title: 'Для сведения', hint: 'Что программа заметила и учла сама. Делать ничего не нужно.', list: byCamera(issues.filter((i) => i.severity === 'info')), open: false },
  ] as const;
  const counts = Object.fromEntries(groups.map((g) => [g.key, g.list.length])) as Record<(typeof groups)[number]['key'], number>;
  const summary = !hasClips
    ? 'Добавьте папки камер на вкладке «Синхронизация» — здесь появится всё, что стоит знать о стыковке.'
    : !synced
      ? 'Часть проверок появится после синхронизации.'
      : counts.error
        ? `Есть что исправить: ${counts.error}. ${counts.warning ? `Ещё стоит проверить: ${counts.warning}.` : ''}`
        : counts.warning
          ? `Синхронизация готова. Стоит проверить: ${counts.warning}${counts.info ? `, для сведения: ${counts.info}` : ''}.`
          : 'Синхронизация готова — проверять ничего не нужно.';

  const issueRow = (i: (typeof issues)[number]) => (
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
  );

  return (
    <div className="page">
      <h1>Замечания</h1>
      <p className="lead">{summary}</p>
      {issues.length === 0 ? (
        <div className="empty-state">{hasClips && synced ? 'Всё в порядке: камеры синхронизированы без замечаний.' : 'Пока замечаний нет.'}</div>
      ) : (
        groups.filter((g) => g.list.length > 0).map((g) => (
          <details className={`issue-group ${g.key}`} key={g.key} open={g.open}>
            <summary>
              <span className="group-title">{g.title}</span>
              <span className="group-count">{g.list.length}</span>
              <span className="group-hint">{g.hint}</span>
            </summary>
            <div className="issue-list">{g.list.map(issueRow)}</div>
          </details>
        ))
      )}
      <div className="report-box">
        <div>
          <b>Синхронизация ошиблась?</b>
          <span>Сохраните расширенный отчёт и отправьте разработчику. В архиве — звук клипов без видео (около 20 МБ на час записи), сведения о файлах и решения программы. Видео, полных путей на диске, координат съёмки и серийных номеров камер в нём нет. Займёт несколько минут.</span>
        </div>
        <button className="btn" onClick={() => void saveReport()} disabled={!hasClips || !!collecting}>
          {collecting ? `Собираю отчёт ${collecting.done} из ${collecting.total}…` : 'Сохранить расширенный отчёт'}
        </button>
      </div>
    </div>
  );
}
