# crypto_transaction_bullet_proof

A **headless sandbox for smart-contract reverse-engineering and honeypot / hidden-tax
detection**. It spins up an isolated local mainnet fork, executes a real buy → sell
round-trip as a fresh "retail" wallet, and performs a strict **EVM state diff** to detect
contracts that let you *buy* but quietly prevent you from *selling* (honeypots) or that
levy hidden/asymmetric taxes.

> Defensive use only: this tool helps users and analysts decide whether a token is safe to
> interact with **before** risking real funds. It executes everything against a throwaway
> local fork — no mainnet transactions, no real money.

---

## How it detects malicious contracts

A legitimate token is roughly symmetric: the ETH you pay to acquire it is — minus a small
honest LP fee and price impact — recoverable when you sell. Honeypots break that symmetry
in measurable ways. On an isolated fork the sandbox, as a brand-new wallet:

1. **Quotes** the buy via `router.getAmountsOut` (what an *honest* pool would return).
2. **Buys** `ETH → token` and measures the tokens actually delivered (gap vs quote = buy tax).
3. **Approves** the router to move the tokens.
4. **Sells** `token → WETH` and measures the WETH actually received (gap vs quote = sell tax).

The resulting signals map to scored anomalies:

| Code | Meaning |
|------|---------|
| `SELL_REVERTED` | Buyable but the sell reverts — the defining honeypot behaviour. |
| `ZERO_TOKENS` | Buy "succeeds" but no tokens arrive (≈100% fee-on-transfer). |
| `HIGH_SELL_TAX` / `ELEVATED_SELL_TAX` | Sell returns far less than the honest quote. A sell tax ≥40% alone is a HONEYPOT; 10–39% is SUSPICIOUS. |
| `HIGH_BUY_TAX` | Tokens received well below the honest quote. |
| `TAX_ASYMMETRY` | Sell tax ≫ buy tax — cheap to enter, punishing to exit. |
| `ROUNDTRIP_LOSS` | End-to-end you recover far less ETH than you put in. |
| `NO_LIQUIDITY` | Not routable on the configured DEX (no V2 pair / V3-only / non-standard routing). Reported as `ERROR` (inconclusive) — never SAFE, since sellability can't be tested. |
| `STORAGE_DELTA` | A watched raw storage slot changed (cross-checked vs ERC-20 balance). |

A weighted risk score (0–100) yields the verdict: **SAFE** (<30), **SUSPICIOUS** (30–69),
**HONEYPOT** (≥70).

### Why we sell to WETH, not native ETH
The sell swaps `token → WETH` (an ERC-20) and measures the WETH balance delta, rather than
unwrapping to native ETH. WETH is 1:1 with ETH, so the economic signal is identical, but an
ERC-20 balance read is immune to gas-accounting noise **and** sidesteps `WETH9.withdraw()`'s
2300-gas `.transfer` stipend, which reverts under current EVM gas rules on a fork. This was
the single most important correctness fix in the engine.

---

## Architecture

A single Node.js / TypeScript pipeline around a spawned `anvil` fork:

```
        ┌─────────────────────── Node.js / TypeScript core ───────────────────────┐
[Start Anvil] ─▶ [Fund wallet] ─▶ [Snapshot BEFORE] ─▶ [on-chain buy→sell] ─▶ [Snapshot AFTER]
   fork                                                                          │
                                                                                 ▼
                                                                [State diff + anomaly scoring]
                                                                                 │
                                                                                 ▼
                                                                 [Clean JSON + terminal report]
```

- **Node.js / TypeScript** (`src/`) — forking, EVM state snapshot/diff, transaction execution
  via [`viem`](https://viem.sh) against a spawned `anvil` child process. This is the
  deterministic, bulletproof core.
- **Control API** (`src/server.ts`) — exposes the pipeline over a tiny HTTP/IPC layer so other
  processes (CI, a dashboard, the web app) can request scans.

### Project layout
```
src/
  config.ts          env-driven, type-safe configuration
  anvil.ts           isolated fork lifecycle (spawn, RPC failover, snapshot, clean teardown)
  clients.ts         viem public/wallet clients bound to the fork
  abi.ts             minimal ERC-20 + Uniswap-V2 router ABIs
  token.ts           ERC-20 metadata + balance storage-slot discovery
  wallet.ts          fund wallet, pre-approve
  snapshot.ts        capture balances + raw storage slots
  honeypot.ts        the buy→sell round-trip engine  ◀ core
  statediff.ts       balance/storage diff + anomaly scoring  ◀ core
  scan.ts            high-level pipeline → HoneypotReport
  report.ts          terminal rendering + JSON persistence
  index.ts           CLI entrypoint (one-shot scan)
  server.ts          HTTP control / IPC API
```

---

## Prerequisites

- **Node.js ≥ 20**
- **Foundry / `anvil`** — install via `foundryup`:
  ```bash
  curl -L https://foundry.paradigm.xyz | bash && foundryup
  ```
  On Windows the binary lands at `%USERPROFILE%\.foundry\bin\anvil.exe`. Point `ANVIL_BIN`
  at it (the bundled `.env.example` shows the path).
- **A mainnet RPC URL.** Free public endpoints work but are flaky — list several
  comma-separated for automatic failover, or use a dedicated Alchemy/Infura key for reliable
  results.

## Setup
```bash
npm install
cp .env.example .env     # then edit ANVIL_BIN and FORK_RPC_URL
```

## Usage

**One-shot scan (deterministic on-chain engine — recommended):**
```bash
npm run scan -- <tokenAddress> [--buy <eth>] [--json-only]
# e.g. mainnet USDC (returns SAFE):
npm run scan -- 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
```
Exit codes: `0` SAFE/SUSPICIOUS · `1` HONEYPOT · `3` ERROR — usable as a CI gate.

**HTTP control API:**
```bash
npm run server
curl -X POST http://127.0.0.1:8645/scan -H 'content-type: application/json' \
  -d '{"token":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","buyEth":1}'
```

Reports are written to `reports/<token>_<timestamp>.json`.

---

## Reliability notes (learned the hard way)

- **Process hygiene (Windows):** `anvil` is spawned **without** a shell wrapper and torn down
  with `taskkill /T` (full process tree). Spawning through a shell orphaned `anvil.exe` on the
  port, so the next run silently reconnected to a *stale* fork with accumulated state — a
  source of nondeterministic, wrong verdicts. `AnvilFork.start()` also refuses to run if the
  port is already answering.
- **Flaky free RPCs cause false positives.** anvil fetches fork state lazily, so a single
  dropped upstream request mid-transaction can surface as a spurious "revert" → false
  HONEYPOT. Mitigations: anvil is launched with `--retries/--timeout/--fork-retry-backoff`,
  the upstream is health-probed before forking, and `FORK_RPC_URL` accepts a comma-separated
  failover list. For production, use a dedicated RPC key.

## Limitations / disclaimer
- Routing assumes a Uniswap-V2-style router. Tokens that only have V3/Curve/Balancer liquidity
  surface as `NO_LIQUIDITY` rather than a buy/sell verdict (configure `ROUTER_ADDRESS` for
  other V2 forks).
- A SAFE verdict reflects behaviour **at the forked block** with the configured trade size;
  it is not a guarantee of future behaviour (taxes/blacklists can be toggled by an admin).
- The simulation is **single-pass / single-wallet** at one block, so honeypots that gate
  sells by per-address cooldown, blacklist, sell-count or a trading toggle can evade it.
- This is an analysis aid, not financial advice. Always do your own research.
