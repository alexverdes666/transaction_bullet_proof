/**
 * Shared domain types for the honeypot sandbox.
 *
 * `bigint` is used everywhere on-chain quantities are involved. Because JSON
 * cannot serialise bigint, every value that crosses a process / file boundary
 * is rendered to a string via {@link serialize}.
 */
import type { Address, Hash } from 'viem';
import type { TokenInfo } from './discover.js';
import type { ProviderResult } from './providers/types.js';

/** A single ERC-20 / ETH balance reading for the test wallet. */
export interface BalanceReading {
  /** Token contract, or `null` for native ETH. */
  token: Address | null;
  symbol: string;
  decimals: number;
  raw: bigint;
}

/** Raw EVM storage slot reading — used for low-level state diffing. */
export interface StorageReading {
  account: Address;
  slot: Hash;
  /** Human label, e.g. "token.balanceOf(wallet)". */
  label: string;
  value: Hash;
}

/** Immutable picture of the relevant chain state at one instant. */
export interface StateSnapshot {
  label: string;
  blockNumber: bigint;
  /** Anvil EVM snapshot id, used to revert the fork to this exact state. */
  evmSnapshotId: Hash | null;
  balances: BalanceReading[];
  storage: StorageReading[];
  takenAt: number;
}

/** The delta between two snapshots for one balance line. */
export interface BalanceDelta {
  token: Address | null;
  symbol: string;
  decimals: number;
  before: bigint;
  after: bigint;
  delta: bigint;
}

/** A flagged anomaly the diff engine detected. */
export interface Anomaly {
  severity: 'info' | 'warning' | 'critical';
  code: string;
  message: string;
}

/** Result of the on-chain buy -> sell round-trip simulation. */
export interface RoundTripResult {
  token: Address;
  tokenSymbol: string;
  tokenDecimals: number;

  /** Was the token even buyable on the configured router? */
  canBuy: boolean;
  /** Did the sell transaction succeed (not revert)? */
  canSell: boolean;

  ethSpent: bigint;
  tokensReceived: bigint;
  /** What an honest (zero-tax) pool would have returned on the buy. */
  tokensExpected: bigint;

  tokensSold: bigint;
  ethReceived: bigint;
  /** What an honest (zero-tax) pool would have returned on the sell. */
  ethExpected: bigint;

  /** Effective buy tax as a fraction (0..1), -1 if undeterminable. */
  buyTax: number;
  /** Effective sell tax as a fraction (0..1), -1 if undeterminable. */
  sellTax: number;
  /** Full round-trip loss: 1 - (ethReceived / ethSpent). */
  roundTripLoss: number;

  buyGasUsed: bigint | null;
  sellGasUsed: bigint | null;

  buyTxHash: Hash | null;
  sellTxHash: Hash | null;

  /** Revert reason captured when the sell (or buy) failed. */
  revertReason: string | null;
}

/** Full machine-readable verdict emitted by the sandbox. */
export interface HoneypotReport {
  target: Address;
  verdict: 'SAFE' | 'SUSPICIOUS' | 'HONEYPOT' | 'ERROR';
  riskScore: number; // 0 (safe) .. 100 (definite honeypot)
  summary: string;
  /** Chain the scan ran on (registry key, e.g. "bsc"), when known. */
  chain?: string;
  /** Human-readable chain name, e.g. "BNB Smart Chain". */
  chainName?: string;
  /** Auto-detected metadata about the token (image, price, links, age, …). */
  tokenInfo?: TokenInfo;
  /** Per-detector breakdown (our sim + GoPlus + honeypot.is) behind the verdict. */
  sources?: ProviderResult[];
  roundTrip: RoundTripResult | null;
  balanceDiff: BalanceDelta[];
  storageDiff: { label: string; account: Address; slot: Hash; before: Hash; after: Hash }[];
  anomalies: Anomaly[];
  fork: {
    rpcUrl: string;
    blockNumber: string;
    chainId: number;
  };
  durationMs: number;
  generatedAt: string;
}
