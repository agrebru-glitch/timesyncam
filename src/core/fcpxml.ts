// Экспорт таймлинии в FCPXML 1.10 — для DaVinci Resolve.
// В отличие от FCP7 XML, звук без видео (рекордер) ставится точно до сэмпла: клип встаёт на ближайший кадр,
// а доля кадра срезается с его начала. Оригинальные файлы не меняются.
import type { Camera, ClipMeta, Rate, SyncResult } from './types.ts';
import { nominalRate, parseTc, rateValue, tcToFrameCount } from './timecode.ts';
import type { ExportOptions } from './fcp7.ts';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function fileUrl(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const withRoot = /^[A-Za-z]:\//.test(norm) ? `/${norm}` : norm;
  return `file://${encodeURI(withRoot).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return Math.abs(a);
}

// Время FCPXML — дробь секунд: «1001/30000s», «3/2s», «0s».
function t(num: number, den: number): string {
  if (num === 0) return '0s';
  const g = gcd(num, den);
  const n = num / g;
  const d = den / g;
  return d === 1 ? `${n}s` : `${n}/${d}s`;
}
const frames = (n: number, r: Rate) => t(n * r.den, r.num);
const samples = (n: number, sr: number) => t(n, sr);

// Начало файла по его тайм-коду: в кадрах клипа (видео) или в сэмплах (звук с BWF).
function assetStartFrames(c: ClipMeta, r: Rate): number {
  if (!c.tc || c.tc.source === 'bwf') return 0;
  const parts = parseTc(c.tc.text);
  const nominal = nominalRate(rateValue(r));
  return parts && parts.f < nominal ? tcToFrameCount(parts, nominal) : 0;
}
function assetStartSamples(c: ClipMeta, sr: number): number {
  return c.tc?.source === 'bwf' ? Math.round(c.tc.seconds * sr) : 0;
}

export function buildFcpxml(cameras: Camera[], result: SyncResult, opts: ExportOptions): string {
  const seq = opts.rate;
  const seqFps = rateValue(seq);
  const clipsById = new Map<string, ClipMeta>();
  for (const cam of cameras) for (const c of cam.clips) clipsById.set(c.id, c);

  // Таймлиния начинается с 00:00:00:00 — с первого клипа съёмки, остальные стоят от него на своих местах.
  // С тайм-кодом времени суток клипы оказывались за много часов от начала, и DaVinci зависал на импорте.
  const seqStartEpoch = result.start;

  const formats = new Map<string, string>();
  const formatXml: string[] = [`<format id="r0" frameDuration="${frames(1, seq)}" width="${opts.width}" height="${opts.height}"/>`];
  const formatOf = (c: ClipMeta): string => {
    const r = c.rate ?? seq;
    const key = `${r.num}/${r.den} ${c.width ?? opts.width}x${c.height ?? opts.height}`;
    let id = formats.get(key);
    if (!id) {
      id = `r${formats.size + 1}`;
      formats.set(key, id);
      formatXml.push(`<format id="${id}" frameDuration="${frames(1, r)}" width="${c.width ?? opts.width}" height="${c.height ?? opts.height}"/>`);
    }
    return id;
  };

  const assets = new Map<string, string>();
  const assetXml: string[] = [];
  const assetOf = (c: ClipMeta): string => {
    let id = assets.get(c.id);
    if (id) return id;
    id = `a${assets.size + 1}`;
    assets.set(c.id, id);
    const sr = c.audioSampleRate ?? 48000;
    const audio = c.audioChannels > 0 ? ` hasAudio="1" audioSources="1" audioChannels="${c.audioChannels}" audioRate="${sr}"` : '';
    let timing: string;
    if (c.hasVideo) {
      const r = c.rate ?? seq;
      const dur = c.frames ?? Math.round(c.durationSec * rateValue(r));
      timing = `start="${frames(assetStartFrames(c, r), r)}" duration="${frames(dur, r)}" hasVideo="1" format="${formatOf(c)}"`;
    } else {
      timing = `start="${samples(assetStartSamples(c, sr), sr)}" duration="${samples(Math.round(c.durationSec * sr), sr)}"`;
    }
    assetXml.push(`<asset id="${id}" name="${esc(c.name)}" ${timing}${audio}><media-rep kind="original-media" src="${esc(fileUrl(c.path))}"/></asset>`);
    return id;
  };

  // Дорожки: видео камер — над основной (lane 1, 2, …), звук без видео — под ней (lane −1, −2, …).
  const laneOf = new Map<string, number>();
  let nextUp = 1;
  let nextDown = -1;
  const lane = (camId: string, camLane: number, video: boolean): number => {
    const key = `${camId}|${camLane}|${video}`;
    let l = laneOf.get(key);
    if (l === undefined) {
      l = video ? nextUp++ : nextDown--;
      laneOf.set(key, l);
    }
    return l;
  };

  // Папки — ключевыми словами: DaVinci не переносит из FCPXML корзины, но по ключевым словам сам собирает
  // смарт-корзины (Media Pool → Smart Bins → Keywords). Слово — имя дорожки (её папка), а если клипы дорожки
  // из разных подпапок — ещё и имя подпапки.
  const keywordsOf = new Map<string, string>();
  for (const cam of cameras) {
    const placed = cam.clips.filter((c) => result.placements.some((p) => p.clipId === c.id && p.cameraId === cam.id));
    const folder = (c: ClipMeta) => c.path.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
    const single = placed.every((c) => folder(c) === folder(placed[0]));
    for (const c of placed) keywordsOf.set(c.id, single ? cam.name : `${cam.name}, ${folder(c).split('/').pop()}`);
  }
  const keyword = (c: ClipMeta, start: string, duration: string) => {
    const words = keywordsOf.get(c.id);
    return words ? `<keyword start="${start}" duration="${duration}" value="${esc(words)}"/>` : '';
  };

  const items: { lane: number; offset: number; xml: string }[] = [];
  const entries: { lane: number; offset: number; dur: number; c: ClipMeta; start: string }[] = [];
  const lastOf = new Map<number, (typeof entries)[number]>();
  let endFrame = 0;
  for (const cam of cameras) {
    const list = result.placements.filter((p) => p.cameraId === cam.id).sort((a, b) => a.start - b.start);
    for (const p of list) {
      const c = clipsById.get(p.clipId);
      if (!c) continue;
      const l = lane(cam.id, p.lane, c.hasVideo);
      const exact = (p.start - seqStartEpoch) * seqFps; // позиция в кадрах таймлинии, с долями
      let offset: number;
      let start: string;
      let durFrames: number;
      if (c.hasVideo) {
        // Видео встаёт на ближайший кадр — точнее кадра картинку не поставить.
        offset = Math.round(exact);
        const r = c.rate ?? seq;
        start = frames(assetStartFrames(c, r), r);
        durFrames = Math.max(1, Math.floor(c.durationSec * seqFps + 1e-6));
      } else {
        // Звук: клип встаёт на следующий кадр, а пропущенная доля кадра срезается с начала — сэмпл в сэмпл.
        const sr = c.audioSampleRate ?? 48000;
        offset = Math.ceil(exact - 1e-9);
        const trim = Math.round(((offset - exact) / seqFps) * sr);
        start = samples(assetStartSamples(c, sr) + trim, sr);
        durFrames = Math.max(1, Math.floor((c.durationSec - trim / sr) * seqFps + 1e-6));
      }
      // Клипы одной дорожки не должны накладываться — из-за округления до кадра или хода часов. Укорачивается
      // хвост предыдущего: место следующего найдено по звуку, сдвигать его нельзя.
      const prev = lastOf.get(l);
      if (prev && offset < prev.offset + prev.dur) prev.dur = Math.max(1, offset - prev.offset);
      const entry = { lane: l, offset, dur: durFrames, c, start };
      lastOf.set(l, entry);
      entries.push(entry);
    }
  }
  for (const e of entries) {
    endFrame = Math.max(endFrame, e.offset + e.dur);
    items.push({
      lane: e.lane,
      offset: e.offset,
      xml: `<asset-clip ref="${assetOf(e.c)}" lane="${e.lane}" offset="${frames(e.offset, seq)}" start="${e.start}" duration="${frames(e.dur, seq)}" name="${esc(e.c.name)}"${e.c.hasVideo ? ` format="${formatOf(e.c)}"` : ''} tcFormat="NDF">${keyword(e.c, e.start, frames(e.dur, seq))}</asset-clip>`,
    });
  }
  // Порядок в файле — по дорожкам: сначала звук без видео (рекордер), потом камеры сверху вниз, в каждой — по времени.
  // DaVinci раскладывает звук клипов по дорожкам в том порядке, в каком встречает их в файле: так звук каждой камеры
  // ложится в том же порядке, что и её видео, а не по тому, какая камера включилась раньше.
  const laneOrder = (l: number) => (l < 0 ? -l : 1000 + l);
  items.sort((a, b) => laneOrder(a.lane) - laneOrder(b.lane) || a.offset - b.offset);

  // Клипы события — как в браузере Final Cut: целиком, со своими ключевыми словами. Отсюда DaVinci их и берёт.
  const browser = [...keywordsOf.keys()].map((id) => {
    const c = clipsById.get(id)!;
    const sr = c.audioSampleRate ?? 48000;
    const r = c.rate ?? seq;
    const [start, duration] = c.hasVideo
      ? [frames(assetStartFrames(c, r), r), frames(c.frames ?? Math.round(c.durationSec * rateValue(r)), r)]
      : [samples(assetStartSamples(c, sr), sr), samples(Math.round(c.durationSec * sr), sr)];
    return `<asset-clip ref="${assetOf(c)}" start="${start}" duration="${duration}" name="${esc(c.name)}"${c.hasVideo ? ` format="${formatOf(c)}"` : ''} tcFormat="NDF">${keyword(c, start, duration)}</asset-clip>`;
  });

  const total = frames(Math.max(1, endFrame), seq);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
<resources>
${formatXml.join('\n')}
${assetXml.join('\n')}
</resources>
<library>
<event name="TimesynCam">
<project name="${esc(opts.name)}">
<!-- Таймлиния начинается с 00:00:00:00 — с первого клипа съёмки -->
<sequence format="r0" tcStart="0s" tcFormat="NDF" duration="${total}" audioLayout="stereo" audioRate="48k">
<spine>
<gap name="${esc(opts.name)}" offset="0s" start="0s" duration="${total}">
${items.map((i) => i.xml).join('\n')}
</gap>
</spine>
</sequence>
</project>
${browser.join('\n')}
</event>
</library>
</fcpxml>
`;
}
