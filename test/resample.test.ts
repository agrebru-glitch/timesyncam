import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stretch, Stretcher } from '../src/core/resample.ts';

const SR = 48000;
// Музыкоподобный сигнал: несколько тонов и щелчки — по ним точно видно время.
function signal(sec: number, seed = 1): Float32Array {
  const n = Math.round(sec * SR);
  const x = new Float32Array(n);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) x[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / SR) + 0.1 * Math.sin((2 * Math.PI * 1830 * i) / SR) + 0.02 * (rnd() * 2 - 1);
  for (let t = 0.3; t < sec; t += 0.37 + rnd() * 0.2) {
    const i0 = Math.round(t * SR);
    for (let k = 0; k < 200 && i0 + k < n; k++) x[i0 + k] += 0.6 * Math.exp(-k / 40) * (rnd() * 2 - 1);
  }
  return x;
}

test('Растяжение на сотни миллионных: каждый момент u исходника — в момент u·r копии, до тысячных отсчёта', () => {
  // Растяжение линейно: щелчки проверяем отдельно от музыки — центр тяжести каждого в копии ровно в u·r.
  const x = new Float32Array(30 * SR);
  const clicks = [0.5, 7.25, 18.1, 29.3].map((s) => Math.round(s * SR));
  for (const i of clicks) x[i] = 1;
  for (const ppm of [265, -120, 40]) {
    const r = 1 + ppm * 1e-6;
    const y = stretch(x, 1, r);
    assert.equal(y.length, Stretcher.outputFrames(x.length, r));
    for (const i of clicks) {
      const at = i * r;
      let s = 0;
      let w = 0;
      for (let k = Math.round(at) - 30; k <= Math.round(at) + 30; k++) {
        s += k * y[k];
        w += y[k];
      }
      assert.ok(Math.abs(s / w - at) < 0.01, `${ppm} ppm, отсчёт ${i}: ${(s / w).toFixed(3)} против ${at.toFixed(3)}`);
    }
  }
});

test('Растяжение по кускам даёт то же, что целиком, и не меняет громкость', () => {
  const mono = signal(6);
  const x = new Float32Array(mono.length * 2); // два канала: второй — зеркало первого
  mono.forEach((v, i) => {
    x[2 * i] = v;
    x[2 * i + 1] = -v;
  });
  const r = 1 + 180e-6;
  const whole = stretch(x, 2, r);
  const s = new Stretcher(2, r);
  const parts: Float32Array[] = [];
  for (let i = 0; i < x.length; i += 2 * 7919) parts.push(s.push(x.subarray(i, Math.min(x.length, i + 2 * 7919))));
  parts.push(s.finish(x.length / 2));
  const joined = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    joined.set(p, o);
    o += p.length;
  }
  assert.equal(joined.length, whole.length);
  let diff = 0;
  for (let i = 0; i < whole.length; i++) diff = Math.max(diff, Math.abs(joined[i] - whole[i]));
  assert.ok(diff < 1e-6, `${diff}`);
  const rms = (v: Float32Array) => Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length);
  assert.ok(Math.abs(rms(whole) / rms(x) - 1) < 0.002);
  // Каналы не перепутаны: второй — зеркало первого.
  for (let i = 1000; i < 1100; i += 2) assert.ok(Math.abs(whole[i] + whole[i + 1]) < 1e-5);
});
