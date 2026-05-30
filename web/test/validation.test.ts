import { describe, it, expect } from 'vitest';
import { registerSchema, loginSchema, scanSchema, createOrderSchema } from '@/lib/validation';

describe('registerSchema', () => {
  it('accepts a valid email + strong password', () => {
    const r = registerSchema.parse({ email: 'User@Example.com', password: 'longenough1' });
    expect(r.email).toBe('user@example.com'); // normalised lowercase
  });
  it('rejects invalid email', () => {
    expect(() => registerSchema.parse({ email: 'nope', password: 'longenough1' })).toThrow();
  });
  it('rejects short password (<10)', () => {
    expect(() => registerSchema.parse({ email: 'a@b.com', password: 'short' })).toThrow();
  });
});

describe('loginSchema', () => {
  it('accepts any non-empty password', () => {
    expect(() => loginSchema.parse({ email: 'a@b.com', password: 'x' })).not.toThrow();
  });
});

describe('scanSchema', () => {
  it('accepts a valid checksummed address', () => {
    const r = scanSchema.parse({ token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' });
    expect(r.token).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
  it('rejects a non-address', () => {
    expect(() => scanSchema.parse({ token: '0x1234' })).toThrow();
    expect(() => scanSchema.parse({ token: 'not-an-address' })).toThrow();
  });
});

describe('createOrderSchema', () => {
  it('requires a packId string', () => {
    expect(() => createOrderSchema.parse({ packId: 'starter' })).not.toThrow();
    expect(() => createOrderSchema.parse({})).toThrow();
  });
});
