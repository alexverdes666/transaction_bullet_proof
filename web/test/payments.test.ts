import { describe, it, expect } from 'vitest';
import { CREDIT_PACKS, getPack, baseUnits } from '@/lib/payments';

describe('credit packs', () => {
  it('every pack has positive credits and price and a unique id', () => {
    const ids = new Set<string>();
    for (const p of CREDIT_PACKS) {
      expect(p.credits).toBeGreaterThan(0);
      expect(p.priceTokens).toBeGreaterThan(0);
      expect(ids.has(p.id)).toBe(false);
      ids.add(p.id);
    }
  });

  it('getPack returns a known pack and undefined otherwise', () => {
    expect(getPack('starter')?.credits).toBe(10);
    expect(getPack('does-not-exist')).toBeUndefined();
  });

  it('baseUnits converts whole tokens to 6-decimal base units (test env)', () => {
    // vitest.config sets USDC-style 6 decimals via defaults.
    // (BigInt() ctor rather than `n` literals to match the ES2017 tsc target.)
    expect(baseUnits(5)).toBe(BigInt(5000000));
    expect(baseUnits(20)).toBe(BigInt(20000000));
  });
});
