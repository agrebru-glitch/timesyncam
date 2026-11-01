// Демо-съёмка для проверки и скриншотов: пять «камер» с разными способами записи времени.
// Нужен ffmpeg в PATH. Использование: node scripts/make-demo.mjs [папка] [--concert]
//
// --concert — трудная сцена по отзывам бета-тестеров (см. concertScene ниже): концерт с повторяющейся
// музыкой, камера с часами на 50 с вперёд, рекордер с датой 2010 года и петличка, порезанная на куски.
//
//   Камера 1 — Sony A7 IV: XML рядом с клипом, тайм-код Free Run убегает от часов на 2:10:05, один клип S&Q
//   Камера 2 — Sony FX3: тайм-код синхронизирован с реальным временем (опорная)
//   Камера 3 — GoPro: тайм-кода нет, местное время с пометкой UTC, часы отстают на 2,6 с
//   Камера 4 — Sony A7 III: на камере чужой часовой пояс (UTC+5) и часы отстают на 12 мин 40 с
//   Рекордер — Zoom H6: WAV с меткой времени BWF
//
// Все камеры пишут один и тот же звук площадки (хлопки, стуки, сигналы) со своим шумом и громкостью —
// по нему программа сверяет камеры. В кадр впечатано настоящее время съёмки.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as qrModule from 'qrcode-generator';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CONCERT = process.argv.includes('--concert');
const OUT = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(tmpdir(), CONCERT ? 'timesyncam-concert' : 'timesyncam-demo');
const TZ = 3 * 60; // съёмка в Москве, UTC+3
const DAY = CONCERT ? '2026-10-30' : '2026-06-12';
const FONT = 'C\\:/Windows/Fonts/segoeui.ttf';
const SR = 48000;

const pad = (n, w = 2) => String(n).padStart(w, '0');
const hms = (s) => `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(Math.floor(s % 60))}`;
const tc = (s, fps) => `${hms(s)}:${pad(Math.floor((s % 1) * fps + 1e-6))}`;
const bcd = (n) => ((Math.floor(n / 10) << 4) | (n % 10)).toString(16).padStart(2, '0');
const ltc = (s, countFps) => bcd(Math.floor((s % 1) * countFps + 1e-6)) + bcd(Math.floor(s % 60)) + bcd(Math.floor(s / 60) % 60) + bcd(Math.floor(s / 3600) % 24);
const wallToEpoch = (wall) => Date.parse(`${DAY}T00:00:00Z`) / 1000 + wall - TZ * 60;
const isoUtc = (epoch) => new Date(epoch * 1000).toISOString().replace('Z', '000Z');
const isoAt = (epoch, tzMin) => new Date((epoch + tzMin * 60) * 1000).toISOString().slice(0, 19);
const tzText = (tzMin) => `${tzMin < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(tzMin) / 60))}:${pad(Math.abs(tzMin) % 60)}`;
const w = (h, m, s) => h * 3600 + m * 60 + s;

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg завершился с кодом ${r.status}`);
}

// Звук площадки: случайные, но одинаковые для всех камер события.
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const events = [];
{
  const rnd = prng(20260612);
  for (let t = w(14, 59, 0); t < w(15, 25, 0); t += 0.35 + rnd() * 2.2) {
    const kind = rnd();
    events.push({ t, kind: kind < 0.45 ? 'clap' : kind < 0.75 ? 'knock' : 'blip', amp: 0.35 + rnd() * 0.55, freq: 500 + rnd() * 1500, seed: Math.floor(rnd() * 1e9) });
  }
}

// Длительность события в секундах.
const eventLen = (e) => (e.kind === 'note' ? e.len : e.kind === 'cough' ? 0.18 : e.kind === 'blip' ? 0.09 : e.kind === 'knock' ? 0.08 : 0.04);

// Звук, который слышит устройство: общие события площадки со своей громкостью и шумом.
// mute — отрезки настоящего времени, когда устройство общего звука не слышит (человек с петличкой вышел);
// own — свои события устройства, которых нет у других (голос рядом с петличкой).
function renderEvents(out, wallStart, list, g, heard = () => true) {
  const n = out.length;
  for (const e of list) {
    const elen = eventLen(e);
    if (e.t + elen < wallStart || e.t > wallStart + n / SR) continue;
    if (!heard(e.t)) continue;
    const er = prng(e.seed);
    const len = Math.round(elen * SR);
    for (let k = 0; k < len; k++) {
      const i = Math.round((e.t - wallStart) * SR) + k;
      if (i < 0 || i >= n) continue;
      const tt = k / SR;
      let v;
      if (e.kind === 'clap') v = (er() * 2 - 1) * Math.exp(-tt / 0.008);
      else if (e.kind === 'knock') v = Math.sin(2 * Math.PI * 140 * tt) * Math.exp(-tt / 0.02);
      else if (e.kind === 'cough') v = (er() * 2 - 1) * Math.min(1, tt / 0.01) * Math.exp(-tt / 0.05);
      else if (e.kind === 'note') {
        const ph = 2 * Math.PI * e.freq * tt;
        v = (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph)) * Math.min(1, tt / 0.01) * Math.exp(-tt / (e.len / 3));
      } else v = Math.sin(2 * Math.PI * e.freq * tt) * Math.min(1, tt / 0.005) * Math.exp(-tt / 0.04);
      out[i] += v * e.amp * g;
    }
  }
}

// Зал: гулкость по Шрёдеру (четыре гребёнки и два фазовых фильтра), у каждого места в зале — свои задержки.
function reverb(x, amount, seed) {
  const r = prng(seed);
  const k = 1 + r() * 0.15;
  const combs = [1557, 1617, 1491, 1422].map((d) => ({ buf: new Float32Array(Math.round(d * k)), i: 0 }));
  const alls = [225, 556].map((d) => ({ buf: new Float32Array(Math.round(d * k)), i: 0 }));
  const y = new Float32Array(x.length);
  for (let n = 0; n < x.length; n++) {
    let s = 0;
    for (const c of combs) {
      const o = c.buf[c.i];
      c.buf[c.i] = x[n] + o * 0.86;
      c.i = (c.i + 1) % c.buf.length;
      s += o;
    }
    s *= 0.25;
    for (const a of alls) {
      const o = a.buf[a.i];
      const v = s + o * 0.5;
      a.buf[a.i] = v;
      a.i = (a.i + 1) % a.buf.length;
      s = o - v * 0.5;
    }
    y[n] = x[n] * (1 - amount) + s * amount * 1.6;
  }
  return y;
}

// Окраска микрофона: срез низов и верхов простыми фильтрами первого порядка.
function color(x, lowpass, highpass) {
  if (lowpass) {
    const a = Math.exp(-2 * Math.PI * lowpass / SR);
    let s = 0;
    for (let n = 0; n < x.length; n++) x[n] = s = (1 - a) * x[n] + a * s;
  }
  if (highpass) {
    const a = Math.exp(-2 * Math.PI * highpass / SR);
    let lp = 0;
    for (let n = 0; n < x.length; n++) {
      lp = (1 - a) * x[n] + a * lp;
      x[n] -= lp;
    }
  }
  return x;
}

function soundAt(wallStart, dur, { gain = 1, noise = 0.01, seed = 1, mute = [], own = [], room = 0, delay = 0, lowpass = 0, highpass = 0 }, evs = events) {
  const n = Math.round(dur * SR);
  const rnd = prng(seed);
  const heard = (t) => !mute.some(([a, b]) => t >= a && t < b);
  let out;
  if (room || delay || lowpass || highpass) {
    // Общий звук приходит в микрофон с задержкой, окрашенным и с хвостом гулкости от предыдущих нот.
    const pre = 4;
    const shared = new Float32Array(n + Math.round(pre * SR));
    renderEvents(shared, wallStart - pre - delay, evs, gain, heard);
    const wet = reverb(color(shared, lowpass, highpass), room, seed * 31 + 7);
    out = wet.slice(Math.round(pre * SR));
  } else {
    out = new Float32Array(n);
    renderEvents(out, wallStart, evs, gain, heard);
  }
  for (let i = 0; i < n; i++) out[i] += (rnd() * 2 - 1) * noise;
  renderEvents(out, wallStart, own, 1);
  return out;
}

function writeWav(path, samples, extra = []) {
  const raw = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) raw.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const tmp = `${path}.raw`;
  writeFileSync(tmp, raw);
  ffmpeg(['-f', 's16le', '-ar', String(SR), '-ac', '1', '-i', tmp, '-c:a', 'pcm_s16le', ...extra, path]);
  rmSync(tmp);
}

function video(path, { label, wall, dur, fps, hue, width = 1280, height = 720, timecode, creation, handler, sound, evs = events, small = false }) {
  const text = `${label}   реальное время %{pts\\:hms\\:${wall.toFixed(3)}}`;
  const vf = [
    `hue=h=${hue}`,
    `drawtext=fontfile='${FONT}':text='${text}':x=(w-text_w)/2:y=h*0.42:fontsize=${small ? 12 : 40}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=${small ? 4 : 14}`,
  ].join(',');
  const args = ['-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}:duration=${dur}`];
  let wav = null;
  if (sound) {
    wav = `${path}.wav`;
    writeWav(wav, soundAt(wall, dur, sound, evs));
    args.push('-i', wav);
  }
  args.push('-vf', vf, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p');
  if (sound) args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-shortest');
  args.push('-metadata', `creation_time=${creation}`);
  if (timecode) args.push('-timecode', timecode);
  if (handler) args.push('-metadata:s:v', `handler_name=${handler}`);
  ffmpeg([...args, path]);
  if (wav) rmSync(wav);
}

// «Экран синхронизации», снятый камерой: QR-код с временем часов компьютера меняется каждую секунду.
// Если смена пришлась на выдержку кадра, кадр получается смешанным из двух кодов — как у настоящей камеры.
const qrcode = qrModule.default ?? qrModule;
const QW = 1280;
const QH = 720;
const qrCache = new Map();
function qrFrame(sec) {
  if (qrCache.has(sec)) return qrCache.get(sec);
  const q = qrcode(0, 'M');
  q.addData(`TSC1 ${sec * 1000}`);
  q.make();
  const n = q.getModuleCount();
  const img = Buffer.alloc(QW * QH, 70);
  const S = Math.round(QH * 0.8);
  const x0 = Math.round((QW - S) / 2) + 90;
  const y0 = Math.round((QH - S) / 2) - 20;
  for (let y = y0; y < y0 + S; y++) img.fill(232, y * QW + x0, y * QW + x0 + S);
  const px = Math.floor(S / (n + 8));
  const ox = x0 + Math.round((S - px * n) / 2);
  const oy = y0 + Math.round((S - px * n) / 2);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!q.isDark(r, c)) continue;
    for (let y = 0; y < px; y++) img.fill(18, (oy + r * px + y) * QW + ox + c * px, (oy + r * px + y) * QW + ox + (c + 1) * px);
  }
  if (qrCache.size > 8) qrCache.delete(qrCache.keys().next().value);
  qrCache.set(sec, img);
  return img;
}

async function qrClip(path, { wall, dur, fps, timecode, creation, handler, sound }) {
  let wav = null;
  const args = ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${QW}x${QH}`, '-r', String(fps), '-i', 'pipe:0'];
  if (sound) {
    wav = `${path}.wav`;
    writeWav(wav, soundAt(wall, dur, sound));
    args.push('-i', wav);
  }
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p');
  if (sound) args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-shortest');
  args.push('-metadata', `creation_time=${creation}`);
  if (timecode) args.push('-timecode', timecode);
  if (handler) args.push('-metadata:s:v', `handler_name=${handler}`);
  const child = spawn('ffmpeg', [...args, path], { stdio: ['pipe', 'inherit', 'inherit'] });
  const epoch0 = wallToEpoch(wall);
  const exposure = 0.5 / fps;
  const frames = Math.round(dur * fps);
  for (let k = 0; k < frames; k++) {
    const t0 = epoch0 + k / fps;
    const a = Math.floor(t0);
    const b = Math.floor(t0 + exposure);
    let img = qrFrame(a);
    if (b !== a) {
      const f = (t0 + exposure - b) / exposure;
      const ib = qrFrame(b);
      const mix = Buffer.alloc(QW * QH);
      for (let i = 0; i < mix.length; i++) mix[i] = Math.round(img[i] * (1 - f) + ib[i] * f);
      img = mix;
    }
    if (!child.stdin.write(img)) await once(child.stdin, 'drain');
  }
  child.stdin.end();
  const [code] = await once(child, 'close');
  if (code !== 0) throw new Error(`ffmpeg завершился с кодом ${code}`);
  if (wav) rmSync(wav);
}

function sonyXml({ frames, tcStart, countFps, halfStep, creation, captureFps, formatFps, model, lens, width, height }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<NonRealTimeMeta xmlns="urn:schemas-professionalDisc:nonRealTimeMeta:ver.2.20">
	<Duration value="${frames}"/>
	<LtcChangeTable tcFps="${countFps}" halfStep="${halfStep}">
		<LtcChange frameCount="0" value="${tcStart}" status="increment"/>
	</LtcChangeTable>
	<CreationDate value="${creation}"/>
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

// clockShift — насколько часы камеры уходят от реального времени, tzMin — какой пояс выставлен на камере.
async function sonyCamera(dir, clips, { model, lens, tcOffset, hue, label, sound, clockShift = 0, tzMin = TZ, small = false, evs = events }) {
  mkdirSync(dir, { recursive: true });
  for (const [i, c] of clips.entries()) {
    const name = `C${pad(i + 1, 4)}`;
    const fps = c.fps ?? 25;
    const fileDur = c.sq ? c.dur * (c.sq / fps) : c.dur;
    // Настоящая камера начинает запись ровно на границе кадра своего тайм-кода — двигаем начало клипа на неё.
    const tcExact = c.wall + clockShift + tcOffset;
    const wall = c.wall + (Math.ceil(tcExact * fps - 1e-9) / fps - tcExact);
    const camWall = wall + clockShift;
    const tcWall = ((camWall + tcOffset) % 86400 + 86400) % 86400;
    const countFps = fps > 30 ? fps / 2 : fps;
    const camEpoch = Math.floor(Date.parse(`${DAY}T00:00:00Z`) / 1000 + camWall - tzMin * 60);
    truth.push({ file: `${dir.split(/[\\/]/).pop()}/${name}.MP4`, epoch: wallToEpoch(wall) });
    const meta = { wall, dur: fileDur, fps, timecode: tc(tcWall, fps), creation: isoUtc(camEpoch), sound: c.sq ? null : { ...sound, seed: sound.seed + i }, evs };
    const width = c.width ?? (small ? 320 : 1280);
    const height = c.height ?? (small ? 180 : 720);
    if (c.qr) await qrClip(join(dir, `${name}.MP4`), meta);
    else video(join(dir, `${name}.MP4`), { ...meta, label: `${label} · ${name}${c.sq ? ' · S&Q' : ''}`, hue, width, height, small });
    writeFileSync(join(dir, `${name}M01.XML`), sonyXml({
      frames: Math.round(fileDur * fps), tcStart: ltc(tcWall, countFps), countFps, halfStep: fps > 30,
      creation: `${isoAt(camEpoch, tzMin)}${tzText(tzMin)}`, captureFps: c.sq ?? fps, formatFps: fps, model, lens, width, height,
    }));
  }
}

// Настоящее время начала каждого клипа — для проверки точности (scripts/truth-check.mts).
const truth = [];

async function demoScene() {

  // Камеры 1, 3 и 4 после съёмки, в 15:23, сняли «Экран синхронизации» — по нему работает контрольный кадр.
  await sonyCamera(join(OUT, 'Камера 1 — A7 IV'), [
    { wall: w(15, 0, 5.4), dur: 12 },
    { wall: w(15, 1, 10.2), dur: 20 },
    { wall: w(15, 3, 40.76), dur: 25, fps: 50 },
    { wall: w(15, 6, 0.5), dur: 6, sq: 100 },
    { wall: w(15, 9, 30.3), dur: 15, width: 960, height: 540 },
    { wall: w(15, 12, 0.88), dur: 30 },
    { wall: w(15, 16, 45.1), dur: 18 },
    { wall: w(15, 20, 10.64), dur: 40 },
    { wall: w(15, 23, 0.37), dur: 8, qr: true },
  ], { model: 'ILCE-7M4', lens: 'FE 24-70mm F2.8 GM II', tcOffset: w(2, 10, 5.44), hue: 0, label: 'Камера 1', sound: { gain: 0.6, noise: 0.012, seed: 100 } });

  await sonyCamera(join(OUT, 'Камера 2 — FX3'), [
    { wall: w(15, 0, 0.2), dur: 60 },
    { wall: w(15, 2, 30.6), dur: 90 },
    { wall: w(15, 6, 30.12), dur: 45 },
    { wall: w(15, 11, 30.4), dur: 120 },
    { wall: w(15, 16, 0.08), dur: 60 },
    { wall: w(15, 19, 50.52), dur: 70 },
  ], { model: 'ILME-FX3', lens: 'FE 70-200mm F2.8 GM OSS II', tcOffset: 0, hue: 120, label: 'Камера 2', sound: { gain: 0.9, noise: 0.008, seed: 200 } });

  // GoPro: часы отстают на 2,6 с, время записано как местное с пометкой UTC.
  const goDir = join(OUT, 'Камера 3 — GoPro');
  mkdirSync(goDir, { recursive: true });
  for (const [i, c] of [{ wall: w(15, 0, 20.3), dur: 50 }, { wall: w(15, 5, 0.7), dur: 80 }, { wall: w(15, 11, 50.15), dur: 100 }, { wall: w(15, 23, 4.06), dur: 8, qr: true }].entries()) {
    const shown = c.wall - 2.6;
    truth.push({ file: `Камера 3 — GoPro/GX01${pad(i + 1, 4)}.MP4`, epoch: wallToEpoch(c.wall) });
    const meta = {
      wall: c.wall, dur: c.dur, fps: 50, creation: `${DAY}T${hms(Math.floor(shown))}.000000Z`, handler: 'GoPro AVC',
      sound: { gain: 0.5, noise: 0.03, seed: 300 + i },
    };
    if (c.qr) await qrClip(join(goDir, `GX01${pad(i + 1, 4)}.MP4`), meta);
    else video(join(goDir, `GX01${pad(i + 1, 4)}.MP4`), { ...meta, label: `Камера 3 · GX01${pad(i + 1, 4)}`, hue: 240 });
  }

  // A7 III с неверным поясом (UTC+5 вместо +3) и часами на 12 мин 40 с позади — как бывает на реальных съёмках.
  await sonyCamera(join(OUT, 'Камера 4 — A7 III'), [
    { wall: w(15, 4, 12.3), dur: 50 },
    { wall: w(15, 13, 5.7), dur: 65 },
    { wall: w(15, 23, 2.61), dur: 8, qr: true },
  ], { model: 'ILCE-7M3', lens: 'FE 35mm F1.8', tcOffset: w(4, 41, 7.2), hue: 300, label: 'Камера 4', sound: { gain: 0.7, noise: 0.015, seed: 400 }, clockShift: -(12 * 60 + 40), tzMin: 5 * 60 });

  // Рекордер: BWF с меткой времени и датой.
  const zoomDir = join(OUT, 'Рекордер — Zoom H6');
  mkdirSync(zoomDir, { recursive: true });
  [{ wall: w(15, 0, 0), dur: 120 }, { wall: w(15, 10, 0), dur: 180 }].forEach((c, i) => {
    truth.push({ file: `Рекордер — Zoom H6/ZOOM${pad(i + 1, 4)}.WAV`, epoch: wallToEpoch(c.wall) });
    writeWav(join(zoomDir, `ZOOM${pad(i + 1, 4)}.WAV`), soundAt(c.wall, c.dur, { gain: 1, noise: 0.004, seed: 500 + i }), [
      '-write_bext', '1',
      '-metadata', `time_reference=${c.wall * SR}`, '-metadata', `origination_date=${DAY}`,
      '-metadata', `origination_time=${hms(c.wall)}`, '-metadata', 'originator=ZOOM H6',
    ]);
  });
}

// Концерт — трудная сцена по отзывам бета-тестеров. Что в ней сломало прежнюю логику:
//   CAM 01–03  — Sony, тайм-код Free Run не по реальному времени; у CAM 02 часы на 50 с вперёд;
//   FOLDER01   — рекордер Zoom: дата BWF 4 февраля 2010 года и тайм-код по этим же неверным часам,
//                запись разбита на два файла без промежутка;
//   hl-…       — петличка: моно WAV без метаданных, время только в имени файла (часы на 3,2 с вперёд),
//                запись порезана на куски по 5 минут; во втором куске человек вышел в другое помещение.
// Музыка повторяет одну фразу каждые 50 секунд, как реприза: на коротком куске звука сдвиг на целую
// фразу «совпадает» не хуже настоящего. Отличают только кашель зала и непохожие части пьесы.
function concertEvents() {
  const evs = [];
  const PHRASE = 50;
  const section = (seed, start) => {
    const r = prng(seed);
    for (let t = 0; t < PHRASE; t += 0.15 + r() * 0.3) {
      // Аккорд из двух-трёх нот с одной атакой, ноты тянутся — как у оркестра.
      const root = Math.floor(r() * 20);
      for (const step of [0, 4, 7].slice(0, 2 + Math.floor(r() * 2))) {
        evs.push({ t: start + t, kind: 'note', freq: 130 * 2 ** ((root + step) / 12), amp: 0.15 + r() * 0.3, len: 0.6 + r() * 1.4, seed: Math.floor(r() * 1e9) });
      }
    }
  };
  const seeds = { A: 11, B: 12, C: 13, D: 14, E: 15, F: 16, G: 17 };
  const act = (start, plan) => [...plan].forEach((s, i) => section(seeds[s], start + i * PHRASE));
  const applause = (start, dur, seed) => {
    const r = prng(seed);
    for (let t = start; t < start + dur; t += 0.015 + r() * 0.05) evs.push({ t, kind: 'clap', amp: 0.15 + r() * 0.35, seed: Math.floor(r() * 1e9) });
  };
  act(w(19, 0, 0), 'AABACAAD');
  applause(w(19, 6, 40), 15, 31);
  act(w(19, 8, 30), 'EAAFAGAA');
  applause(w(19, 15, 10), 15, 32);
  // Кашель и шорохи зала — редкие, у всех в зале одни и те же.
  const r = prng(77);
  for (let t = w(18, 57, 30); t < w(19, 18, 0); t += 20 + r() * 50) evs.push({ t, kind: 'cough', amp: 0.08 + r() * 0.15, seed: Math.floor(r() * 1e9) });
  return evs.sort((a, b) => a.t - b.t);
}

async function concertScene() {
  const evs = concertEvents();
  const cam = (name, clips, opts) => sonyCamera(join(OUT, name), clips, { small: true, evs, lens: 'FE 24-105mm F4 G OSS', ...opts });
  await cam('CAM 01', [{ wall: w(18, 59, 40), dur: 440 }, { wall: w(19, 8, 10), dur: 450 }],
    { model: 'ILCE-7M4', tcOffset: w(1, 20, 0.32), hue: 0, label: 'CAM 01', clockShift: 0.4, sound: { gain: 0.7, noise: 0.02, seed: 1100, room: 0.45, delay: 0.012, lowpass: 9000, highpass: 120 } });
  await cam('CAM 02', [{ wall: w(18, 59, 20), dur: 465 }, { wall: w(19, 8, 0), dur: 470 }],
    { model: 'ILCE-7M4', tcOffset: w(14, 47, 4.6), hue: 120, label: 'CAM 02', clockShift: 50.3, sound: { gain: 0.9, noise: 0.03, seed: 1200, room: 0.75, delay: 0.045, lowpass: 5000, highpass: 200 } });
  await cam('CAM 03', [{ wall: w(18, 59, 50), dur: 425 }, { wall: w(19, 8, 20), dur: 440 }],
    { model: 'ILCE-7M3', tcOffset: w(3, 50, 1.6), hue: 240, label: 'CAM 03', clockShift: -0.8, sound: { gain: 0.6, noise: 0.025, seed: 1300, room: 0.55, delay: 0.02, lowpass: 7000, highpass: 150 } });

  // Zoom с неверной датой: часы рекордера показывают 4 февраля 2010, 08:05:10, когда на самом деле 18:58:00.
  const zoomDir = join(OUT, 'FOLDER01');
  mkdirSync(zoomDir, { recursive: true });
  const zoomClock = Date.parse('2010-02-04T08:05:10+03:00') / 1000;
  let zWall = w(18, 58, 0);
  let zClock = 8 * 3600 + 5 * 60 + 10;
  for (const [i, dur] of [600, 560].entries()) {
    const name = `ZOOM${pad(i + 1, 4)}.WAV`;
    truth.push({ file: `FOLDER01/${name}`, epoch: wallToEpoch(zWall) });
    writeWav(join(zoomDir, name), soundAt(zWall, dur, { gain: 1, noise: 0.006, seed: 1500 + i, room: 0.3, delay: 0.004 }, evs), [
      '-ac', '2', '-write_bext', '1',
      '-metadata', `time_reference=${zClock * SR}`, '-metadata', 'origination_date=2010-02-04',
      '-metadata', `origination_time=${hms(zClock)}`, '-metadata', 'originator=ZOOM H5',
    ]);
    const end = zoomClock + (zClock - (8 * 3600 + 5 * 60 + 10)) + dur;
    utimesSync(join(zoomDir, name), end, end);
    zWall += dur;
    zClock += dur;
  }

  // Петличка: куски по 5 минут, имя — время начала по часам петлички (на 3,2 с вперёд), дата файла — конец куска.
  const hlDir = join(OUT, 'hl-2026-10-30');
  mkdirSync(hlDir, { recursive: true });
  const outside = [w(19, 4, 6), w(19, 9, 6)]; // второй кусок — человек в другом помещении
  const speech = [];
  {
    const r = prng(91);
    for (let t = w(18, 59, 0); t < w(19, 17, 0); t += 0.15 + r() * 0.6) speech.push({ t, kind: 'blip', freq: 140 + r() * 260, amp: 0.2 + r() * 0.3, seed: Math.floor(r() * 1e9) });
  }
  let hWall = w(18, 59, 6);
  for (const [i, dur] of [300, 300, 300, 150].entries()) {
    const shown = hWall + 3.2;
    const name = `${pad(Math.floor(shown / 3600))}-${pad(Math.floor(shown / 60) % 60)}-${pad(Math.floor(shown % 60))}.wav`;
    truth.push({ file: `hl-2026-10-30/${name}`, epoch: wallToEpoch(hWall) });
    const ownSpeech = i === 1 ? speech : speech.filter((_, k) => k % 7 === 0);
    writeWav(join(hlDir, name), soundAt(hWall, dur, { gain: 0.25, noise: 0.02, seed: 1600 + i, mute: [outside], own: ownSpeech, room: 0.8, delay: 0.03, lowpass: 4000, highpass: 250 }, evs));
    const end = wallToEpoch(hWall + dur) + 3.2;
    utimesSync(join(hlDir, name), end, end);
    hWall += dur;
  }
}

mkdirSync(OUT, { recursive: true });
if (CONCERT) await concertScene();
else await demoScene();
writeFileSync(join(OUT, 'truth.json'), JSON.stringify(truth, null, 1));
console.log(`${CONCERT ? 'Концертная съёмка' : 'Демо-съёмка'} готова: ${OUT}`);
