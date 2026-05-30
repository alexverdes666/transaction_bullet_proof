import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUnits, jsonSafe, toJson, extractRevertReason } from '../src/util.js';

test('formatUnits: whole numbers', () => {
  assert.equal(formatUnits(1_000_000n, 6), '1');
  assert.equal(formatUnits(0n, 18), '0');
  assert.equal(formatUnits(10n ** 18n, 18), '1');
});

test('formatUnits: fractional + trailing-zero trim', () => {
  assert.equal(formatUnits(994010324197193079n, 18), '0.994010324197193079');
  assert.equal(formatUnits(1_500_000n, 6), '1.5');
  assert.equal(formatUnits(2_007_772_408n, 6), '2007.772408');
});

test('formatUnits: negative', () => {
  assert.equal(formatUnits(-1_000_000n, 6), '-1');
});

test('jsonSafe converts bigint to string recursively', () => {
  const out = jsonSafe({ a: 1n, b: { c: [2n, 3n] }, d: 'x' }) as Record<string, unknown>;
  assert.equal(out.a, '1');
  assert.deepEqual((out.b as Record<string, unknown>).c, ['2', '3']);
  assert.equal(out.d, 'x');
});

test('toJson serialises bigint without throwing', () => {
  const s = toJson({ v: 42n });
  assert.equal(s.includes('"42"'), true);
});

test('extractRevertReason pulls shortMessage / message', () => {
  assert.equal(extractRevertReason({ shortMessage: 'execution reverted' }), 'execution reverted');
  assert.equal(extractRevertReason(new Error('boom\nsecond line')), 'boom');
  assert.equal(extractRevertReason(null), 'unknown');
});
