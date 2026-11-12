import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Camera, Placement } from '../src/core/types.ts';
import { camera, clip, T16 } from './fixtures.ts';

// Звук предпросмотра без настоящего звука: поддельный AudioContext записывает, куда и с какого места ставится
// каждый кусок. Проверяется главное — кусок клипа звучит в момент, когда курсор проходит его место на таймлинии.
interface Started { cameraId: string; clipPath: string; from: number; when: number; offset: number; duration: number }
const started: Started[] = [];
const requests: { path: string; start: number; dur: number }[] = [];
let now = 0;

class FakeParam { value = 0; setValueAtTime() {} }
class FakeNode { connect() {} }
class FakeCtx {
  state = 'running';
  sampleRate = 48000;
  destination = {};
  get currentTime() { return now; }
  async resume() {}
  createGain() { return Object.assign(new FakeNode(), { gain: new FakeParam() }); }
  createDynamicsCompressor() { return Object.assign(new FakeNode(), { threshold: new FakeParam(), knee: new FakeParam(), ratio: new FakeParam(), attack: new FakeParam(), release: new FakeParam() }); }
  createBuffer(_ch: number, len: number, sr: number) {
    // Метка куска едет вместе с данными: движок кладёт их в буфер через getChannelData(0).set(...).
    const b = { duration: len / sr, length: len, meta: null as null | { path: string; from: number }, getChannelData: () => ({ set: (d: Float32Array) => { b.meta = metaOf.get(d) ?? null; } }) };
    return b;
  }
  createBufferSource() {
    const src = {
      buffer: null as null | { duration: number; meta: { path: string; from: number } | null },
      onended: null as null | (() => void),
      connect() {},
      stop() { (src as { stopped?: boolean }).stopped = true; },
      start(when: number, offset: number) {
        started.push({ cameraId: '', clipPath: src.buffer!.meta!.path, from: src.buffer!.meta!.from, when, offset, duration: src.buffer!.duration });
      },
    };
    return src;
  }
}
const metaOf = new WeakMap<Float32Array, { path: string; from: number }>();
(globalThis as Record<string, unknown>).AudioContext = FakeCtx;
(globalThis as Record<string, unknown>).window = {
  api: {
    previewAudio: async (path: string, start: number, dur: number) => {
      requests.push({ path, start, dur });
      const d = new Float32Array(Math.round(dur * 48000));
      metaOf.set(d, { path, from: start });
      return d;
    },
  },
};

const { PreviewAudio, loudLevel, trackGain } = await import('../src/renderer/previewAudio.ts');

function scene(): { cams: Camera[]; placements: Placement[] } {
  const a1 = clip({ start: T16, durationSec: 10, recordedSec: 10 });
  const a2 = clip({ start: T16 + 10, durationSec: 15, recordedSec: 15 });
  const rec = clip({ start: T16 - 3, durationSec: 40, recordedSec: 40, hasVideo: false });
  a1.path = 'a1';
  a2.path = 'a2';
  rec.path = 'rec';
  const cams = [camera('A', [a1, a2]), camera('Звук', [rec])];
  const placements: Placement[] = [
    { clipId: a1.id, cameraId: 'A', start: 100, end: 110, method: 'timecode', lane: 0 },
    { clipId: a2.id, cameraId: 'A', start: 110, end: 125, method: 'timecode', lane: 0 },
    { clipId: rec.id, cameraId: 'Звук', start: 97.25, end: 137.25, method: 'clock', lane: 0 },
  ];
  return { cams, placements };
}

test('Звук предпросмотра: каждый кусок звучит, когда курсор проходит его место, куски одного клипа — встык', async () => {
  started.length = 0;
  requests.length = 0;
  now = 0;
  const { cams, placements } = scene();
  const p = new PreviewAudio();
  await p.start(105, cams, placements, () => true);
  // Курсор по часам звука: в момент c0 он в 105.
  const c0 = (p as unknown as { c0: number }).c0;
  assert.ok(Math.abs((p.position() ?? 0) - 105) < 0.1);
  // Прогоняем 20 секунд: подкачка по таймеру.
  for (let t = 0; t <= 20; t += 0.2) {
    now = t;
    (p as unknown as { pump: (s: number) => void }).pump((p as unknown as { session: number }).session);
    await new Promise((r) => setImmediate(r));
  }
  p.stop();
  // Место каждого куска: начало клипа на таймлинии + место куска в клипе.
  const startOf: Record<string, number> = { a1: 100, a2: 110, rec: 97.25 };
  for (const s of started) {
    const tl = startOf[s.clipPath] + s.from + s.offset;
    const expected = c0 + (tl - 105);
    assert.ok(Math.abs(s.when - expected) < 1e-9, `${s.clipPath}@${s.from}: ${s.when} вместо ${expected}`);
  }
  // Куски одного клипа идут встык: конец одного — начало следующего.
  for (const path of ['a2', 'rec']) {
    const list = started.filter((s) => s.clipPath === path).sort((x, y) => x.from - y.from);
    assert.ok(list.length >= 2, `${path}: кусков ${list.length}`);
    for (let i = 1; i < list.length; i++) assert.ok(Math.abs(list[i - 1].from + list[i - 1].duration - list[i].from) < 1 / 48000 + 1e-9, `${path}: зазор у ${list[i].from}`);
  }
  // Первый клип камеры начат с середины: куски — по сетке таймлинии в 8 с, курсор стоял в 105 — кусок с 104,
  // то есть с 4-й секунды клипа; звучать он начинает с 5-й (что раньше курсора — пропускается).
  assert.equal(requests.find((r) => r.path === 'a1')!.start, 4);
  assert.ok(started.filter((s) => s.clipPath === 'a1').every((s) => s.from + s.offset >= 5 - 0.1)); // до курсора — только запас на старт;
});

test('Звук предпросмотра: Mute и Solo на ходу — выключенная дорожка не читается, включённая вступает на своём месте', async () => {
  started.length = 0;
  requests.length = 0;
  now = 0;
  const { cams, placements } = scene();
  const p = new PreviewAudio();
  await p.start(105, cams, placements, (id) => id === 'A');
  assert.ok(!requests.some((r) => r.path === 'rec'), 'дорожка без звука не читается');
  now = 2;
  p.update(cams, placements, () => true);
  (p as unknown as { pump: (s: number) => void }).pump((p as unknown as { session: number }).session);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const rec = started.filter((s) => s.clipPath === 'rec');
  assert.ok(rec.length > 0, 'включённая дорожка вступила');
  // Вступает не раньше текущего момента и на своём месте.
  const c0 = (p as unknown as { c0: number }).c0;
  for (const s of rec) {
    assert.ok(s.when >= 2 - 1e-9);
    assert.ok(Math.abs(s.when - (c0 + (97.25 + s.from + s.offset - 105))) < 1e-9);
  }
  p.stop();
});

test('Звук предпросмотра: тихая дорожка поднимается к уровню громких мест, громкая — не задирается, хлопок уровень не меняет', () => {
  const tone = (amp: number, sec: number) => Float32Array.from({ length: Math.round(48000 * sec) }, (_, i) => amp * Math.sin(i / 7));
  // Рекордер на 16 дБ тише камеры: после выравнивания громкие места обеих звучат одинаково.
  const cam = loudLevel(tone(0.14, 4));
  const rec = loudLevel(tone(0.022, 4));
  assert.ok(Math.abs(cam * trackGain(cam) - rec * trackGain(rec)) < 1e-6);
  // Один хлопок в тихой записи: уровень по большинству, а не по пику.
  const clap = tone(0.022, 4);
  clap.fill(0.9, 48000, 48000 + 2400);
  assert.ok(Math.abs(loudLevel(clap) - rec) / rec < 0.05);
  // Тишина и шум ниже −60 дБ не поднимаются; подъём не больше +24 дБ.
  assert.equal(trackGain(loudLevel(new Float32Array(48000))), 1);
  assert.equal(trackGain(0.002), 16);
});

test('Звук предпросмотра: после перескока курсора каждая дорожка сразу читает звук у курсора, а не с прежнего места', async () => {
  const { cams, placements } = scene();
  const p = new PreviewAudio();
  const pump = () => (p as unknown as { pump: (s: number) => void }).pump((p as unknown as { session: number }).session);
  // Играем с 102 десять секунд — дорожки читают вперёд.
  started.length = 0;
  requests.length = 0;
  now = 0;
  await p.start(102, cams, placements, () => true);
  for (let t = 0; t <= 10; t += 0.2) {
    now = t;
    pump();
    await new Promise((r) => setImmediate(r));
  }
  // Перескок вперёд на 130 (клип a2 кончился, рекордер ещё звучит) и назад на 101.
  try {
  for (const at of [130, 101]) {
    started.length = 0;
    requests.length = 0;
    now += 1;
    await p.start(at, cams, placements, () => true);
    const c0 = Math.min(...started.map((s) => s.when)); // первый миг звука после старта
    // Обе дорожки, которым есть что сказать в момент at, вступают сразу — в первый же миг после старта.
    const sounding = (path: string) => started.some((s) => s.clipPath === path && Math.abs(s.when - c0) < 1e-6);
    if (at === 130) assert.ok(sounding('rec'), `рекордер молчит после перескока на ${at}: ${JSON.stringify(requests)}`);
    else {
      assert.ok(sounding('a1'), `камера молчит после перескока на ${at}: ${JSON.stringify(requests)}`);
      assert.ok(sounding('rec'), `рекордер молчит после перескока на ${at}: ${JSON.stringify(requests)}`);
    }
  }
  } finally {
    p.stop();
  }
});
