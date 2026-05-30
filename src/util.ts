/** Small shared helpers. */

/** Recursively convert bigint -> string so a structure is JSON-safe. */
export function jsonSafe<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}

/** Pretty JSON with bigint support. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Format a raw integer amount using `decimals` into a human string. */
export function formatUnits(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${fracStr ? '.' + fracStr : ''}`;
}

/** Best-effort extraction of a human revert reason from a viem error. */
export function extractRevertReason(err: unknown): string {
  if (err == null) return 'unknown';
  const anyErr = err as Record<string, unknown>;
  const candidates = [
    anyErr['shortMessage'],
    (anyErr['cause'] as Record<string, unknown> | undefined)?.['shortMessage'],
    anyErr['details'],
    anyErr['message'],
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c.split('\n')[0]!.trim();
  }
  return String(err);
}
