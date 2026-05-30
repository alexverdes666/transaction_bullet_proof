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

export const scanSchema = z.object({
  token: addressSchema,
});

export const createOrderSchema = z.object({
  packId: z.string().min(1).max(40),
});
