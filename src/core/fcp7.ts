// Экспорт таймлинии в Final Cut Pro 7 XML (xmeml) — его открывают Premiere Pro и DaVinci Resolve.
// Оригинальные файлы не меняются: в XML только ссылки на них и позиции на таймлинии.
import type { Camera, ClipMeta, Placement, Rate, SyncResult } from './types.ts';
import { isNtscRate, nominalRate, parseTc, rateValue, tcToFrameCount, secondsToTcText } from './timecode.ts';

export interface ExportOptions {
  name: string;
  rate: Rate;
  width: number;
  height: number;
}

export interface TimelinePreset {
  rate: Rate;
  label: string;
}

export const TIMELINE_PRESETS: TimelinePreset[] = [
  { rate: { num: 24000, den: 1001 }, label: '23,976' },
  { rate: { num: 24, den: 1 }, label: '24' },
  { rate: { num: 25, den: 1 }, label: '25' },
  { rate: { num: 30000, den: 1001 }, label: '29,97' },
  { rate: { num: 30, den: 1 }, label: '30' },
  { rate: { num: 50, den: 1 }, label: '50' },
  { rate: { num: 60000, den: 1001 }, label: '59,94' },
  { rate: { num: 60, den: 1 }, label: '60' },
];

// Частота таймлинии по умолчанию — базовая частота самого частого семейства (25/50 → 25, 29,97/59,94 → 29,97).
export function defaultTimelineRate(cameras: Camera[]): Rate {
  const weight = new Map<string, number>();
  for (const cam of cameras) {
    for (const c of cam.clips) {
      if (!c.rate) continue;
      let fps = rateValue(c.rate);
      while (fps > 31) fps /= 2;
      const key = isNtscRate(fps) ? `${Math.round(fps)}n` : String(Math.round(fps));
      weight.set(key, (weight.get(key) ?? 0) + c.durationSec);
    }
  }
  const best = [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '25';
  const ntsc = best.endsWith('n');
  const n = Number(best.replace('n', ''));
  return ntsc ? { num: n * 1000, den: 1001 } : { num: n, den: 1 };
}

export function defaultResolution(cameras: Camera[]): { width: number; height: number } {
  const count = new Map<string, number>();
  for (const cam of cameras) for (const c of cam.clips) {
    if (c.width && c.height) count.set(`${c.width}x${c.height}`, (count.get(`${c.width}x${c.height}`) ?? 0) + 1);
  }
  const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '1920x1080';
  const [width, height] = best.split('x').map(Number);
  return { width, height };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function pathToUrl(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const withRoot = /^[A-Za-z]:\//.test(norm) ? `/${norm}` : norm;
  return `file://localhost${encodeURI(withRoot).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

function rateXml(r: Rate): string {
  const ntsc = isNtscRate(rateValue(r));
  return `<rate><timebase>${nominalRate(rateValue(r))}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
}

function clipRate(c: ClipMeta, fallback: Rate): Rate {
  return c.rate ?? fallback;
}

function fileTimecode(c: ClipMeta, r: Rate): { text: string; frame: number; drop: boolean } {
  const fps = rateValue(r);
  const nominal = nominalRate(fps);
  if (c.tc && c.tc.source !== 'bwf') {
    const parts = parseTc(c.tc.text);
    if (parts && parts.f < nominal) return { text: c.tc.text, frame: tcToFrameCount(parts, nominal), drop: parts.drop };
  }
  if (c.tc?.source === 'bwf') {
    const text = secondsToTcText(c.tc.seconds, fps);
    const parts = parseTc(text)!;
    return { text, frame: tcToFrameCount(parts, nominal), drop: false };
  }
  return { text: '00:00:00:00', frame: 0, drop: false };
}

interface TrackItem {
  placement: Placement;
  clip: ClipMeta;
  id: string;
}

export function buildFcp7Xml(cameras: Camera[], result: SyncResult, opts: ExportOptions): string {
  const seqFps = rateValue(opts.rate);
  const clipsById = new Map<string, ClipMeta>();
  for (const cam of cameras) for (const c of cam.clips) clipsById.set(c.id, c);

  // Таймлиния начинается с 00:00:00:00 — с первого клипа съёмки, остальные стоят от него на своих местах.
  // С тайм-кодом времени суток клипы оказывались за много часов от начала, и DaVinci зависал на импорте.
  const seqStartEpoch = result.start;
  const toFrame = (epoch: number) => Math.round((epoch - seqStartEpoch) * seqFps);

  const videoTracks: { cameraName: string; items: TrackItem[] }[] = [];
  const audioTracks: { cameraName: string; channel: number; items: TrackItem[] }[] = [];
  const fileIds = new Map<string, string>();
  let clipCounter = 0;
  let fileCounter = 0;

  for (const cam of cameras) {
    const camPlacements = result.placements.filter((p) => p.cameraId === cam.id).sort((a, b) => a.start - b.start);
    if (camPlacements.length === 0) continue;
    const lanes = Math.max(...camPlacements.map((p) => p.lane)) + 1;
    const maxCh = Math.min(8, Math.max(0, ...camPlacements.map((p) => clipsById.get(p.clipId)!.audioChannels)));
    for (let lane = 0; lane < lanes; lane++) {
      const inLane = camPlacements.filter((p) => p.lane === lane);
      const vItems: TrackItem[] = [];
      for (const p of inLane) {
        const clip = clipsById.get(p.clipId)!;
        if (!clip.hasVideo) continue;
        vItems.push({ placement: p, clip, id: `clipitem-${++clipCounter}` });
      }
      if (vItems.length) videoTracks.push({ cameraName: lane === 0 ? cam.name : `${cam.name} (${lane + 1})`, items: vItems });
      for (let ch = 1; ch <= maxCh; ch++) {
        const aItems: TrackItem[] = [];
        for (const p of inLane) {
          const clip = clipsById.get(p.clipId)!;
          if (clip.audioChannels < ch) continue;
          aItems.push({ placement: p, clip, id: `clipitem-${++clipCounter}` });
        }
        if (aItems.length) audioTracks.push({ cameraName: cam.name, channel: ch, items: aItems });
      }
    }
  }

  // Связи видео и звука одного клипа, чтобы в монтажке они двигались вместе.
  const linksByClip = new Map<string, { id: string; mediatype: 'video' | 'audio'; track: number; index: number }[]>();
  videoTracks.forEach((t, ti) => t.items.forEach((it, ii) => {
    const arr = linksByClip.get(it.clip.id + it.placement.lane) ?? [];
    arr.push({ id: it.id, mediatype: 'video', track: ti + 1, index: ii + 1 });
    linksByClip.set(it.clip.id + it.placement.lane, arr);
  }));
  audioTracks.forEach((t, ti) => t.items.forEach((it, ii) => {
    const arr = linksByClip.get(it.clip.id + it.placement.lane) ?? [];
    arr.push({ id: it.id, mediatype: 'audio', track: ti + 1, index: ii + 1 });
    linksByClip.set(it.clip.id + it.placement.lane, arr);
  }));

  const fileXml = (clip: ClipMeta): string => {
    const existing = fileIds.get(clip.id);
    if (existing) return `<file id="${existing}"/>`;
    const id = `file-${++fileCounter}`;
    fileIds.set(clip.id, id);
    const r = clipRate(clip, opts.rate);
    const tc = fileTimecode(clip, r);
    const durFrames = clip.frames ?? Math.round(clip.durationSec * rateValue(r));
    const video = clip.hasVideo
      ? `<video><samplecharacteristics>${rateXml(r)}<width>${clip.width ?? opts.width}</width><height>${clip.height ?? opts.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></video>`
      : '';
    const audio = clip.audioChannels > 0
      ? `<audio><samplecharacteristics><depth>16</depth><samplerate>${clip.audioSampleRate ?? 48000}</samplerate></samplecharacteristics><channelcount>${clip.audioChannels}</channelcount></audio>`
      : '';
    return `<file id="${id}"><name>${esc(clip.name)}</name><pathurl>${esc(pathToUrl(clip.path))}</pathurl>${rateXml(r)}<duration>${durFrames}</duration>`
      + `<timecode>${rateXml(r)}<string>${tc.text}</string><frame>${tc.frame}</frame><displayformat>${tc.drop ? 'DF' : 'NDF'}</displayformat></timecode>`
      + `<media>${video}${audio}</media></file>`;
  };

  const clipItemXml = (it: TrackItem, mediatype: 'video' | 'audio', channel = 1): string => {
    const start = toFrame(it.placement.start);
    const dur = Math.max(1, Math.round(it.clip.durationSec * seqFps));
    const links = (linksByClip.get(it.clip.id + it.placement.lane) ?? [])
      .map((l) => `<link><linkclipref>${l.id}</linkclipref><mediatype>${l.mediatype}</mediatype><trackindex>${l.track}</trackindex><clipindex>${l.index}</clipindex></link>`)
      .join('');
    const source = mediatype === 'audio' ? `<sourcetrack><mediatype>audio</mediatype><trackindex>${channel}</trackindex></sourcetrack>` : '';
    return `<clipitem id="${it.id}"><name>${esc(it.clip.name)}</name><enabled>TRUE</enabled><duration>${dur}</duration>${rateXml(opts.rate)}`
      + `<start>${start}</start><end>${start + dur}</end><in>0</in><out>${dur}</out>${fileXml(it.clip)}${source}${links}</clipitem>`;
  };

  // Кадры могут совпасть из-за округления — двигаем вплотную, чтобы монтажка не обрезала клип.
  const fixRounding = (items: TrackItem[]) => {
    let lastEnd = -Infinity;
    for (const it of items) {
      const startF = toFrame(it.placement.start);
      if (startF < lastEnd) it.placement = { ...it.placement, start: seqStartEpoch + lastEnd / seqFps };
      lastEnd = toFrame(it.placement.start) + Math.max(1, Math.round(it.clip.durationSec * seqFps));
    }
  };
  videoTracks.forEach((t) => fixRounding(t.items));
  audioTracks.forEach((t) => fixRounding(t.items));

  const endFrame = Math.max(0, ...result.placements.map((p) => toFrame(p.end)));

  const vXml = videoTracks.map((t) => `<track><enabled>TRUE</enabled><locked>FALSE</locked>${t.items.map((it) => clipItemXml(it, 'video')).join('')}</track>`).join('\n');
  const aXml = audioTracks.map((t) => `<track><enabled>TRUE</enabled><locked>FALSE</locked><outputchannelindex>${((t.channel - 1) % 2) + 1}</outputchannelindex>${t.items.map((it) => clipItemXml(it, 'audio', t.channel)).join('')}</track>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
<sequence id="sequence-1">
<name>${esc(opts.name)}</name>
<duration>${endFrame}</duration>
${rateXml(opts.rate)}
<timecode>${rateXml(opts.rate)}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
<media>
<video>
<format><samplecharacteristics>${rateXml(opts.rate)}<width>${opts.width}</width><height>${opts.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>
${vXml}
</video>
<audio>
<numOutputChannels>2</numOutputChannels>
${aXml}
</audio>
</media>
</sequence>
</xmeml>
`;
}
