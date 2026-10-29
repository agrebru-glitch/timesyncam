import { useEffect, useRef } from 'react';
import { useApp } from '../App.tsx';
import type { SyncMode } from '../state.ts';

const OPTIONS: { mode: SyncMode; title: string; text: string }[] = [
  {
    mode: 'audio',
    title: 'Тайм-код + звук',
    text: 'Раскладка по тайм-коду и часам, затем сверка по звуку: точки зацепки по ходу съёмки поправляют клипы, камеры со сбитыми часами находятся по звуку.',
  },
  {
    mode: 'control',
    title: 'Контрольный кадр + тайм-код + звук',
    text: 'Самый точный: камеры, снявшие экран синхронизации, встают по нему до четверти кадра — все их клипы следом по тайм-коду. Камеры без экрана подтягиваются по звуку.',
  },
  {
    mode: 'timecode',
    title: 'Только тайм-код',
    text: 'Только тайм-код и часы камер. Быстрее, звук не анализируется.',
  },
];

export function SyncMenu() {
  const { state, dispatch, doSync } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const noFfmpeg = state.tools?.ffmpeg === false;

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const wrap = ref.current?.parentElement;
      if (wrap && !wrap.contains(e.target as Node)) dispatch({ type: 'sync-menu', open: false });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'sync-menu', open: false });
      if (e.key === 'Enter') void doSync(state.syncMode);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [dispatch, doSync, state.syncMode]);

  return (
    <div className="sync-menu" ref={ref} role="menu" aria-label="Как синхронизировать">
      {OPTIONS.map((o) => {
        const noFrames = o.mode === 'control' && Object.keys(state.controlFrames).length === 0;
        const disabled = (o.mode !== 'timecode' && noFfmpeg) || noFrames;
        return (
          <button
            key={o.mode}
            role="menuitemradio"
            aria-checked={state.syncMode === o.mode}
            className={`sync-option ${o.mode === 'control' ? 'precise' : ''} ${state.syncMode === o.mode ? 'on' : ''} ${disabled ? 'locked' : ''}`}
            onClick={() => !disabled && void doSync(o.mode)}
            title={noFrames ? 'Сначала отметьте контрольные кадры: правая кнопка по клипу на таймлинии → «Выбрать контрольным кадром»' : disabled ? 'Для сверки по звуку нужен ffmpeg' : undefined}
          >
            <span className="radio" aria-hidden="true" />
            <span className="sync-option-body">
              <span className="sync-option-title">
                {o.title}
                {o.mode === 'audio' && <span className="sync-default">по умолчанию</span>}
                {o.mode === 'control' && <span className="sync-recommended">(рекомендуется)</span>}
              </span>
              <span className="sync-option-text">{o.text}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
