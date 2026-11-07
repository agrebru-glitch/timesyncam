// Звук предпросмотра. Все слышимые дорожки играют через один AudioContext: каждый кусок записи ставится
// на общие часы по месту клипа на таймлинии, с точностью до сэмпла. Так на слух слышно, совпали ли записи:
// разошедшиеся на 10–40 мс звучат эхом, на сотни миллисекунд — двоятся. Видео при этом идёт без звука:
// у плеера каждого окна свои часы, и они расходятся на десятки миллисекунд.
import type { Camera, ClipMeta, Placement } from '../core/types.ts';
import { api } from './api.ts';

const SR = 48000;
const CHUNK = 8; // секунд звука в одном куске
const LEAD = 3; // за столько секунд до конца запаса читается следующий кусок
const START_WAIT = 2.5; // столько ждём первые куски: что не успело, вступит позже, но на своём месте
const START_DELAY = 0.06; // запас на старт после того, как куски готовы

interface Track {
  gain: GainNode;
  sources: Set<AudioBufferSourceNode>;
  until: number; // до какого времени таймлинии звук дорожки уже прочитан
  busy: boolean;
  on: boolean;
}

const playable = (c: ClipMeta) => c.audioChannels > 0 && c.captureFps === null;

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
  running = false;

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
    const first = [...this.tracks.entries()].filter(([, tr]) => tr.on).map(([id, tr]) => this.fill(id, tr, session));
    await Promise.race([Promise.all(first), new Promise((r) => setTimeout(r, START_WAIT * 1000))]);
    if (session !== this.session) return;
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
        tr = { gain, sources: new Set(), until: now, busy: false, on: false };
        this.tracks.set(cam.id, tr);
      }
      const on = audible(cam.id);
      if (on && !tr.on) {
        tr.until = this.c0 ? now + 0.25 : this.t0;
        tr.gain.gain.setValueAtTime(1, this.ctx.currentTime);
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
    for (const [id, tr] of this.tracks) if (tr.on && !tr.busy && tr.until < pos + LEAD) void this.fill(id, tr, session);
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
        const data = await api.previewAudio(clip.path, a, b - a, clip.audioStartSec ?? 0).catch(() => null);
        if (!data || !data.length || session !== this.session || !this.ctx) return;
        const buffer = this.ctx.createBuffer(1, data.length, SR);
        buffer.getChannelData(0).set(data);
        if (this.c0 === 0) this.pending.push({ cameraId, buffer, at: p.start + a });
        else this.place(cameraId, buffer, p.start + a);
      });
    await Promise.all(jobs);
    if (session === this.session) tr.busy = false;
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
