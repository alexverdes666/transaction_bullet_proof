/**
 * viem client factory bound to a specific local fork endpoint.
 *
 * Clients are created PER FORK (not as module singletons) so that multiple
 * isolated forks — e.g. concurrent scans on the worker, each on its own
 * ephemeral port — never share a transport or accidentally talk to the wrong
 * fork. The wallet client uses the deterministic anvil dev account, whose key
 * every fork holds, so transactions are signed locally and submitted like any
 * real EOA would.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from './config.js';

/** The deterministic anvil dev account (its private key is baked into every fork). */
export const testAccount = privateKeyToAccount(config.wallet.privateKey);

/**
 * Build a viem chain definition for a fork reachable at `endpoint`.
 *
 * `chainId`/`nativeSymbol` must match the forked chain (and anvil's --chain-id)
 * so EIP-155 tx signing is accepted by the fork and `block.chainid` reads
 * correctly for any contract that checks it. Defaults to the env Ethereum config.
 */
export function makeForkChain(
  endpoint: string,
  chainId: number = config.fork.chainId,
  nativeSymbol = 'ETH',
): Chain {
  return defineChain({
    id: chainId,
    name: 'anvil-fork',
    nativeCurrency: { name: nativeSymbol, symbol: nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [endpoint] } },
  });
}

export function makePublicClient(
  endpoint: string,
  chainId?: number,
  nativeSymbol?: string,
): PublicClient {
  return createPublicClient({
    chain: makeForkChain(endpoint, chainId, nativeSymbol),
    transport: http(endpoint),
  });
}

export function makeWalletClient(
  endpoint: string,
  chainId?: number,
  nativeSymbol?: string,
): WalletClient {
  return createWalletClient({
    account: testAccount,
    chain: makeForkChain(endpoint, chainId, nativeSymbol),
    transport: http(endpoint),
  });
}
