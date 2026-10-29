import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeQr, parseQrPayload, qrPayload } from '../src/core/qrSync.ts';
import type { QrFrame } from '../src/core/qrSync.ts';

// Камера снимает экран: кадр k — в момент clipStart + k/fps по часам экрана. Кадры, где код сменился
// во время выдержки, не читаются.
function film(clipStart: number, fps: number, from: number, dur: number, shutter = 0.5 / fps): QrFrame[] {
  const out: QrFrame[] = [];
  for (let k = Math.round(from * fps); k < Math.round((from + dur) * fps); k++) {
    const t = k / fps;
    const a = Math.floor(clipStart + t);
    const b = Math.floor(clipStart + t + shutter);
    out.push({ t, code: a === b ? a * 1000 : null });
  }
  return out;
}

test('Код экрана читается и пишется одинаково', () => {
  assert.equal(parseQrPayload(qrPayload(1781276400000)), 1781276400000);
  assert.equal(parseQrPayload('https://example.com'), null);
});

test('По сменам кода начало клипа находится с точностью лучше половины кадра', () => {
  for (const fps of [25, 50, 30000 / 1001]) {
    for (const start of [1781276400.1234, 1781276412.987, 1781276455.5]) {
      const r = analyzeQr(film(start, fps, 2, 8), fps)!;
      assert.ok(r.transitions >= 7, `смен ${r.transitions}`);
      // Предел — четверть кадра: момент смены где-то между чистыми кадрами.
      assert.ok(Math.abs(r.clipStartEpoch - start) <= 0.25 / fps + 1e-6, `${fps} к/с: ошибка ${((r.clipStartEpoch - start) * 1000).toFixed(1)} мс`);
    }
  }
});

test('Пропущенные и смазанные кадры не сбивают', () => {
  const frames = film(1781276400.37, 25, 0, 6).map((f, i) => (i % 7 === 3 ? { ...f, code: null } : f));
  const r = analyzeQr(frames, 25)!;
  assert.ok(Math.abs(r.clipStartEpoch - 1781276400.37) < 0.02);
});

test('Снимали меньше секунды — оценка грубее, но есть', () => {
  const r = analyzeQr(film(1781276400.2, 25, 1.3, 0.4), 25)!;
  assert.equal(r.transitions, 0);
  assert.ok(Math.abs(r.clipStartEpoch - 1781276400.2) <= r.precisionSec + 1e-9);
});

test('Нет кода — нет результата', () => {
  assert.equal(analyzeQr([{ t: 0, code: null }, { t: 0.04, code: null }], 25), null);
});
