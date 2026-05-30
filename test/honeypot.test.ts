import test from 'node:test';
import assert from 'node:assert/strict';
import { ratioBig, taxFromRatio } from '../src/honeypot.js';

test('ratioBig: undeterminable when expected is zero/negative', () => {
  assert.equal(ratioBig(5n, 0n), -1);
  assert.equal(ratioBig(5n, -1n), -1);
});

test('ratioBig: exact halves and wholes', () => {
  assert.equal(ratioBig(1n, 2n), 0.5);
  assert.equal(ratioBig(1n, 1n), 1);
  assert.equal(ratioBig(3n, 4n), 0.75);
});

test('ratioBig: keeps precision on 18-decimal-scale bigints', () => {
  // 0.9 ratio expressed with values far beyond Number's 2^53 safe-integer range.
  // Number(received)/Number(expected) would round both operands first and can
  // drift; fixed-point bigint division does not.
  const expected = 1_000_000_000_000_000_000_000_000n; // 1e24
  const received = 900_000_000_000_000_000_000_000n; //   9e23
  assert.equal(ratioBig(received, expected), 0.9);
});

test('ratioBig: detects a tiny shortfall hidden in huge magnitudes', () => {
  // A 0.1% skim on a 1e24 quantity. The absolute gap (1e21) is itself larger
  // than Number.MAX_SAFE_INTEGER, so naive Number() math could lose it entirely.
  const expected = 1_000_000_000_000_000_000_000_000n; // 1e24
  const received = 999_000_000_000_000_000_000_000n; // 0.999e24
  const r = ratioBig(received, expected);
  assert.ok(r < 1, 'ratio must register below 1');
  assert.ok(Math.abs(r - 0.999) < 1e-6, `expected ~0.999, got ${r}`);
});

test('taxFromRatio: tax is 1 - ratio, clamped to [0,1]', () => {
  // 1 - 0.9 carries the usual IEEE-754 representation error, so compare approximately.
  assert.ok(Math.abs(taxFromRatio(900n, 1000n) - 0.1) < 1e-9); // 10% tax
  assert.equal(taxFromRatio(1000n, 1000n), 0); // no tax
  assert.equal(taxFromRatio(0n, 1000n), 1); // 100% tax (clamped)
  assert.equal(taxFromRatio(1n, 0n), -1); // undeterminable
});

test('taxFromRatio: never reports negative tax when received exceeds expected', () => {
  // Price-impact / rounding can in principle deliver slightly more than quoted;
  // clamp01 keeps the tax at 0 rather than a nonsensical negative number.
  assert.equal(taxFromRatio(1100n, 1000n), 0);
});
