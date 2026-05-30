/** Password hashing with Node's built-in scrypt + per-user random salt. */
import 'server-only';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password.normalize('NFKC'), salt, KEYLEN)) as Buffer;
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = (await scryptAsync(password.normalize('NFKC'), salt, KEYLEN)) as Buffer;
  // Constant-time comparison to avoid leaking timing information.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
