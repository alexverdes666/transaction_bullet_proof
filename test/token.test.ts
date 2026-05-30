import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balanceSlotKey, zeroSlot } from '../src/token.js';

const HOLDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

test('balanceSlotKey is a 32-byte hex hash', () => {
  const key = balanceSlotKey(HOLDER, 0n);
  assert.match(key, /^0x[0-9a-f]{64}$/);
});

test('balanceSlotKey is deterministic for same inputs', () => {
  assert.equal(balanceSlotKey(HOLDER, 9n), balanceSlotKey(HOLDER, 9n));
});

test('balanceSlotKey differs across mapping slots and holders', () => {
  assert.notEqual(balanceSlotKey(HOLDER, 0n), balanceSlotKey(HOLDER, 1n));
  assert.notEqual(
    balanceSlotKey(HOLDER, 0n),
    balanceSlotKey('0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 0n),
  );
});

test('zeroSlot is 32 zero bytes', () => {
  assert.equal(zeroSlot(), '0x' + '0'.repeat(64));
});
