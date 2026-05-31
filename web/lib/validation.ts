/** Zod input schemas. All untrusted input is parsed through these. */
import { z } from 'zod';
import { isAddress } from 'viem';

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

// Require a reasonably strong password without being hostile.
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

export const addressSchema = z
  .string()
  .trim()
  .refine((v) => isAddress(v), 'Invalid contract address');

/**
 * Chains the scan engine supports. MUST stay in sync with src/chains.ts (the
 * engine re-validates, so a drift just means a clean 400 here vs there). `key`
 * is what the API/worker expect; `name`/`native` drive the UI selector.
 */
export const SUPPORTED_CHAINS = [
  { key: 'ethereum', name: 'Ethereum', native: 'ETH' },
  { key: 'bsc', name: 'BNB Smart Chain', native: 'BNB' },
  { key: 'polygon', name: 'Polygon', native: 'POL' },
  { key: 'base', name: 'Base', native: 'ETH' },
  { key: 'arbitrum', name: 'Arbitrum One', native: 'ETH' },
  { key: 'avalanche', name: 'Avalanche C-Chain', native: 'AVAX' },
] as const;

export const CHAIN_KEYS = SUPPORTED_CHAINS.map((c) => c.key) as [string, ...string[]];

export const scanSchema = z.object({
  token: addressSchema,
  // Optional; defaults to ethereum engine-side. Constrained to supported keys.
  chain: z.enum(CHAIN_KEYS).optional(),
});

export const createOrderSchema = z.object({
  packId: z.string().min(1).max(40),
});
