# Phase 5 — QA / Verification & Adversarial Verification

> Gate for the multi-agent review (see `REVIEW_AGENTS_PLAN.md`). This phase does
> **not** introduce new behaviour; it independently re-verifies that every change
> landed in Phases 1–4 is green and that no review-driven fix regressed a locked
> invariant. Findings were adversarially checked (each claimed fix re-read against
> the real source, not the agent's self-report) before a phase was allowed to commit.

## 1. Automated test results (final tree @ `6f1f2e5`)

All suites were run on the exact committed tree, not an intermediate working copy.

| Suite | Command | Result |
|-------|---------|--------|
| Engine type-check | `npx tsc --noEmit` | **exit 0**, no errors |
| Engine units | `node --import tsx --test test/*.test.ts` | **29 / 29 pass**, 0 fail |
| Web type-check | `web/ npx tsc --noEmit` | **exit 0**, no errors |
| Web units | `web/ npx vitest run` | **15 / 15 pass** (3 files) |
| Web production build | `web/ npm run build` | **exit 0**, compiled successfully |

New routes confirmed present in the build manifest: `○ /robots.txt`,
`○ /sitemap.xml`, `○ /opengraph-image` (Phase-4 SEO additions).

Engine test count grew 19 → **29** over the review (DOM-1 sell-tax calibration
band tests; bigint fixed-point ratio precision tests; "unbuyable ⇒ ERROR" verdict).
Web held at **15** (no behavioural surface removed; additions were non-logic SEO/a11y/UX).

## 2. Live end-to-end smoke (engine ↔ mainnet fork)

- **Mainnet USDC** (`0xA0b8…eB48`) scanned through the real anvil-fork buy→sell
  round trip → **SAFE** (riskScore < 30), matching the documented golden case.
  Confirms the WETH-not-ETH sell path (§5.1) and process hygiene (§5.2) still hold
  after the `anvil.ts` / `clients.ts` / `scan.ts` refactors.

## 3. Invariant regression checks (adversarial)

Each locked gotcha from `CLAUDE.md` §5 was re-confirmed against the final source:

| Invariant | Status after review |
|-----------|---------------------|
| Sell to **WETH**, never unwrap to native ETH | ✅ intact (`src/honeypot.ts`) |
| Windows anvil spawn-without-shell + `taskkill /T` tree kill | ✅ intact; now also `liveForks`+`stopAllForks()` on shutdown |
| Each swap retried up to 3× (reverts change no state) | ✅ intact |
| Flaky-RPC mitigations (retries/health-probe/failover) | ✅ intact; `/ready` now surfaces RPC reachability |
| Next.js `_`-prefix folders not routable → admin at `control-internal` | ✅ intact (`web/proxy.ts`) |
| Secrets never committed (`.env`, `web/.env.local` gitignored) | ✅ verified — no env files staged in any phase |
| Browser automation DOM-signalling | ➖ N/A — Camoufox layer removed in Phase 1 |
| `!canBuy` ⇒ **ERROR**, never SAFE (DOM-5) | ✅ new guard in `src/statediff.ts` |
| Sell-tax bands: ≥40% HONEYPOT / 10–39% SUSPICIOUS / ≥50% as-is (DOM-1) | ✅ calibration tests pin this |
| Worker fails **closed** in prod without secret (CFG-3) | ✅ `assertWorkerSecretInProd()` |
| RPC API keys redacted from reports (LOG-1) | ✅ `sanitizeRpcUrl()` in `src/scan.ts` |

## 4. Timeout-budget coherence (REL-1)

Verified the nesting now reads **worker internal (~75 s, incl. `fork.start()`) <
web fetch abort (90 s) < route `maxDuration` (120 s) < platform**, so an overrun
aborts cleanly inward rather than being hard-killed by the host. Fork teardown is
on every exit path including the timeout branch (no orphaned `anvil.exe`).

## 5. What was NOT run here (and why)

- **`web/ npm run test:workflow`** (33-assertion live e2e: auth, paywall, payments,
  live scan, admin, worker-secret, rate-limit). Requires a running worker + built
  web app + MongoDB Atlas simultaneously. It passed during the pre-review baseline;
  it was **not** re-run in this phase because no auth/paywall/payment *logic* changed
  in a way the unit + build gates don't already cover, and standing up the full live
  stack was out of scope for the verification gate. **Recommended** before any deploy.
- **Lighthouse / axe** automated a11y+SEO scoring — the Phase-4 fixes were verified
  by source inspection and a green production build; a runtime Lighthouse pass is a
  recommended follow-up but needs a deployed/served instance.

## 6. Verdict

All committed phases (1–4) are **green** on type-check, unit tests, and production
build, with every locked invariant re-confirmed and the live USDC golden case still
SAFE. No regressions detected. Residual items are explicitly owner-decisions
(PAY-1/2/3 HD addresses; PRIV-3/7 fingerprint consent) and are documented, not
silently changed — see `ARTIFACTS/REVIEW_REPORT.md`.
