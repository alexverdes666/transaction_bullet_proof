/**
 * Test-wallet preparation: fund with local ETH. Funding uses anvil's
 * `anvil_setBalance` cheatcode so we never depend on faucet liquidity.
 */
import { type Address, parseEther } from 'viem';
import type { AnvilFork } from './anvil.js';
import { config } from './config.js';

/** Give the wallet `FUND_ETH` worth of native ETH on the fork. */
export async function fundWallet(fork: AnvilFork, wallet: Address): Promise<bigint> {
  const wei = parseEther(String(config.wallet.fundEth));
  await fork.setBalance(wallet, wei);
  return wei;
}
