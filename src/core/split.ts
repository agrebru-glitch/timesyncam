// Клипы разных камер на одной дорожке: какие камеры там есть и как разложить их по своим дорожкам.
// Камера клипа — модель и серийный номер из файла. Клип без серийного номера, но той же модели, что единственная
// камера дорожки с номером, — её же (номер теряется вместе с XML). Клипы без модели (звук без метаданных, телефоны
// без сведений) остаются там, где лежали.
import type { Camera, ClipMeta } from './types.ts';

export interface CameraGroup {
  key: string; // модель и серийный номер; '' — камера не известна
  label: string; // как назвать дорожку: модель
  clipIds: string[];
}

const modelOf = (c: ClipMeta) => [c.camera.make && !c.camera.model?.startsWith(c.camera.make) ? c.camera.make : null, c.camera.model].filter(Boolean).join(' ');
const keyOf = (c: ClipMeta) => (c.camera.model ? [c.camera.model, c.camera.serial].filter(Boolean).join(' · ') : '');

// Камеры дорожки по числу клипов, сначала самая большая. Клипы без известной камеры — у самой большой.
export function cameraGroups(cam: Camera): CameraGroup[] {
  const groups = new Map<string, CameraGroup>();
  for (const c of cam.clips) {
    const key = keyOf(c);
    const g = groups.get(key) ?? { key, label: key ? modelOf(c) || c.camera.model! : '', clipIds: [] };
    g.clipIds.push(c.id);
    groups.set(key, g);
  }
  // Модель без серийного номера — к той же модели с номером, если такая камера одна.
  for (const g of [...groups.values()]) {
    const clip = cam.clips.find((c) => c.id === g.clipIds[0])!;
    if (!g.key || clip.camera.serial) continue;
    const withSerial = [...groups.values()].filter((x) => x !== g && x.key.startsWith(`${clip.camera.model} · `));
    if (withSerial.length !== 1) continue;
    withSerial[0].clipIds.push(...g.clipIds);
    groups.delete(g.key);
  }
  const unknown = groups.get('');
  groups.delete('');
  const list = [...groups.values()].sort((a, b) => b.clipIds.length - a.clipIds.length);
  if (unknown && list.length) list[0].clipIds.push(...unknown.clipIds);
  else if (unknown) list.push(unknown);
  // Две камеры одной модели — подпись с серийным номером, иначе их не различить.
  const labels = list.map((g) => g.label);
  list.forEach((g, i) => {
    if (labels.filter((l) => l === labels[i]).length > 1 && g.key.includes(' · ')) g.label = `${g.label} · ${g.key.split(' · ')[1]}`;
  });
  return list;
}

// Подпись набора камер дорожки: по ней программа помнит, что пользователь отказался раскладывать именно эти камеры.
export function groupsSignature(groups: CameraGroup[]): string {
  return groups.map((g) => g.key).sort().join('|');
}

export interface SplitResult {
  cameras: Camera[];
  moved: Map<string, string>; // клип → дорожка, куда он переехал
}

// Разложить дорожку по камерам: самая большая камера остаётся на ней, остальные — на дорожку своей камеры, если такая
// уже есть (на ней больше всего клипов этой камеры), иначе на новую дорожку сразу после этой, с именем модели.
// Файлы на диске не трогаются; убранные с таймлинии клипы остаются убранными на новой дорожке.
export function splitByCamera(cameras: Camera[], cameraId: string, make: (name: string) => Camera): SplitResult {
  const src = cameras.find((c) => c.id === cameraId);
  const moved = new Map<string, string>();
  if (!src) return { cameras, moved };
  const groups = cameraGroups(src);
  if (groups.length < 2) return { cameras, moved };
  const ownerOf = (key: string) => cameras.find((c) => c.id !== cameraId && c.clips.length && cameraGroups(c)[0]?.key === key);
  const taken = new Set(cameras.map((c) => c.name));
  const uniqueName = (base: string) => {
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} (${n})`;
    taken.add(name);
    return name;
  };
  const created: Camera[] = [];
  const additions = new Map<string, ClipMeta[]>();
  for (const g of groups.slice(1)) {
    const owner = ownerOf(g.key);
    const target = owner ?? (() => {
      const cam = make(uniqueName(g.label || 'Камера'));
      created.push(cam);
      return cam;
    })();
    const clips = src.clips.filter((c) => g.clipIds.includes(c.id));
    additions.set(target.id, [...(additions.get(target.id) ?? []), ...clips]);
    for (const c of clips) moved.set(c.id, target.id);
  }
  const folderOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
  const fill = (cam: Camera): Camera => {
    const add = additions.get(cam.id);
    if (!add) return cam;
    const known = new Set(cam.clips.map((c) => c.path));
    const fresh = add.filter((c) => !known.has(c.path));
    const excluded = src.excludedClipIds.filter((id) => fresh.some((c) => c.id === id));
    return {
      ...cam,
      clips: [...cam.clips, ...fresh],
      folders: [...new Set([...cam.folders, ...fresh.map((c) => folderOf(c.path))])],
      excludedClipIds: [...cam.excludedClipIds, ...excluded],
    };
  };
  const rest = { ...src, clips: src.clips.filter((c) => !moved.has(c.id)), excludedClipIds: src.excludedClipIds.filter((id) => !moved.has(id)) };
  const out: Camera[] = [];
  for (const cam of cameras) {
    if (cam.id === cameraId) {
      out.push(rest, ...created.map(fill));
    } else {
      out.push(fill(cam));
    }
  }
  return { cameras: out, moved };
}
