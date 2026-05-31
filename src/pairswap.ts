/**
 * Pair-direct round-trip simulation — the "use the token's REAL pool" core.
 *
 * Instead of routing a buy/sell through one hardcoded router per chain, we swap
 * DIRECTLY against the exact Uniswap-V2-style pair the token actually trades in
 * (discovered per-token from DexScreener). That makes the live simulation work
 * on ANY V2-style DEX — Uniswap, PancakeSwap, SushiSwap, Trader Joe, and the
 * countless forks — on any chain we can fork, with nothing curated per chain.
 *
 * How a buy/sell works against a bare pair (what a router does internally):
 *   buy : send `quote` into the pair, then call pair.swap() to receive `token`.
 *   sell: send `token` into the pair, then call pair.swap() to receive `quote`.
 * We fund ourselves the quote token by overwriting our balance slot on the fork
 * (anvil deal), so we need neither real funds nor a router.
 *
 * Two things a naive pair swap gets wrong, handled here:
 *   1. Fee tier varies per DEX (0.30% Uni, 0.25% Pancake, …). We don't hardcode
 *      it: we try candidate fees from most- to least-generous and take the first
 *      that the pool's K-invariant accepts — that IS the pool's real fee.
 *   2. Fee-on-transfer tokens deliver fewer tokens to the pair than we sent, so
 *      the sell output must be computed from what the pair ACTUALLY received
 *      (read post-transfer), exactly like swap*SupportingFeeOnTransferTokens.
 *
 * The result is a {@link RoundTripResult} identical in shape to the router path,
 * so scoring/reporting are unchanged.
 */
import {
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
  getAddress,
} from 'viem';
import type { AnvilFork } from './anvil.js';
import { erc20Abi, pairAbi } from './abi.js';
import { balanceOf, dealToken, readTokenMeta } from './token.js';
import { taxFromRatio } from './honeypot.js';
import { extractRevertReason, sleep } from './util.js';
import type { RoundTripResult } from './types.js';

/** How many times to retry the sell before trusting a revert as a real block. */
const TX_ATTEMPTS = 3;

/**
 * Candidate V2 fee tiers as (numerator, denominator), ordered from the SMALLEST
 * fee (largest output) to the largest. The first tier whose computed output the
 * pool accepts without a K-invariant revert is the pool's true fee — any smaller
 * fee would have produced too much output and reverted.
 */
const FEE_TIERS: readonly [bigint, bigint][] = [
  [999n, 1000n], // 0.10%
  [998n, 1000n], // 0.20%
  [9975n, 10000n], // 0.25% (PancakeSwap)
  [997n, 1000n], // 0.30% (Uniswap V2 / Sushi)
  [99n, 100n], // 1.00%
  [95n, 100n], // 5.00%
  [90n, 100n], // 10.0%
];

/** Uniswap-V2 constant-product output for a given fee, in integer math. */
function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeNum: bigint, feeDen: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * feeNum;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * feeDen + amountInWithFee;
  return numerator / denominator;
}

export interface PairSwapInputs {
  fork: AnvilFork;
  publicClient: PublicClient;
  walletClient: WalletClient;
  wallet: Address;
  /** The token under investigation. */
  token: Address;
  /** The V2-style pair to trade against (from discovery). */
  pair: Address;
}

type TxResult = { ok: true; hash: Hash; gasUsed: bigint } | { ok: false; reason: string };

async function send(publicClient: PublicClient, fn: () => Promise<Hash>): Promise<TxResult> {
  try {
    const hash = await fn();
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === 'success') return { ok: true, hash, gasUsed: receipt.gasUsed };
    return { ok: false, reason: 'transaction reverted on-chain' };
  } catch (err) {
    return { ok: false, reason: extractRevertReason(err) };
  }
}

/**
 * Drive a buy→sell round trip directly against `pair`. Throws only on setup
 * problems the caller should treat as "abstain" (pair mismatch, unfundable quote
 * token); a genuine honeypot is reported as a normal RoundTripResult with
 * canSell=false.
 */
export async function simulatePairRoundTrip(inputs: PairSwapInputs): Promise<RoundTripResult> {
  const { fork, publicClient, walletClient, wallet, token, pair } = inputs;
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

  // --- Identify the pool layout: which side is our token, which is the quote ---
  const [token0, token1] = (await Promise.all([
    publicClient.readContract({ address: pair, abi: pairAbi, functionName: 'token0' }),
    publicClient.readContract({ address: pair, abi: pairAbi, functionName: 'token1' }),
  ])) as [Address, Address];
  const t = token.toLowerCase();
  const baseIsToken0 = token0.toLowerCase() === t;
  if (!baseIsToken0 && token1.toLowerCase() !== t) {
    throw new Error('pair does not contain the token — cannot pair-simulate');
  }
  const quote = getAddress(baseIsToken0 ? token1 : token0);

  const readReserves = async (): Promise<{ base: bigint; quote: bigint }> => {
    const [r0, r1] = (await publicClient.readContract({
      address: pair,
      abi: pairAbi,
      functionName: 'getReserves',
    })) as [bigint, bigint, number];
    return baseIsToken0 ? { base: r0, quote: r1 } : { base: r1, quote: r0 };
  };

  const reserves0 = await readReserves();
  if (reserves0.base <= 0n || reserves0.quote <= 0n) {
    result.revertReason = 'pool has no liquidity';
    return finalize(result);
  }

  // Trade ~0.1% of the quote reserve: large enough to measure tax precisely,
  // small enough that price-impact slippage stays negligible.
  const amountIn = reserves0.quote / 1000n > 0n ? reserves0.quote / 1000n : 1n;

  // --- Fund the wallet with the quote token (deal via storage cheat) ----------
  const dealt = await dealToken(fork, publicClient, quote, wallet, amountIn * 4n);
  if (!dealt) throw new Error('could not fund the quote token — cannot pair-simulate');

  // --- BUY: quote -> token, finding the pool's real fee tier ------------------
  const swapToken = async (amount0Out: bigint, amount1Out: bigint): Promise<TxResult> =>
    send(publicClient, () =>
      walletClient.writeContract({
        address: pair,
        abi: pairAbi,
        functionName: 'swap',
        args: [amount0Out, amount1Out, wallet, '0x'],
        account: walletClient.account!,
        chain: walletClient.chain,
      }),
    );

  let fee: [bigint, bigint] | null = null;
  const tokenBeforeBuy = await balanceOf(publicClient, token, wallet);
  for (const [feeNum, feeDen] of FEE_TIERS) {
    const out = getAmountOut(amountIn, reserves0.quote, reserves0.base, feeNum, feeDen);
    if (out <= 1n) continue;
    const reqOut = out - 1n; // 1 wei under the max keeps the K-check from rounding-reverting
    const snap = await fork.snapshot();
    // Send the quote INTO the pair, then pull the token OUT via swap().
    const xfer = await send(publicClient, () =>
      walletClient.writeContract({
        address: quote,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [pair, amountIn],
        account: walletClient.account!,
        chain: walletClient.chain,
      }),
    );
    if (!xfer.ok) {
      await fork.revert(snap);
      result.revertReason = `funding transfer to pair failed: ${xfer.reason}`;
      continue;
    }
    const buy = baseIsToken0 ? await swapToken(reqOut, 0n) : await swapToken(0n, reqOut);
    if (buy.ok) {
      fee = [feeNum, feeDen];
      result.buyTxHash = buy.hash;
      result.buyGasUsed = buy.gasUsed;
      result.tokensExpected = out;
      result.ethSpent = amountIn;
      break;
    }
    await fork.revert(snap); // wrong fee (K revert) or transient — undo and retry
    result.revertReason = `buy swap failed: ${buy.reason}`;
  }

  if (!fee) {
    result.revertReason = result.revertReason ?? 'could not execute a buy on this pool';
    return finalize(result);
  }

  result.tokensReceived = (await balanceOf(publicClient, token, wallet)) - tokenBeforeBuy;
  result.canBuy = true;
  if (result.tokensExpected > 0n) result.buyTax = taxFromRatio(result.tokensReceived, result.tokensExpected);
  if (result.tokensReceived === 0n) {
    result.revertReason = 'buy delivered zero tokens';
    return finalize(result);
  }

  // --- SELL: token -> quote, fee-on-transfer aware ----------------------------
  const tokensToSell = result.tokensReceived;
  const quoteIsToken0 = !baseIsToken0;
  let lastReason = 'unknown';
  for (let attempt = 1; attempt <= TX_ATTEMPTS; attempt++) {
    const snap = await fork.snapshot();
    const reserves = await readReserves(); // fresh: the buy moved the price
    // Honest (zero-tax) proceeds for what we're selling, at the detected fee.
    result.ethExpected = getAmountOut(tokensToSell, reserves.base, reserves.quote, fee[0], fee[1]);

    const pairTokBefore = await balanceOf(publicClient, token, pair);
    const xfer = await send(publicClient, () =>
      walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [pair, tokensToSell],
        account: walletClient.account!,
        chain: walletClient.chain,
      }),
    );
    if (!xfer.ok) {
      // The token blocked the transfer to the pool — a hard sell block.
      lastReason = `sell transfer to pair reverted: ${xfer.reason}`;
      await fork.revert(snap);
      if (attempt < TX_ATTEMPTS) await sleep(400 * attempt);
      continue;
    }
    // FoT-aware: compute output from what the pair ACTUALLY received post-tax.
    const actualIn = (await balanceOf(publicClient, token, pair)) - pairTokBefore;
    if (actualIn <= 0n) {
      lastReason = 'pair received zero tokens (100% transfer tax / rebase)';
      await fork.revert(snap);
      break; // not transient — no point retrying
    }
    const quoteOut = getAmountOut(actualIn, reserves.base, reserves.quote, fee[0], fee[1]);
    if (quoteOut <= 1n) {
      lastReason = 'sell proceeds round to zero';
      await fork.revert(snap);
      break;
    }
    const reqQuoteOut = quoteOut - 1n;
    const quoteBefore = await balanceOf(publicClient, quote, wallet);
    const sell = quoteIsToken0 ? await swapToken(reqQuoteOut, 0n) : await swapToken(0n, reqQuoteOut);
    if (!sell.ok) {
      lastReason = `sell swap reverted: ${sell.reason}`;
      await fork.revert(snap);
      if (attempt < TX_ATTEMPTS) await sleep(400 * attempt);
      continue;
    }
    result.sellTxHash = sell.hash;
    result.sellGasUsed = sell.gasUsed;
    result.canSell = true;
    result.tokensSold = tokensToSell;
    result.ethReceived = (await balanceOf(publicClient, quote, wallet)) - quoteBefore;
    if (result.ethExpected > 0n) result.sellTax = taxFromRatio(result.ethReceived, result.ethExpected);
    return finalize(result);
  }

  result.revertReason = `sell failed (token blocks exits): ${lastReason}`;
  return finalize(result);
}

function finalize(r: RoundTripResult): RoundTripResult {
  if (r.ethSpent > 0n && r.canSell) r.roundTripLoss = taxFromRatio(r.ethReceived, r.ethSpent);
  return r;
}
