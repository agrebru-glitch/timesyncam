// Новая версия: при запуске программа спрашивает у GitHub последний опубликованный релиз.
// Без сети или при любой ошибке молчит — пользователю это не мешает.
import { net } from 'electron';
import { isNewer } from '../core/version.ts';

const LATEST = 'https://api.github.com/repos/agrebru-glitch/timesyncam/releases/latest';

export async function checkForUpdate(current: string): Promise<{ version: string } | null> {
  try {
    // net.fetch, а не fetch из Node: так учитываются настройки прокси системы.
    const r = await net.fetch(LATEST, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `TimesynCam/${current}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const tag = ((await r.json()) as { tag_name?: unknown }).tag_name;
    if (typeof tag !== 'string' || !isNewer(tag, current)) return null;
    return { version: tag.replace(/^v/, '') };
  } catch {
    return null;
  }
}
