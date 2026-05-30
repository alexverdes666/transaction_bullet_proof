/**
 * Test-wallet preparation: fund with local ETH and optionally pre-approve the
 * target token to the router. Funding uses anvil's `anvil_setBalance` cheatcode
 * so we never depend on faucet liquidity.
 */
import { type Address, parseEther, type PublicClient, type WalletClient } from 'viem';
import type { AnvilFork } from './anvil.js';
import { config } from './config.js';
import { erc20Abi } from './abi.js';

const MAX_UINT = (1n << 256n) - 1n;

/** Give the wallet `FUND_ETH` worth of native ETH on the fork. */
export async function fundWallet(fork: AnvilFork, wallet: Address): Promise<bigint> {
  const wei = parseEther(String(config.wallet.fundEth));
  await fork.setBalance(wallet, wei);
  return wei;
}

/** Pre-approve the router to spend the target token (unlimited allowance). */
export async function preApprove(
  publicClient: PublicClient,
  walletClient: WalletClient,
  token: Address,
  spender: Address,
): Promise<void> {
  const hash = await walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, MAX_UINT],
    account: walletClient.account!,
    chain: walletClient.chain,
  });
  await publicClient.waitForTransactionReceipt({ hash });
}
