# CLAUDE.md — project guide for AI coding sessions

> This file is the canonical onboarding doc. Read it first. It explains what the
> project is, who it's for, how every part works, the key decisions and the
> non-obvious gotchas, and how to run/test/deploy it. Keep it up to date when the
> architecture changes.

---

## 1. What this project is

**Bullet Proof** is a defensive crypto-security tool: it detects **honeypot tokens**
and **hidden/asymmetric sell taxes** *before* a user risks real money.

A honeypot is a token you can **buy** but not **sell** (the contract blocks exits),
or one that levies a hidden tax so large that selling returns almost nothing. Bullet
Proof finds these by **actually simulating a buy-then-sell round trip** for the token
on a private, throwaway copy of Ethereum mainnet (a fork), then measuring the result.
No real funds are ever used.

It exists in two forms:

1. **The scan engine** (a CLI + internal HTTP service) — the deterministic core.
2. **A paid SaaS** (web app) wrapping the engine: accounts, a crypto paywall, and an
   admin panel. This is the productized form the owner is building.

### Who it's for
- **Retail crypto buyers** who want a quick safety check before buying a new token.
- **Communities / analysts** screening tokens to protect members.
- Anyone who has worried *"what if I can't sell this back out?"*

### Purpose / value
Most "honeypot checkers" only read a contract's code statically. Bullet Proof goes
further: it **executes the full buy + sell** on a fork and observes the outcome —
actions don't lie. The output is a traffic-light verdict (SAFE / SUSPICIOUS /
HONEYPOT) with plain-English reasons and a 0–100 risk score.

---

## 2. Architecture at a glance

Two components. The engine cannot run on serverless (it spawns native `anvil`
processes and runs live forks), which is why there's a separate worker.

```
Browser ─https─▶ Next.js web app (Vercel) ─https + X-Worker-Secret─▶ Scan worker (Render) ─▶ anvil fork ─▶ mainnet RPC
                   │ auth, credits, crypto payments, admin, tracking
                   └────────────▶ MongoDB Atlas
```

| Component | Lives in | Host | Role |
|-----------|----------|------|------|
| **Scan engine / worker** | `src/` (+ `Dockerfile.worker`) | Render | Forks mainnet, runs the buy→sell simulation, returns a JSON report. Internal-only; gated by a shared secret. |
| **Web app** | `web/` (Next.js 16, React 19, App Router) | Vercel | The only public surface: landing, email+password auth, dashboard/scan UI, crypto checkout, hidden admin panel, all DB access. Calls the worker. |
| **Database** | Mongoose models in `web/models/` | MongoDB Atlas | `users`, `sessions`, `orders`, `scans`, `auditlogs`, `ratelimits`. |

---

## 3. How the scan engine works (the core)

Entry points (root `package.json` scripts):
- `npm run scan -- <tokenAddress>` — one-shot CLI scan (`src/index.ts`).
- `npm run server` — the internal HTTP worker (`src/server.ts`): `GET /health`, `POST /scan`.

### The round trip (`src/honeypot.ts`)
On an isolated fork, as a fresh funded wallet:
1. **Quote** the buy via the Uniswap-V2 router `getAmountsOut` (what an honest pool returns).
2. **Buy** `ETH → token`; measure tokens actually received (gap vs quote = buy tax).
3. **Approve** the router to spend the token.
4. **Sell** `token → WETH`; measure WETH received (gap vs quote = sell tax).

### Verdict scoring (`src/statediff.ts`)
Signals → anomaly codes → weighted risk score (0–100):
- `SELL_REVERTED` (buyable, sell reverts) — the defining honeypot, +90.
- `ZERO_TOKENS` (buy yields nothing), `HIGH_SELL_TAX` (≥40% — this weight alone clears the
  HONEYPOT line), `ELEVATED_SELL_TAX` (≥10% and <40% — SUSPICIOUS), `HIGH_BUY_TAX`,
  `TAX_ASYMMETRY`, `ROUNDTRIP_LOSS`, `NO_LIQUIDITY`, `STORAGE_DELTA`.
- Verdict: **<30 SAFE, 30–69 SUSPICIOUS, ≥70 HONEYPOT**; `ERROR` if it couldn't run.
- A token that can't even be **bought** (no V2 pair / V3-only) is reported `ERROR`
  (inconclusive) — **never `SAFE`** — because sellability was never actually tested.
- **Known limitation:** the round trip is single-pass / single-wallet at one forked block,
  so runtime-gated traps (per-address cooldowns, blacklists, sell-count limits, a trading
  toggle) can evade it. The guarantee covers static taxes and hard sell-blocks.

Key source files: `src/anvil.ts` (fork lifecycle), `src/scan.ts` (pipeline →
`HoneypotReport`), `src/snapshot.ts` + `src/statediff.ts` (state diff), `src/report.ts`
(terminal + JSON output), `src/clients.ts`, `src/token.ts`, `src/wallet.ts`, `src/abi.ts`,
`src/config.ts`, `src/types.ts`, `src/util.ts`.

---

## 4. The SaaS layer (`web/`)

Locked product decisions: **crypto payments**, **email + password auth**,
**fully paid** (no free scans), sold as one-time **credit packs** (1 scan = 1 credit).
Full design + security rationale is in **`SAAS_ARCHITECTURE.md`**.

### Routes
- Public: `/` (landing), `/login`, `/register`.
- Authed: `/dashboard` (scan UI + credit balance + recent scans), `/buy` (credit packs + crypto checkout).
- Admin: a **secret env-configured path** (`ADMIN_PATH`) that middleware rewrites to the
  internal `/control-internal` route. Direct hits on `/control-internal` 404.
- API (`web/app/api/`): `auth/register|login|logout|me`, `scan`, `orders` (create/list),
  `orders/[id]` (poll/verify payment), `admin/unlock`.

### Auth (`web/lib/password.ts`, `session.ts`, `auth.ts`)
- Passwords hashed with **scrypt** + per-user salt (`salt:hash`), constant-time verify.
- Sessions: opaque 256-bit token in an **httpOnly + Secure + SameSite=strict** cookie;
  only the token's SHA-256 hash is stored in `sessions` (TTL-indexed). DB leak ≠ usable cookie.

### Paywall (`web/app/api/scan/route.ts`)
- Requires login + `credits > 0`. Credit spend is an **atomic** `findOneAndUpdate` guarded by
  `credits: { $gt: 0 }` (no double-spend under concurrency). Refunds the credit if the worker errors.
- The worker is internal and requires `X-Worker-Secret`, so users **cannot bypass** the paywall
  by calling the engine directly.

### Crypto payments (`web/lib/payments.ts`)
- Packs are server-defined (`CREDIT_PACKS`: starter 10 / pro 50 / whale 200, priced in USDC).
  The client only sends a `packId`; price/credits/treasury are decided server-side.
- An order gets a unique amount (base price + small random dust) so an inbound transfer can be
  attributed to exactly one order. Verification reads the chain via viem (`getLogs` of ERC-20
  `Transfer` to the treasury, matching the exact amount, after `minConfirmations`). Settling is
  **idempotent and replay-safe**: atomic `pending→paid` flip + unique `txHash` index; credits
  granted exactly once. The client can never self-report payment.

### Admin panel + tracking
- Defence in depth: **admin role** + **access key** (httpOnly `bp_admin_key` cookie, set by
  `/api/admin/unlock`) + optional **IP allowlist** — the obscure URL is only obfuscation on top.
- Shows registered users with emails, **IPs**, **browser fingerprints**, scans, orders, and a
  full **activity audit trail**.
- Tracking: every security-relevant request logs IP / user-agent / fingerprint to `auditlogs`
  and folds sightings onto the user (`web/lib/audit.ts`). The fingerprint is computed client-side
  from canvas/WebGL/device signals (`web/app/FingerprintProbe.tsx`) into a `bp_fp` cookie.

### Other web libs
`web/lib/env.ts` (validated config), `db.ts` (cached Mongoose conn), `ratelimit.ts`
(Mongo-backed fixed-window), `validation.ts` (zod), `worker.ts` (worker client),
`request.ts` (IP/UA/fingerprint extraction), `api.ts` (response/error helpers).

---

## 5. Critical gotchas & decisions (read before editing!)

These were discovered the hard way; don't regress them.

1. **Sell to WETH, never unwrap to native ETH.** `WETH9.withdraw()`'s 2300-gas `.transfer`
   stipend *reverts* on a fork under current EVM gas rules, which made every token look like a
   100% honeypot. The engine sells `token → WETH` (an ERC-20, 1:1 with ETH) and measures the WETH
   balance delta. See `src/honeypot.ts`.
2. **Windows anvil process hygiene.** Spawn anvil **without a shell** and kill it with
   `taskkill /T` (whole tree); a shell wrapper orphaned `anvil.exe` on the port and the next run
   silently reused stale forked state → nondeterministic wrong verdicts. `AnvilFork.start()` also
   refuses to run if the port is already answering. Each fork now binds a **free ephemeral port**
   (not a fixed one), so the worker can serve **concurrent** scans, each isolated on its own
   process/port/state; viem clients are built per-fork from `fork.endpoint`. See `src/anvil.ts`.
3. **Flaky free RPCs cause false positives.** anvil lazily fetches fork state, so a dropped
   upstream request mid-tx can look like a revert → false HONEYPOT. Mitigations: anvil
   `--retries/--timeout/--fork-retry-backoff`, upstream health-probe before forking, comma-separated
   `FORK_RPC_URL` failover, **and each swap is retried up to 3×** (a reverted tx changes no state;
   a real honeypot reverts on every attempt). See `src/anvil.ts` + `src/honeypot.ts`.
4. **Next.js `_`-prefixed folders are NOT routable** (private folders). The admin routes must be
   `control-internal` / `api/admin`, not `__admin`. See `web/middleware.ts`.
5. **`tsc` target is ES2017** in `web/` (Next default) — avoid bigint *literals* (`5n`) in TS that
   tsc checks; use `BigInt(5)`. Runtime/SWC handles bigint fine; this is only a type-check thing.
6. **Secrets never get committed.** Engine config in root `.env`; web secrets in `web/.env.local`.
   Both are gitignored. Always `git diff --cached --name-only | grep env` before committing.

---

## 6. Configuration

- **Engine / worker** — root `.env` (template `.env.example`): `FORK_RPC_URL` (comma-separated for
  failover; use a dedicated Alchemy/Infura key in prod), `ANVIL_BIN` (full path to `anvil.exe` on
  Windows), `ROUTER_ADDRESS`/`WETH_ADDRESS`, `BUY_ETH`, `WORKER_SHARED_SECRET`.
- **Web app** — `web/.env.local` (template `web/.env.example`): `MONGODB_URI`, `SESSION_SECRET`,
  `WORKER_URL` + `WORKER_SHARED_SECRET` (must match the worker), `ADMIN_PATH`, `ADMIN_ACCESS_KEY`,
  `ADMIN_IP_ALLOWLIST`, and `PAY_*` (RPC, USDC token, **`PAY_TREASURY_ADDRESS`** = your receiving wallet).

---

## 7. Running locally

```bash
# Engine CLI scan (needs Foundry/anvil installed + a mainnet RPC)
npm install && npm run scan -- 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48   # USDC -> SAFE

# Worker (the web app calls this)
npm run server            # set WORKER_SHARED_SECRET to require the header

# Web app
cd web && npm install && npm run dev      # http://localhost:3000
```
Foundry install: `curl -L https://foundry.paradigm.xyz | bash && foundryup`
(on Windows the binary is `%USERPROFILE%\.foundry\bin\anvil.exe`).

No local Mongo? `web/scripts/mem-mongo.mjs` starts an in-memory MongoDB for dev.

---

## 8. Testing — see `TESTING.md`

- **Engine units:** `npm test` (node:test + tsx, 23 tests).
- **Web units:** `cd web && npm test` (vitest, 15 tests; `server-only` aliased to a stub).
- **End-to-end workflow:** start the worker + `cd web && npm run build && npm start`, then
  `cd web && npm run test:workflow` (33 assertions: auth, paywall, payments, live scan, admin,
  worker secret, rate limiting). It cleans up all data it creates.

All three layers pass against real MongoDB Atlas + a live worker.

---

## 9. Deployment

- **web** → Vercel (set all `web/.env.example` vars as Vercel env). Cannot run anvil.
- **worker** → Render via `Dockerfile.worker` (bundles Foundry) / `render.yaml` blueprint.
  Set `FORK_RPC_URL` + `WORKER_SHARED_SECRET`. Render provides `PORT`.
- **db** → MongoDB Atlas; put the SRV string in web's `MONGODB_URI`.
- Provisioning the hosting accounts and holding the treasury key is the **owner's** job; an AI
  session should not attempt to deploy or handle live keys.

---

## 10. Status & docs map

- **Done & tested:** scan engine, worker, web app (auth, paywall, crypto payments, admin, tracking),
  full test suite, deployment artifacts.
- **Not built yet (candidates):** admin actions (ban / grant credits / revoke sessions); email
  verification; password reset; deploy walkthrough.
- **Git:** committed locally; the push to `github.com/xgaming6285/transaction_bullet_proof` is
  pending the owner's interactive GitHub login (the dev machine's cached credential is a different
  account, and the repo may need creating).

Other docs: `README.md` (engine), `ABOUT.md` (non-technical marketing explainer),
`SAAS_ARCHITECTURE.md` (full SaaS + security design), `TESTING.md`, `PLAN.md` (original brief).

## 11. Environment notes
- Dev machine: **Windows** (PowerShell + Git Bash). Use full paths; mind the anvil process-hygiene
  notes above. Node 22, Foundry 1.7.x.
- Engine is ESM with `.js` import specifiers (NodeNext); web uses bundler resolution (extensionless).
