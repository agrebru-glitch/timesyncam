import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer } from '../src/core/version.ts';

test('Новая версия: числа сравниваются по частям, пре-релизы и мусор новыми не считаются', () => {
  assert.ok(isNewer('v0.3.3', '0.3.2'));
  assert.ok(isNewer('0.4.0', '0.3.9'));
  assert.ok(isNewer('v0.10.0', '0.9.9'));
  assert.ok(isNewer('1.0.0', '0.99.99'));
  assert.equal(isNewer('v0.3.2', '0.3.2'), false);
  assert.equal(isNewer('v0.3.1', '0.3.2'), false);
  assert.equal(isNewer('v0.4.0-rc.1', '0.3.2'), false);
  assert.equal(isNewer('latest', '0.3.2'), false);
  assert.equal(isNewer('', '0.3.2'), false);
});
