/**
 * ERC-20 metadata + low-level storage-slot discovery.
 *
 * The slot discovery is what makes the *raw* state diff possible: ERC-20
 * balances live in a `mapping(address => uint256)` whose storage location is
 * keccak256(abi.encode(holder, slot)). The mapping's base `slot` is not part of
 * the ABI, so we brute-force the first handful of slots and confirm a match
 * against the value returned by `balanceOf`. Once found, the diff engine can
 * watch that exact slot and catch balance mutations that bypass Transfer events
 * (a classic honeypot trick: silently rewriting balances in storage).
 */
import {
  type Address,
  type Hash,
  encodeAbiParameters,
  keccak256,
  pad,
  toHex,
  type PublicClient,
} from 'viem';
import { erc20Abi } from './abi.js';

export interface TokenMeta {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
}

export async function readTokenMeta(client: PublicClient, token: Address): Promise<TokenMeta> {
  const [name, symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: 'name' }).catch(() => 'UNKNOWN'),
    client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }).catch(() => '???'),
    client
      .readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })
      .catch(() => 18),
  ]);
  return { address: token, name: String(name), symbol: String(symbol), decimals: Number(decimals) };
}

export async function balanceOf(
  client: PublicClient,
  token: Address,
  holder: Address,
): Promise<bigint> {
  return (await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [holder],
  })) as bigint;
}

/** Compute the storage key for `balances[holder]` given the mapping base slot. */
export function balanceSlotKey(holder: Address, mappingSlot: bigint): Hash {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [holder, mappingSlot],
    ),
  );
}

/**
 * Brute-force the ERC-20 balance mapping slot by reading raw storage and
 * comparing against `balanceOf`. Returns null if no slot in range matches
 * (e.g. proxy/diamond layouts) — the diff engine then falls back to balanceOf.
 */
export async function findBalanceSlot(
  client: PublicClient,
  token: Address,
  holder: Address,
  maxSlot = 30,
): Promise<{ mappingSlot: bigint; storageKey: Hash } | null> {
  const actual = await balanceOf(client, token, holder);
  // A zero balance can't disambiguate slots, so we can only confirm a slot when
  // the holder actually holds a non-zero, distinctive amount.
  if (actual === 0n) return null;

  // PERF-1: the candidate slots are independent reads against a *local* fork, so
  // fire all of them at once instead of serially (was up to 31 round-trips in
  // series). Pick the lowest-indexed slot whose raw value matches `balanceOf`,
  // preserving the original first-match ordering / return contract.
  const slots = Array.from({ length: maxSlot + 1 }, (_, i) => BigInt(i));
  const reads = await Promise.all(
    slots.map(async (slot) => {
      const key = balanceSlotKey(holder, slot);
      const raw = await client.getStorageAt({ address: token, slot: key });
      return { slot, key, raw };
    }),
  );
  for (const { slot, key, raw } of reads) {
    if (raw && BigInt(raw) === actual) {
      return { mappingSlot: slot, storageKey: key };
    }
  }
  return null;
}

export function zeroSlot(): Hash {
  return pad(toHex(0n), { size: 32 });
}
