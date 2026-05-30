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
}

/**
 * Build a {@link StateSnapshot}: native ETH balance, token balance, plus the
 * raw storage slot backing the token balance (when discoverable).
 */
export async function captureSnapshot(inputs: SnapshotInputs): Promise<StateSnapshot> {
  const { fork, client, wallet, token, label } = inputs;

  const evmSnapshotId = inputs.takeEvmSnapshot ? await fork.snapshot() : null;

  const meta = await readTokenMeta(client, token);

  // Also track WETH: the round-trip sell delivers proceeds as WETH, so including
  // it makes the balance diff tell the whole story (ETH out, WETH in, token net).
  const weth = config.dex.weth;
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
  const storage: StorageReading[] = [];
  const slot = await findBalanceSlot(client, token, wallet).catch(() => null);
  if (slot) {
    const value = (await client.getStorageAt({ address: token, slot: slot.storageKey })) as Hash;
    storage.push({
      account: token,
      slot: slot.storageKey,
      label: `${meta.symbol}.balanceOf(${wallet}) @ mapping slot ${slot.mappingSlot}`,
      value,
    });
  }

  return {
    label,
    blockNumber: await client.getBlockNumber(),
    evmSnapshotId,
    balances,
    storage,
    takenAt: Date.now(),
  };
}

/** Convenience accessor: native ETH from a snapshot. */
export function ethOf(s: StateSnapshot): bigint {
  return s.balances.find((b) => b.token === null)?.raw ?? 0n;
}

/** Convenience accessor: a token's raw balance from a snapshot. */
export function tokenOf(s: StateSnapshot, token: Address): bigint {
  return (
    s.balances.find((b) => b.token?.toLowerCase() === token.toLowerCase())?.raw ?? 0n
  );
}
