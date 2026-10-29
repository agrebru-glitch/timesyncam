import type { Camera, ClipMeta } from '../src/core/types.ts';

// Структура XML, который пишет Sony A7 IV (клип 25p).
export const SONY_XML_25P = `<?xml version="1.0" encoding="UTF-8"?>
<NonRealTimeMeta xmlns="urn:schemas-professionalDisc:nonRealTimeMeta:ver.2.20" lastUpdate="2026-06-12T16:03:11+03:00">
	<Duration value="240"/>
	<LtcChangeTable tcFps="25" halfStep="false">
		<LtcChange frameCount="0" value="02293023" status="increment"/>
		<LtcChange frameCount="239" value="16383023" status="end"/>
	</LtcChangeTable>
	<CreationDate value="2026-06-12T16:03:01+03:00"/>
	<VideoFormat>
		<VideoFrame videoCodec="AVC140_3840_2160_H422P@L51" captureFps="25.00p" formatFps="25p"/>
		<VideoLayout pixel="3840" numOfVerticalLine="2160" aspectRatio="16:9"/>
	</VideoFormat>
	<Device manufacturer="Sony" modelName="ILCE-7M4" serialNo="4294967295"/>
	<Lens modelName="FE 16-35mm F4 ZA OSS"/>
	<AcquisitionRecord><Group name="CameraUnitMetadataSet"><Item name="CaptureGammaEquation" value="s-log3-cine"/></Group></AcquisitionRecord>
</NonRealTimeMeta>`;

// Клип C9200, 50p: тайм-код считается по 25 с halfStep, в часах конечного значения флаг 0x80.
export const SONY_XML_50P = `<?xml version="1.0" encoding="UTF-8"?>
<NonRealTimeMeta xmlns="urn:schemas-professionalDisc:nonRealTimeMeta:ver.2.20">
	<Duration value="720"/>
	<LtcChangeTable tcFps="25" halfStep="true">
		<LtcChange frameCount="0" value="19590701" status="increment"/>
		<LtcChange frameCount="719" value="03140881" status="end"/>
	</LtcChangeTable>
	<CreationDate value="2026-06-12T17:40:32+03:00"/>
	<VideoFormat><VideoFrame videoCodec="AVC200_3840_2160_H422P@L52" captureFps="50.00p" formatFps="50p"/></VideoFormat>
	<Device manufacturer="Sony" modelName="ILCE-7M4" serialNo="4294967295"/>
</NonRealTimeMeta>`;

export const SONY_XML_SQ = SONY_XML_25P.replace('captureFps="25.00p"', 'captureFps="100.00p"').replace('value="240"', 'value="400"');

let seq = 0;
export function clip(over: Partial<ClipMeta> & { start?: number; tcSeconds?: number }): ClipMeta {
  seq += 1;
  const { start, tcSeconds, ...rest } = over;
  return {
    id: `t${seq}`,
    path: `X:/card/C${seq}.MP4`,
    name: `C${seq}.MP4`,
    sizeBytes: 1e8,
    durationSec: 10,
    recordedSec: 10,
    captureFps: null,
    rate: { num: 25, den: 1 },
    frames: 250,
    width: 3840,
    height: 2160,
    codec: 'h264',
    codecLabel: 'H.264 4:2:2 10-bit',
    hasVideo: true,
    audioChannels: 2,
    audioSampleRate: 48000,
    tc: tcSeconds === undefined ? null : { text: '00:00:00:00', seconds: tcSeconds, countRate: 25, drop: false, source: 'sony-xml' },
    clock: start === undefined ? null : { epochSec: start, precisionSec: 1, tzOffsetMin: 180, source: 'sony-xml' },
    camera: { make: 'Sony', model: 'Sony A7 IV' },
    proxyPath: null,
    playable: false,
    ...rest,
  };
}

export function camera(name: string, clips: ClipMeta[], over: Partial<Camera> = {}): Camera {
  return {
    id: name,
    name,
    folders: [],
    clips,
    manualShiftSec: 0,
    timecodeTrust: 'auto',
    excludedClipIds: [],
    audioAssist: true,
    scanning: null,
    ...over,
  };
}

// 12.06.2026 16:00:00 по Москве (UTC+3)
export const T16 = Date.UTC(2026, 5, 12, 13, 0, 0) / 1000;
