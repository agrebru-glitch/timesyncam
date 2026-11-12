// Звук предпросмотра. Все слышимые дорожки играют через один AudioContext: каждый кусок записи ставится
// на общие часы по месту клипа на таймлинии, с точностью до сэмпла. Так на слух слышно, совпали ли записи:
// разошедшиеся на 10–40 мс звучат эхом, на сотни миллисекунд — двоятся. Видео при этом идёт без звука:
// у плеера каждого окна свои часы, и они расходятся на десятки миллисекунд.
import type { Camera, ClipMeta, Placement } from '../core/types.ts';
import { api } from './api.ts';

const SR = 48000;
const CHUNK = 8; // секунд звука в одном куске; куски — по сетке таймлинии, чтобы прочитанное шло в дело повторно
const LEAD = CHUNK; // следующий кусок читается, как только начал звучать текущий: впереди всегда 8–16 с звука
const START_LIMIT = 30; // столько ждём первые куски всех дорожек; что не успело — вступит позже, но на своём месте
const START_DELAY = 0.06; // запас на старт после того, как куски готовы
const CACHE_BYTES = 256 * 1024 * 1024; // буфер прочитанного звука: около 20 минут звука дорожек
// Громкость дорожек выравнивается по громким местам: петличка или рекордер, записанные на 15–20 дБ тише камер,
// иначе тонут в их звуке (у тестера рекордер −49 дБ в среднем против −32 дБ у камер — его не было слышно).
const LOUD_TARGET = 0.1; // −20 дБ: уровень громких мест каждой дорожки
const MAX_BOOST = 16; // +24 дБ — тише не поднимаем: там шум, а не запись
const MIN_CUT = 0.5;
const QUIET = 0.001; // −60 дБ: кусок тише — тишина, уровень по нему не меряем

interface Track {
  gain: GainNode;
  sources: Set<AudioBufferSourceNode>;
  until: number; // до какого времени таймлинии звук дорожки уже заказан
  ready: number; // до какого времени он уже прочитан и стоит в очереди
  busy: boolean;
  on: boolean;
}

// Уровень громких мест куска: 90-й процентиль громкости по 50 мс — одиночный хлопок его не задирает.
export function loudLevel(data: Float32Array, sr = SR): number {
  const frame = Math.round(sr * 0.05);
  const rms: number[] = [];
  for (let i = 0; i + frame <= data.length; i += frame) {
    let s = 0;
    for (let j = i; j < i + frame; j++) s += data[j] * data[j];
    rms.push(Math.sqrt(s / frame));
  }
  if (!rms.length) return 0;
  rms.sort((a, b) => a - b);
  return rms[Math.min(rms.length - 1, Math.floor(rms.length * 0.9))];
}

export function trackGain(level: number): number {
  return level < QUIET ? 1 : Math.min(MAX_BOOST, Math.max(MIN_CUT, LOUD_TARGET / level));
}

const playable = (c: ClipMeta) => c.audioChannels > 0 && c.captureFps === null;

// Буфер прочитанного звука. Раньше каждый Play и каждый перескок курсора заново читали звук всех дорожек через
// ffmpeg — на внешнем диске с файлами 4K это секунда и больше на кусок. Куски лежат по сетке таймлинии, поэтому
// повторное прослушивание того же места берёт их из памяти; одинаковый кусок, заказанный дважды, читается один раз.
const cache = new Map<string, Float32Array>();
const inflight = new Map<string, Promise<Float32Array | null>>();
let cacheBytes = 0;
function cachedPiece(key: string, load: () => Promise<Float32Array | null>): Promise<Float32Array | null> {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // свежий — в конец очереди на вытеснение
    cache.set(key, hit);
    return Promise.resolve(hit);
  }
  let job = inflight.get(key);
  if (!job) {
    job = load()
      .catch(() => null)
      .then((data) => {
        inflight.delete(key);
        if (data && data.length) {
          cache.set(key, data);
          cacheBytes += data.byteLength;
          for (const [k, v] of cache) {
            if (cacheBytes <= CACHE_BYTES) break;
            cache.delete(k);
            cacheBytes -= v.byteLength;
          }
        }
        return data;
      });
    inflight.set(key, job);
  }
  return job;
}

// Сколько дорожек уже готово: пока не готовы все — звук не идёт, курсор ждёт; во время проигрывания — какие догружаются.
export interface SoundLoading {
  ready: number;
  total: number;
  playing: boolean;
}

export class PreviewAudio {
  private ctx: AudioContext | null = null;
  private master: AudioNode | null = null;
  private tracks = new Map<string, Track>();
  private pending: { cameraId: string; buffer: AudioBuffer; at: number }[] = [];
  private t0 = 0; // время таймлинии, с которого пошёл звук
  private c0 = 0; // время AudioContext в этот момент; 0 — ещё не пошёл
  private session = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private placements: Placement[] = [];
  private clips = new Map<string, ClipMeta>();
  private levels = new Map<string, number>(); // уровень громких мест дорожки — помнится между запусками
  private lagging = -1;
  running = false;
  onLoading: ((s: SoundLoading | null) => void) | null = null;

  // Где сейчас звук на таймлинии; null — первые куски ещё читаются.
  position(): number | null {
    if (!this.running || !this.ctx || this.c0 === 0) return null;
    return this.t0 + Math.max(0, this.ctx.currentTime - this.c0);
  }

  async start(at: number, cameras: Camera[], placements: Placement[], audible: (cameraId: string) => boolean): Promise<void> {
    this.stop();
    const session = ++this.session;
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: SR, latencyHint: 'interactive' });
      // Несколько микрофонов вместе громче каждого: ограничитель не даёт сумме хрипеть.
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      limiter.connect(this.ctx.destination);
      this.master = limiter;
    }
    // Пока звук запускается, курсор ждёт его. Нет устройства вывода или звук не запустился за полторы секунды —
    // проигрываем без звука: курсор идёт по обычным часам.
    this.running = true;
    this.c0 = 0;
    this.t0 = at;
    if (this.ctx.state !== 'running') await Promise.race([this.ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
    if (session !== this.session) return;
    if (this.ctx.state !== 'running') {
      this.running = false;
      return;
    }
    this.update(cameras, placements, audible);
    // Каждая дорожка читает с места курсора. Раньше дорожка, звучавшая в прошлый раз, продолжала с того места,
    // где остановилась: после перескока вперёд она догоняла курсор кусками и молчала, после перескока назад —
    // молчала до старого места. Отсюда «не все дорожки включаются сразу».
    const from = Math.floor(at / CHUNK) * CHUNK;
    for (const tr of this.tracks.values()) {
      tr.until = from;
      tr.ready = from;
      tr.busy = false;
    }
    const on = [...this.tracks.entries()].filter(([, tr]) => tr.on);
    let ready = 0;
    this.onLoading?.({ ready, total: on.length, playing: false });
    const first = on.map(([id, tr]) => this.fill(id, tr, session).then(() => {
      if (session === this.session) this.onLoading?.({ ready: ++ready, total: on.length, playing: false });
    }));
    await Promise.race([Promise.all(first), new Promise((r) => setTimeout(r, START_LIMIT * 1000))]);
    if (session !== this.session) return;
    this.lagging = -1;
    this.onLoading?.(null);
    this.c0 = this.ctx.currentTime + START_DELAY;
    for (const p of this.pending.splice(0)) this.place(p.cameraId, p.buffer, p.at);
    this.timer = setInterval(() => this.pump(session), 200);
  }

  stop(): void {
    this.session += 1;
    this.running = false;
    this.c0 = 0;
    this.pending = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onLoading?.(null);
    for (const tr of this.tracks.values()) {
      for (const s of tr.sources) {
        try {
          s.stop();
        } catch {
          // уже закончился
        }
      }
      tr.sources.clear();
      tr.busy = false;
    }
  }

  // Новые дорожки, раскладка, Mute и Solo — на ходу: выключенная дорожка смолкает сразу, включённая вступает
  // через долю секунды на своём месте.
  update(cameras: Camera[], placements: Placement[], audible: (cameraId: string) => boolean): void {
    this.placements = placements;
    this.clips = new Map(cameras.flatMap((c) => c.clips.map((k) => [k.id, k] as [string, ClipMeta])));
    if (!this.ctx || !this.master) return;
    const now = this.position() ?? this.t0;
    for (const cam of cameras) {
      let tr = this.tracks.get(cam.id);
      if (!tr) {
        const gain = this.ctx.createGain();
        gain.connect(this.master);
        tr = { gain, sources: new Set(), until: now, ready: now, busy: false, on: false };
        this.tracks.set(cam.id, tr);
      }
      const on = audible(cam.id);
      if (on && !tr.on) {
        tr.until = Math.floor((this.c0 ? now : this.t0) / CHUNK) * CHUNK;
        tr.ready = tr.until;
        tr.gain.gain.setValueAtTime(trackGain(this.levels.get(cam.id) ?? 0), this.ctx.currentTime);
      } else if (!on && tr.on) {
        for (const s of tr.sources) {
          try {
            s.stop();
          } catch {
            // уже закончился
          }
        }
        tr.sources.clear();
      }
      tr.on = on;
    }
  }

  private pump(session: number): void {
    if (session !== this.session) return;
    const pos = this.position();
    if (pos === null) return;
    let lagging = 0;
    for (const [id, tr] of this.tracks) {
      if (!tr.on) continue;
      if (!tr.busy && tr.until < pos + LEAD) void this.fill(id, tr, session);
      if (tr.ready < pos) lagging += 1;
    }
    // Дорожка не успела прочитать звук к месту курсора — показываем, что она догружается (вступит на своём месте).
    if (lagging !== this.lagging) {
      const total = [...this.tracks.values()].filter((t) => t.on).length;
      this.onLoading?.(lagging ? { ready: total - lagging, total, playing: true } : null);
      this.lagging = lagging;
    }
  }

  // Следующий кусок дорожки: все её клипы в окне [until, until + CHUNK).
  private async fill(cameraId: string, tr: Track, session: number): Promise<void> {
    tr.busy = true;
    const from = tr.until;
    const to = from + CHUNK;
    tr.until = to;
    const jobs = this.placements
      .filter((p) => p.cameraId === cameraId && p.end > from && p.start < to)
      .map(async (p) => {
        const clip = this.clips.get(p.clipId);
        if (!clip || !playable(clip)) return;
        const a = Math.max(0, from - p.start);
        const b = Math.min(p.end - p.start, to - p.start);
        if (b - a < 0.01) return;
        const key = `${clip.path}|${clip.audioStartSec ?? 0}|${a.toFixed(4)}|${(b - a).toFixed(4)}`;
        const data = await cachedPiece(key, () => api.previewAudio(clip.path, a, b - a, clip.audioStartSec ?? 0));
        if (!data || !data.length || session !== this.session || !this.ctx) return;
        this.level(cameraId, tr, loudLevel(data));
        const buffer = this.ctx.createBuffer(1, data.length, SR);
        buffer.getChannelData(0).set(data);
        if (this.c0 === 0) this.pending.push({ cameraId, buffer, at: p.start + a });
        else this.place(cameraId, buffer, p.start + a);
      });
    await Promise.all(jobs);
    if (session !== this.session) return;
    tr.busy = false;
    tr.ready = to;
  }

  // Дорожка громче, чем казалась, — убавляем; уровень только растёт, чтобы тихий кусок не задирал громкость.
  private level(cameraId: string, tr: Track, v: number): void {
    if (!this.ctx || v < QUIET || v <= (this.levels.get(cameraId) ?? 0)) return;
    this.levels.set(cameraId, v);
    tr.gain.gain.setTargetAtTime(trackGain(v), this.ctx.currentTime, 0.05);
  }

  private place(cameraId: string, buffer: AudioBuffer, at: number): void {
    const tr = this.tracks.get(cameraId);
    if (!this.ctx || !tr || !tr.on) return;
    const when = this.c0 + (at - this.t0);
    const now = this.ctx.currentTime;
    // Опоздавший кусок вступает с середины, но на своём месте.
    const late = Math.max(0, now + 0.01 - when);
    if (late >= buffer.duration) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(tr.gain);
    src.onended = () => tr.sources.delete(src);
    tr.sources.add(src);
    src.start(when + late, late);
  }
}

export const previewAudio = new PreviewAudio();
