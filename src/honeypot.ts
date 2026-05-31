/**
 * On-chain round-trip simulation — the deterministic core of honeypot detection.
 *
 * On an isolated fork we, as a fresh retail wallet:
 *   1. Quote the buy (router.getAmountsOut) to know what an HONEST pool returns.
 *   2. BUY: swap ETH -> token via the fee-on-transfer-tolerant router method,
 *      measuring tokens actually delivered (the gap vs the quote = buy tax).
 *   3. APPROVE the router to move our tokens.
 *   4. Quote the sell, then SELL the full balance back to ETH.
 *      - If the sell reverts: the token is buyable but not sellable -> honeypot.
 *      - If it returns far less ETH than quoted: hidden/asymmetric sell tax.
 *
 * Everything runs against fork state we control, with `amountOutMin = 0`, so the
 * only thing that can make a swap fail is the token's own logic — exactly what
 * we want to expose. No real funds, no real network, fully reversible.
 */
import {
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
  maxUint256,
  parseEther,
} from 'viem';
import { erc20Abi, routerAbi } from './abi.js';
import { balanceOf, readTokenMeta } from './token.js';
import { extractRevertReason, sleep } from './util.js';
import type { RoundTripResult } from './types.js';

/** How many times to attempt a swap before trusting a revert as real. */
const TX_ATTEMPTS = 3;

/** Fixed-point scale for bigint ratio math (6 decimal places of precision). */
const RATIO_SCALE = 1_000_000n;

/**
 * Compute `received / expected` as a clamped fraction without losing precision.
 *
 * `Number(bigint)/Number(bigint)` silently rounds 18-decimal / very large
 * quantities (a token could exploit this rounding to mask a tax). We instead do
 * the division in fixed-point bigint, then convert the small scaled integer —
 * which IS exactly representable as a double — back to a fraction.
 */
export function ratioBig(received: bigint, expected: bigint): number {
  if (expected <= 0n) return -1;
  const scaled = (received * RATIO_SCALE) / expected; // floor division in bigint
  return Number(scaled) / Number(RATIO_SCALE);
}

/** A tax/loss is `1 - ratio`, clamped to [0, 1]; -1 when undeterminable. */
export function taxFromRatio(received: bigint, expected: bigint): number {
  const ratio = ratioBig(received, expected);
  if (ratio < 0) return -1;
  return clamp01(1 - ratio);
}

type TxResult =
  | { ok: true; hash: Hash; gasUsed: bigint }
  | { ok: false; reason: string };

/**
 * Send a transaction, retrying on failure.
 *
 * This is the key to NOT producing false honeypot verdicts: a reverted tx makes
 * no state change (the tokens stay in the wallet), so we can safely re-attempt.
 * A genuine honeypot reverts on EVERY attempt; a transient upstream-RPC hiccup
 * (anvil lazily fetching fork state mid-call) only fails intermittently. So we
 * treat a swap as failed only if it reverts on all {@link TX_ATTEMPTS} tries.
 */
async function sendTxWithRetry(
  publicClient: PublicClient,
  send: () => Promise<Hash>,
  attempts = TX_ATTEMPTS,
): Promise<TxResult> {
  let reason = 'unknown';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const hash = await send();
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === 'success') return { ok: true, hash, gasUsed: receipt.gasUsed };
      reason = 'transaction reverted on-chain';
    } catch (err) {
      reason = extractRevertReason(err);
    }
    if (attempt < attempts) await sleep(400 * attempt); // linear backoff
  }
  return { ok: false, reason };
}

interface RoundTripInputs {
  publicClient: PublicClient;
  walletClient: WalletClient;
  wallet: Address;
  token: Address;
  /** ETH to spend on the buy (in ETH units). */
  buyEth: number;
  /** Uniswap-V2-style router for this chain. */
  router: Address;
  /** Wrapped-native token for this chain (WETH/WBNB/…). */
  weth: Address;
}

/** A far-future deadline so swaps never fail on the timestamp check. */
function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 3600);
}

export async function simulateRoundTrip(inputs: RoundTripInputs): Promise<RoundTripResult> {
  const { publicClient, walletClient, wallet, token, buyEth, router, weth } = inputs;
  const meta = await readTokenMeta(publicClient, token);

  const result: RoundTripResult = {
    token,
    tokenSymbol: meta.symbol,
    tokenDecimals: meta.decimals,
    canBuy: false,
    canSell: false,
    ethSpent: 0n,
    tokensReceived: 0n,
    tokensExpected: 0n,
    tokensSold: 0n,
    ethReceived: 0n,
    ethExpected: 0n,
    buyTax: -1,
    sellTax: -1,
    roundTripLoss: -1,
    buyGasUsed: null,
    sellGasUsed: null,
    buyTxHash: null,
    sellTxHash: null,
    revertReason: null,
  };

  const buyWei = parseEther(String(buyEth));
  const buyPath = [weth, token] as const;

  // --- 1. Honest buy quote ---------------------------------------------------
  try {
    const amounts = (await publicClient.readContract({
      address: router,
      abi: routerAbi,
      functionName: 'getAmountsOut',
      args: [buyWei, [...buyPath]],
    })) as bigint[];
    result.tokensExpected = amounts[amounts.length - 1] ?? 0n;
  } catch (err) {
    // No quotable V2 path. The buy below will confirm whether routing is possible.
    // Surface it (not silent): a missing buy quote means buyTax can't be measured.
    console.warn(`[honeypot] buy quote (getAmountsOut) failed: ${extractRevertReason(err)}`);
    result.tokensExpected = 0n;
  }

  // --- 2. BUY ETH -> token ---------------------------------------------------
  const tokenBefore = await balanceOf(publicClient, token, wallet);
  const buy = await sendTxWithRetry(publicClient, () =>
    walletClient.writeContract({
      address: router,
      abi: routerAbi,
      functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
      args: [0n, [...buyPath], wallet, deadline()],
      value: buyWei,
      account: walletClient.account!,
      chain: walletClient.chain,
    }),
  );
  if (!buy.ok) {
    result.revertReason = `buy failed: ${buy.reason}`;
    return finalize(result);
  }
  result.buyTxHash = buy.hash;
  result.buyGasUsed = buy.gasUsed;

  const tokenAfterBuy = await balanceOf(publicClient, token, wallet);
  result.tokensReceived = tokenAfterBuy - tokenBefore;
  result.ethSpent = buyWei;
  result.canBuy = true;

  // Effective buy tax: how far short of the honest quote did we land?
  if (result.tokensExpected > 0n) {
    result.buyTax = taxFromRatio(result.tokensReceived, result.tokensExpected);
  }

  // A buy that yields nothing is already a hard fail — nothing to sell.
  if (result.tokensReceived === 0n) {
    result.revertReason = 'buy delivered zero tokens';
    return finalize(result);
  }

  // --- 3. APPROVE router to spend the tokens ---------------------------------
  const approve = await sendTxWithRetry(publicClient, () =>
    walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [router, maxUint256],
      account: walletClient.account!,
      chain: walletClient.chain,
    }),
  );
  if (!approve.ok) {
    // Some honeypots even block approval. Treat as un-sellable.
    result.revertReason = `approve failed: ${approve.reason}`;
    return finalize(result);
  }

  // --- 4a. Honest sell quote -------------------------------------------------
  const sellPath = [token, weth] as const;
  const tokensToSell = result.tokensReceived;
  try {
    const amounts = (await publicClient.readContract({
      address: router,
      abi: routerAbi,
      functionName: 'getAmountsOut',
      args: [tokensToSell, [...sellPath]],
    })) as bigint[];
    result.ethExpected = amounts[amounts.length - 1] ?? 0n;
  } catch (err) {
    // Sell quote unavailable. The sell below still runs; but with no honest
    // baseline, sellTax stays -1 and statediff falls back to ROUNDTRIP_LOSS +
    // a SELL_TAX_UNKNOWN warning. Surface it rather than swallowing silently.
    console.warn(`[honeypot] sell quote (getAmountsOut) failed: ${extractRevertReason(err)}`);
    result.ethExpected = 0n;
  }

  // --- 4b. SELL token -> WETH ------------------------------------------------
  // We deliberately swap to WETH (an ERC-20) instead of unwrapping to native
  // ETH. WETH is 1:1 with ETH, so `wethReceived` is the exact economic output,
  // but measuring an ERC-20 balance is immune to gas-accounting noise AND to
  // WETH9.withdraw()'s `.transfer` stipend reverting on a fork.
  const wethBefore = await balanceOf(publicClient, weth, wallet);
  const sell = await sendTxWithRetry(publicClient, () =>
    walletClient.writeContract({
      address: router,
      abi: routerAbi,
      functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
      args: [tokensToSell, 0n, [...sellPath], wallet, deadline()],
      account: walletClient.account!,
      chain: walletClient.chain,
    }),
  );
  if (!sell.ok) {
    // Reverted on every attempt -> the token genuinely blocks exits (honeypot),
    // not a transient RPC blip.
    result.revertReason = `sell reverted on all ${TX_ATTEMPTS} attempts (token blocks exits): ${sell.reason}`;
    return finalize(result);
  }
  result.sellTxHash = sell.hash;
  result.sellGasUsed = sell.gasUsed;

  const wethAfter = await balanceOf(publicClient, weth, wallet);
  const tokenAfterSell = await balanceOf(publicClient, token, wallet);

  result.canSell = true;
  result.tokensSold = tokensToSell - tokenAfterSell;
  // WETH received == ETH-equivalent proceeds of the sell (no gas adjustment
  // needed: gas is paid in native ETH, not WETH).
  result.ethReceived = wethAfter - wethBefore;

  // Effective sell tax vs the honest quote.
  if (result.ethExpected > 0n) {
    result.sellTax = taxFromRatio(result.ethReceived, result.ethExpected);
  }

  return finalize(result);
}

/** Derive round-trip loss once buy + sell economics are known. */
function finalize(r: RoundTripResult): RoundTripResult {
  if (r.ethSpent > 0n && r.canSell) {
    r.roundTripLoss = taxFromRatio(r.ethReceived, r.ethSpent);
  }
  return r;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return -1;
  return Math.max(0, Math.min(1, n));
}
