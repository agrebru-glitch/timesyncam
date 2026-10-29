// Экспорт таймлинии в FCPXML 1.10 — для DaVinci Resolve.
// В отличие от FCP7 XML, звук без видео (рекордер) ставится точно до сэмпла: клип встаёт на ближайший кадр,
// а доля кадра срезается с его начала. Оригинальные файлы не меняются.
import type { Camera, ClipMeta, Rate, SyncResult } from './types.ts';
import { nominalRate, parseTc, rateValue, secondsToTcText, tcToFrameCount, wrapDay } from './timecode.ts';
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
  const nominal = nominalRate(seqFps);
  const tz = result.displayTzOffsetMin;
  const clipsById = new Map<string, ClipMeta>();
  for (const cam of cameras) for (const c of cam.clips) clipsById.set(c.id, c);

  // Начало таймлинии — ровная минута до первого клипа, тайм-код таймлинии = время суток.
  const startWall = Math.floor((result.start + tz * 60) / 60) * 60;
  const seqStartEpoch = startWall - tz * 60;
  const tcStartFrames = Math.round(wrapDay(startWall) * nominal);
  const seqTcText = secondsToTcText(wrapDay(startWall), seqFps);

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

  const items: { lane: number; offset: number; xml: string }[] = [];
  let endFrame = 0;
  for (const cam of cameras) {
    const list = result.placements.filter((p) => p.cameraId === cam.id).sort((a, b) => a.start - b.start);
    const lastEnd = new Map<number, number>();
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
      // Округление не должно наложить клипы одной дорожки друг на друга.
      offset = Math.max(offset, lastEnd.get(l) ?? -Infinity);
      lastEnd.set(l, offset + durFrames);
      endFrame = Math.max(endFrame, offset + durFrames);
      items.push({
        lane: l,
        offset,
        xml: `<asset-clip ref="${assetOf(c)}" lane="${l}" offset="${frames(tcStartFrames + offset, seq)}" start="${start}" duration="${frames(durFrames, seq)}" name="${esc(c.name)}"${c.hasVideo ? ` format="${formatOf(c)}"` : ''} tcFormat="NDF"/>`,
      });
    }
  }
  items.sort((a, b) => a.offset - b.offset || b.lane - a.lane);

  const total = frames(Math.max(1, endFrame), seq);
  const tcStart = frames(tcStartFrames, seq);
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
<!-- Тайм-код таймлинии = время съёмки, начало ${seqTcText} -->
<sequence format="r0" tcStart="${tcStart}" tcFormat="NDF" duration="${total}" audioLayout="stereo" audioRate="48k">
<spine>
<gap name="${esc(opts.name)}" offset="${tcStart}" start="${tcStart}" duration="${total}">
${items.map((i) => i.xml).join('\n')}
</gap>
</spine>
</sequence>
</project>
</event>
</library>
</fcpxml>
`;
}
