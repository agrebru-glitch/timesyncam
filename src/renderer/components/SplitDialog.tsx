import { useMemo } from 'react';
import { pluralRu } from '../../core/format.ts';
import { cameraGroups, splitByCamera } from '../../core/split.ts';
import { useApp } from '../App.tsx';
import { newCamera } from '../state.ts';

// На дорожку попали клипы разных камер — предложение разложить их по своим дорожкам. Решает пользователь:
// можно оставить как есть, тогда программа не спрашивает снова, пока на дорожке не появится ещё одна камера.
export function SplitDialog({ cameraId }: { cameraId: string }) {
  const { state, dispatch } = useApp();
  const cam = state.cameras.find((c) => c.id === cameraId);
  const plan = useMemo(() => {
    if (!cam) return null;
    const groups = cameraGroups(cam);
    if (groups.length < 2) return null;
    // Куда уйдёт каждая камера — тем же расчётом, что и само разложение.
    const { cameras, moved } = splitByCamera(state.cameras, cameraId, (name) => ({ ...newCamera(state.cameras.length + 1), name }));
    const target = (g: (typeof groups)[number]) => {
      const to = moved.get(g.clipIds[0]);
      const dest = cameras.find((c) => c.id === to);
      if (!dest) return null;
      return { name: dest.name, existing: state.cameras.some((c) => c.id === dest.id) };
    };
    return groups.map((g, i) => ({ g, stay: i === 0, to: i === 0 ? null : target(g) }));
  }, [cam, cameraId, state.cameras]);
  if (!cam || !plan) return null;

  return (
    <div className="scrim">
      <div className="dialog split-dialog" role="dialog" aria-label="Клипы разных камер на одной дорожке">
        <h2>На дорожке «{cam.name}» клипы разных камер</h2>
        <p className="lead">У камер разные часы: на своих дорожках каждую программа выставит по её часам и звуку, а в монтажке каждая камера окажется на своей дорожке.</p>
        <ul className="split-list">
          {plan.map(({ g, stay, to }) => (
            <li key={g.key || 'unknown'}>
              <span className="split-cam">{g.label || 'Без сведений о камере'}</span>
              <span className="split-count">{pluralRu(g.clipIds.length, 'клип', 'клипа', 'клипов')}</span>
              <span className="split-to">
                {stay ? 'остаётся на этой дорожке' : to ? (to.existing ? `→ на дорожку «${to.name}»` : `→ новая дорожка «${to.name}»`) : ''}
              </span>
            </li>
          ))}
        </ul>
        <div className="note">Файлы на диске не меняются — программа только раскладывает клипы по дорожкам. Перетащить файлы на нужную дорожку можно и вручную.</div>
        <div className="dialog-actions">
          <button className="btn" onClick={() => dispatch({ type: 'split-decline', cameraId })}>Оставить на одной дорожке</button>
          <button className="btn primary" autoFocus onClick={() => dispatch({ type: 'split-camera', cameraId })}>Разложить по дорожкам</button>
        </div>
      </div>
    </div>
  );
}
