/**
 * viem client factory bound to the local fork.
 *
 * The wallet client uses the deterministic anvil dev account, which the fork
 * has the private key for, so transactions are signed locally and submitted to
 * the fork like any real EOA would.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config, rpcUrl } from './config.js';

/** A viem chain definition for our local fork (id mirrors the forked chain). */
export const forkChain = defineChain({
  id: config.fork.chainId,
  name: 'anvil-fork',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl()] } },
});

export const testAccount = privateKeyToAccount(config.wallet.privateKey);

export function makePublicClient(): PublicClient {
  return createPublicClient({ chain: forkChain, transport: http(rpcUrl()) });
}

export function makeWalletClient(): WalletClient {
  return createWalletClient({ account: testAccount, chain: forkChain, transport: http(rpcUrl()) });
}
