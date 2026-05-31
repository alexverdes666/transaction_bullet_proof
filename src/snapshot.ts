/**
 * Captures an immutable picture of the wallet's value + the raw storage slots
 * we care about, so that a later snapshot can be diffed against it.
 */
import type { Address, Hash, PublicClient } from 'viem';
import type { AnvilFork } from './anvil.js';
import type { BalanceReading, StateSnapshot, StorageReading } from './types.js';
import { config } from './config.js';
import { balanceOf, findBalanceSlot, readTokenMeta } from './token.js';

export interface SnapshotInputs {
  fork: AnvilFork;
  client: PublicClient;
  wallet: Address;
  /** The token under investigation. */
  token: Address;
  label: string;
  /** Take a real EVM snapshot (so the fork can be reverted to here). */
  takeEvmSnapshot?: boolean;
  /**
   * PERF-1: a previously-discovered balance slot to reuse, so the (expensive)
   * brute-force discovery only runs once per scan. The mapping base slot is an
   * immutable property of the token contract, so the slot found for the BEFORE
   * snapshot is valid for the AFTER snapshot too — pass it in to skip the second
   * discovery pass entirely.
   */
  knownSlot?: { mappingSlot: bigint; storageKey: Hash } | null;
  /**
   * Wrapped-native token to also track (the round-trip sell delivers proceeds as
   * wrapped-native). Per-chain; defaults to the env Ethereum WETH when omitted.
   */
  weth?: Address;
}

/**
 * Build a {@link StateSnapshot}: native ETH balance, token balance, plus the
 * raw storage slot backing the token balance (when discoverable).
 */
export interface CaptureSnapshotResult {
  snapshot: StateSnapshot;
  /** The discovered (or reused) balance slot, so the caller can thread it into a
   *  later snapshot and avoid re-running discovery (PERF-1). Null when no slot
   *  could be confirmed (e.g. zero balance / proxy layout). */
  slot: { mappingSlot: bigint; storageKey: Hash } | null;
}

export async function captureSnapshot(inputs: SnapshotInputs): Promise<StateSnapshot> {
  return (await captureSnapshotEx(inputs)).snapshot;
}

/**
 * Like {@link captureSnapshot} but also returns the discovered balance slot so
 * the caller can reuse it for a subsequent snapshot (PERF-1).
 */
export async function captureSnapshotEx(inputs: SnapshotInputs): Promise<CaptureSnapshotResult> {
  const { fork, client, wallet, token, label } = inputs;

  const evmSnapshotId = inputs.takeEvmSnapshot ? await fork.snapshot() : null;

  const meta = await readTokenMeta(client, token);

  // Also track wrapped-native: the round-trip sell delivers proceeds as
  // wrapped-native, so including it makes the balance diff tell the whole story
  // (native out, wrapped-native in, token net). Per-chain; defaults to env WETH.
  const weth = inputs.weth ?? config.dex.weth;
  const trackWeth = weth.toLowerCase() !== token.toLowerCase();
  const [ethWei, tokenRaw, wethRaw] = await Promise.all([
    client.getBalance({ address: wallet }),
    balanceOf(client, token, wallet),
    trackWeth ? balanceOf(client, weth, wallet).catch(() => 0n) : Promise.resolve(0n),
  ]);

  const balances: BalanceReading[] = [
    { token: null, symbol: 'ETH', decimals: 18, raw: ethWei },
    { token, symbol: meta.symbol, decimals: meta.decimals, raw: tokenRaw },
  ];
  if (trackWeth) balances.push({ token: weth, symbol: 'WETH', decimals: 18, raw: wethRaw });

  // Raw storage watch: the wallet's slot in the token's balance mapping.
  // PERF-1: reuse a slot the caller already discovered (the mapping base slot is
  // immutable), only brute-forcing it when none was supplied.
  const storage: StorageReading[] = [];
  const slot =
    inputs.knownSlot !== undefined
      ? inputs.knownSlot
      : await findBalanceSlot(client, token, wallet).catch(() => null);
  if (slot) {
    // getStorageAt can return undefined (slot never written). Default to the zero
    // hash rather than casting `undefined as Hash`, which would otherwise diff as
    // a phantom change and trigger a false STORAGE_DELTA.
    const ZERO_HASH = ('0x' + '0'.repeat(64)) as Hash;
    const raw = await client.getStorageAt({ address: token, slot: slot.storageKey });
    const value: Hash = typeof raw === 'string' && raw.startsWith('0x') ? (raw as Hash) : ZERO_HASH;
    storage.push({
      account: token,
      slot: slot.storageKey,
      label: `${meta.symbol}.balanceOf(${wallet}) @ mapping slot ${slot.mappingSlot}`,
      value,
    });
  }

  return {
    snapshot: {
      label,
      blockNumber: await client.getBlockNumber(),
      evmSnapshotId,
      balances,
      storage,
      takenAt: Date.now(),
    },
    slot,
  };
}
