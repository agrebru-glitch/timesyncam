import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDurationHuman } from '../src/core/format.ts';

test('Длительность словами: округление не даёт «60 мин» и «60 с»', () => {
  assert.equal(formatDurationHuman(2 * 3600 + 59 * 60 + 50), '3 ч');
  assert.equal(formatDurationHuman(2 * 3600 + 13 * 60 + 10), '2 ч 13 мин');
  assert.equal(formatDurationHuman(59.6), '1 мин');
  assert.equal(formatDurationHuman(3599.7), '1 ч');
  assert.equal(formatDurationHuman(185), '3 мин 5 с');
  assert.equal(formatDurationHuman(-0.4), '0,4 с');
});
