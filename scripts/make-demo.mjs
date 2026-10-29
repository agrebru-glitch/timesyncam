// Демо-съёмка для проверки и скриншотов: четыре «камеры» с разными способами записи времени.
// Нужен ffmpeg в PATH. Использование: node scripts/make-demo.mjs [папка]
//
//   Камера 1 — Sony A7 IV: XML рядом с клипом, тайм-код Free Run убегает от часов на 2:10:05, один клип S&Q
//   Камера 2 — Sony FX3: тайм-код синхронизирован с реальным временем (опорная)
//   Камера 3 — GoPro: тайм-кода нет, местное время с пометкой UTC, часы отстают на 2,6 с
//   Рекордер — Zoom H6: WAV с меткой времени BWF
//
// В кадр впечатано настоящее время съёмки — по нему видно, насколько точно встали камеры.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const OUT = process.argv[2] ?? join(tmpdir(), 'timesyncam-demo');
const TZ = 3 * 60; // съёмка в Москве, UTC+3
const DAY = '2026-06-12';
const FONT = 'C\\:/Windows/Fonts/segoeui.ttf';

const pad = (n, w = 2) => String(n).padStart(w, '0');
const hms = (s) => `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(Math.floor(s % 60))}`;
const tc = (s, fps) => `${hms(s)}:${pad(Math.floor((s % 1) * fps + 1e-6))}`;
const bcd = (n) => pad(Math.floor(n / 10) * 16 + (n % 10), 2).length && ((Math.floor(n / 10) << 4) | (n % 10)).toString(16).padStart(2, '0');
const ltc = (s, countFps) => bcd(Math.floor((s % 1) * countFps + 1e-6)) + bcd(Math.floor(s % 60)) + bcd(Math.floor(s / 60) % 60) + bcd(Math.floor(s / 3600) % 24);
const wallToEpoch = (wall) => Date.parse(`${DAY}T00:00:00Z`) / 1000 + wall - TZ * 60;
const isoUtc = (epoch) => new Date(epoch * 1000).toISOString().replace('Z', '000Z');
const isoLocal = (epoch) => new Date((epoch + TZ * 60) * 1000).toISOString().slice(0, 19);
const w = (h, m, s) => h * 3600 + m * 60 + s;

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg завершился с кодом ${r.status}`);
}

function video(path, { label, wall, dur, fps, hue, width = 1280, height = 720, timecode, creation, handler }) {
  const text = `${label}   реальное время %{pts\\:hms\\:${wall.toFixed(3)}}`;
  const vf = [
    `hue=h=${hue}`,
    `drawtext=fontfile='${FONT}':text='${text}':x=(w-text_w)/2:y=h*0.42:fontsize=40:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=14`,
  ].join(',');
  const args = [
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}:duration=${dur}`,
    '-f', 'lavfi', '-i', `sine=frequency=${300 + hue}:sample_rate=48000:duration=${dur}`,
    '-vf', vf, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-shortest',
    '-metadata', `creation_time=${creation}`,
  ];
  if (timecode) args.push('-timecode', timecode);
  if (handler) args.push('-metadata:s:v', `handler_name=${handler}`);
  ffmpeg([...args, path]);
}

function sonyXml({ frames, tcStart, countFps, halfStep, creationLocal, captureFps, formatFps, model, lens, width, height }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<NonRealTimeMeta xmlns="urn:schemas-professionalDisc:nonRealTimeMeta:ver.2.20">
	<Duration value="${frames}"/>
	<LtcChangeTable tcFps="${countFps}" halfStep="${halfStep}">
		<LtcChange frameCount="0" value="${tcStart}" status="increment"/>
	</LtcChangeTable>
	<CreationDate value="${creationLocal}+03:00"/>
	<VideoFormat>
		<VideoFrame videoCodec="AVC_1280_720_HP@L41" captureFps="${captureFps.toFixed(2)}p" formatFps="${formatFps}p"/>
		<VideoLayout pixel="${width}" numOfVerticalLine="${height}" aspectRatio="16:9"/>
	</VideoFormat>
	<Device manufacturer="Sony" modelName="${model}" serialNo="4294967295"/>
	<Lens modelName="${lens}"/>
	<AcquisitionRecord><Group name="CameraUnitMetadataSet"><Item name="CaptureGammaEquation" value="s-cinetone"/></Group></AcquisitionRecord>
</NonRealTimeMeta>
`;
}

function sonyCamera(dir, clips, { model, lens, tcOffset, hue, label }) {
  mkdirSync(dir, { recursive: true });
  clips.forEach((c, i) => {
    const name = `C${pad(i + 1, 4)}`;
    const fps = c.fps ?? 25;
    const fileDur = c.sq ? c.dur * (c.sq / fps) : c.dur;
    const tcWall = (c.wall + tcOffset + 86400) % 86400;
    const countFps = fps > 30 ? fps / 2 : fps;
    const epoch = wallToEpoch(c.wall);
    video(join(dir, `${name}.MP4`), {
      label: `${label} · ${name}${c.sq ? ' · S&Q' : ''}`, wall: c.wall, dur: fileDur, fps, hue,
      width: c.width, height: c.height, timecode: tc(tcWall, fps), creation: isoUtc(Math.floor(epoch)),
    });
    writeFileSync(join(dir, `${name}M01.XML`), sonyXml({
      frames: Math.round(fileDur * fps), tcStart: ltc(tcWall, countFps), countFps, halfStep: fps > 30,
      creationLocal: isoLocal(Math.floor(epoch)), captureFps: c.sq ?? fps, formatFps: fps, model, lens,
      width: c.width ?? 1280, height: c.height ?? 720,
    }));
  });
}

mkdirSync(OUT, { recursive: true });

sonyCamera(join(OUT, 'Камера 1 — A7 IV'), [
  { wall: w(15, 0, 5.4), dur: 12 },
  { wall: w(15, 1, 10.2), dur: 20 },
  { wall: w(15, 3, 40.76), dur: 25, fps: 50 },
  { wall: w(15, 6, 0.5), dur: 6, sq: 100 },
  { wall: w(15, 9, 30.3), dur: 15, width: 960, height: 540 },
  { wall: w(15, 12, 0.88), dur: 30 },
  { wall: w(15, 16, 45.1), dur: 18 },
  { wall: w(15, 20, 10.64), dur: 40 },
], { model: 'ILCE-7M4', lens: 'FE 24-70mm F2.8 GM II', tcOffset: w(2, 10, 5.44), hue: 0, label: 'Камера 1' });

sonyCamera(join(OUT, 'Камера 2 — FX3'), [
  { wall: w(15, 0, 0.2), dur: 60 },
  { wall: w(15, 2, 30.6), dur: 90 },
  { wall: w(15, 6, 30.12), dur: 45 },
  { wall: w(15, 11, 30.4), dur: 120 },
  { wall: w(15, 16, 0.08), dur: 60 },
  { wall: w(15, 19, 50.52), dur: 70 },
], { model: 'ILME-FX3', lens: 'FE 70-200mm F2.8 GM OSS II', tcOffset: 0, hue: 120, label: 'Камера 2' });

// GoPro: часы отстают на 2,6 с, время записано как местное с пометкой UTC.
const goDir = join(OUT, 'Камера 3 — GoPro');
mkdirSync(goDir, { recursive: true });
[{ wall: w(15, 0, 20.3), dur: 50 }, { wall: w(15, 5, 0.7), dur: 80 }, { wall: w(15, 11, 50.15), dur: 100 }].forEach((c, i) => {
  const shown = c.wall - 2.6;
  video(join(goDir, `GX01${pad(i + 1, 4)}.MP4`), {
    label: `Камера 3 · GX01${pad(i + 1, 4)}`, wall: c.wall, dur: c.dur, fps: 50, hue: 240,
    creation: `${DAY}T${hms(Math.floor(shown))}.000000Z`, handler: 'GoPro AVC',
  });
});

// Рекордер: BWF с меткой времени и датой.
const zoomDir = join(OUT, 'Рекордер — Zoom H6');
mkdirSync(zoomDir, { recursive: true });
[{ wall: w(15, 0, 0), dur: 120 }, { wall: w(15, 10, 0), dur: 180 }].forEach((c, i) => {
  ffmpeg([
    '-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=48000:duration=${c.dur}`,
    '-ac', '1', '-c:a', 'pcm_s16le', '-write_bext', '1',
    '-metadata', `time_reference=${c.wall * 48000}`, '-metadata', `origination_date=${DAY}`,
    '-metadata', `origination_time=${hms(c.wall)}`, '-metadata', 'originator=ZOOM H6',
    join(zoomDir, `ZOOM${pad(i + 1, 4)}.WAV`),
  ]);
});

console.log(`Демо-съёмка готова: ${OUT}`);
