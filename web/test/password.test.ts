import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '@/lib/password';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('wrong password', stored)).toBe(false);
  });

  it('stores salt:hash and is not plaintext', async () => {
    const stored = await hashPassword('hunter2hunter2');
    expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(stored).not.toContain('hunter2');
  });

  it('uses a random salt (two hashes of same password differ)', async () => {
    const a = await hashPassword('samePassword123');
    const b = await hashPassword('samePassword123');
    expect(a).not.toBe(b);
  });

  it('handles malformed stored hash gracefully', async () => {
    expect(await verifyPassword('x', 'not-a-valid-hash')).toBe(false);
  });
});
