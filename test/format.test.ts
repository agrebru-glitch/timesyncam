import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDurationHuman, rulerTicks } from '../src/core/format.ts';

test('Длительность словами: округление не даёт «60 мин» и «60 с»', () => {
  assert.equal(formatDurationHuman(2 * 3600 + 59 * 60 + 50), '3 ч');
  assert.equal(formatDurationHuman(2 * 3600 + 13 * 60 + 10), '2 ч 13 мин');
  assert.equal(formatDurationHuman(59.6), '1 мин');
  assert.equal(formatDurationHuman(3599.7), '1 ч');
  assert.equal(formatDurationHuman(185), '3 мин 5 с');
  assert.equal(formatDurationHuman(-0.4), '0,4 с');
});

test('Линейка: при сильном приближении каждое пятое деление крупное до самого края', () => {
  const from = 1781266968.3;
  for (const step of [1, 2, 5]) {
    const ticks = rulerTicks(from, from + 400 * step, step, 180);
    assert.ok(ticks.length >= 2000);
    ticks.forEach((tick, i) => {
      const next = ticks[i + 5];
      if (next) assert.equal(next.major, tick.major);
    });
    assert.ok(Math.abs(ticks.filter((tick) => tick.major).length - ticks.length / 5) <= 1);
    for (const tick of ticks.filter((x) => x.major)) assert.ok(Math.abs((tick.t + 180 * 60) / step - Math.round((tick.t + 180 * 60) / step)) < 1e-5);
  }
});
