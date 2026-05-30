import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, diffBalances, diffStorage } from '../src/statediff.js';
import type { RoundTripResult, StateSnapshot } from '../src/types.js';

const TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

function rt(over: Partial<RoundTripResult>): RoundTripResult {
  return {
    token: TOKEN,
    tokenSymbol: 'TKN',
    tokenDecimals: 18,
    canBuy: true,
    canSell: true,
    ethSpent: 10n ** 18n,
    tokensReceived: 1000n,
    tokensExpected: 1000n,
    tokensSold: 1000n,
    ethReceived: 994n * 10n ** 15n,
    ethExpected: 994n * 10n ** 15n,
    buyTax: 0,
    sellTax: 0,
    roundTripLoss: 0.006,
    buyGasUsed: 100000n,
    sellGasUsed: 120000n,
    buyTxHash: null,
    sellTxHash: null,
    revertReason: null,
    ...over,
  };
}

const codes = (r: ReturnType<typeof analyze>) => r.anomalies.map((a) => a.code);

test('null round-trip => ERROR verdict', () => {
  const r = analyze(null, []);
  assert.equal(r.verdict, 'ERROR');
});

test('clean token => SAFE, risk 0', () => {
  const r = analyze(rt({}), []);
  assert.equal(r.verdict, 'SAFE');
  assert.equal(r.riskScore, 0);
});

test('buyable but not sellable => HONEYPOT via SELL_REVERTED', () => {
  const r = analyze(rt({ canSell: false, revertReason: 'sell reverted', sellTax: -1, roundTripLoss: -1, ethReceived: 0n }), []);
  assert.ok(codes(r).includes('SELL_REVERTED'));
  assert.equal(r.verdict, 'HONEYPOT');
  assert.ok(r.riskScore >= 70);
});

test('buy delivers zero tokens => ZERO_TOKENS critical', () => {
  const r = analyze(rt({ tokensReceived: 0n }), []);
  assert.ok(codes(r).includes('ZERO_TOKENS'));
  assert.equal(r.verdict, 'HONEYPOT');
});

test('not buyable => NO_LIQUIDITY warning', () => {
  const r = analyze(rt({ canBuy: false, canSell: false, tokensReceived: 0n, sellTax: -1, roundTripLoss: -1 }), []);
  assert.ok(codes(r).includes('NO_LIQUIDITY'));
});

test('high sell tax flagged and scored as dangerous', () => {
  const r = analyze(rt({ sellTax: 0.6, roundTripLoss: 0.6, ethReceived: 4n * 10n ** 17n }), []);
  assert.ok(codes(r).includes('HIGH_SELL_TAX'));
  assert.ok(r.riskScore >= 70);
  assert.equal(r.verdict, 'HONEYPOT');
});

test('moderate sell tax => SUSPICIOUS', () => {
  const r = analyze(rt({ sellTax: 0.12, roundTripLoss: 0.12 }), []);
  assert.ok(codes(r).includes('ELEVATED_SELL_TAX'));
  assert.equal(r.verdict, 'SUSPICIOUS');
});

// ---- diffBalances -------------------------------------------------------
function snap(balances: StateSnapshot['balances'], storage: StateSnapshot['storage'] = []): StateSnapshot {
  return { label: 'x', blockNumber: 1n, evmSnapshotId: null, balances, storage, takenAt: 0 };
}

test('diffBalances computes per-asset deltas', () => {
  const before = snap([
    { token: null, symbol: 'ETH', decimals: 18, raw: 100n },
    { token: TOKEN, symbol: 'TKN', decimals: 18, raw: 0n },
  ]);
  const after = snap([
    { token: null, symbol: 'ETH', decimals: 18, raw: 90n },
    { token: TOKEN, symbol: 'TKN', decimals: 18, raw: 50n },
  ]);
  const diff = diffBalances(before, after);
  const eth = diff.find((d) => d.token === null)!;
  const tkn = diff.find((d) => d.token === TOKEN)!;
  assert.equal(eth.delta, -10n);
  assert.equal(tkn.delta, 50n);
});

// ---- diffStorage --------------------------------------------------------
test('diffStorage detects changed slots only', () => {
  const slot = '0x' + 'a'.repeat(64);
  const before = snap([], [{ account: TOKEN, slot: slot as `0x${string}`, label: 'bal', value: ('0x' + '0'.repeat(64)) as `0x${string}` }]);
  const after = snap([], [{ account: TOKEN, slot: slot as `0x${string}`, label: 'bal', value: ('0x' + '0'.repeat(63) + '5') as `0x${string}` }]);
  const diff = diffStorage(before, after);
  assert.equal(diff.length, 1);
  assert.equal(diff[0]!.account, TOKEN);
});
