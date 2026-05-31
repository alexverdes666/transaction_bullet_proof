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
import type { AnvilFork } from './anvil.js';
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

/** Vyper lays its `HashMap` out with (slot, key) order, the reverse of Solidity. */
function vyperBalanceSlotKey(holder: Address, mappingSlot: bigint): Hash {
  return keccak256(
    encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [mappingSlot, holder]),
  );
}

/**
 * "Deal" `amount` of an ERC-20 to `holder` by overwriting the balance slot
 * directly on the fork (anvil_setStorageAt) — the same trick Foundry's `deal`
 * uses. This lets us fund the wallet with the pool's QUOTE token (WETH, USDC,
 * WBNB, …) so we can buy DIRECTLY from the token's real pair without owning any
 * of that token or knowing a router.
 *
 * The balance mapping's base slot isn't in the ABI, so we brute-force slots
 * 0..maxSlot under BOTH the Solidity and Vyper layouts: write a probe value, and
 * accept the first slot where `balanceOf(holder)` reflects it. On no match we
 * restore what we touched and return null (caller then abstains from the sim).
 */
export async function dealToken(
  fork: AnvilFork,
  client: PublicClient,
  token: Address,
  holder: Address,
  amount: bigint,
  maxSlot = 40,
): Promise<{ mappingSlot: bigint; storageKey: Hash; vyper: boolean } | null> {
  const value = pad(toHex(amount), { size: 32 });
  for (let slot = 0n; slot <= BigInt(maxSlot); slot++) {
    for (const vyper of [false, true]) {
      const key = vyper ? vyperBalanceSlotKey(holder, slot) : balanceSlotKey(holder, slot);
      const prev = (await client.getStorageAt({ address: token, slot: key })) ?? zeroSlot();
      await fork.setStorageAt(token, key, value);
      let ok = false;
      try {
        ok = (await balanceOf(client, token, holder)) === amount;
      } catch {
        ok = false;
      }
      if (ok) return { mappingSlot: slot, storageKey: key, vyper };
      // Not the slot — undo our probe write so we don't corrupt unrelated state.
      await fork.setStorageAt(token, key, prev);
    }
  }
  return null;
}
