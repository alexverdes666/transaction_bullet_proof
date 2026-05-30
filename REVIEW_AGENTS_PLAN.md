# REVIEW_AGENTS_PLAN.md — Multi-Agent End-to-End Project Review

> **Purpose.** A repeatable, role-based audit of the entire **Bullet Proof** project
> (scan engine + worker + Next.js SaaS), from first
> line to last. Each role below is a specialized agent with a narrow mandate, a fixed
> set of inputs, and a concrete deliverable. Spawn them phase by phase.
>
> **Methodology: phased Waterfall with gates (not Agile).**
> Rationale — this is a *one-time, full-codebase audit of an existing product*, not
> iterative feature delivery. Review work has a natural dependency order (you must
> understand the system before you can judge it, and judge it before you can verify
> fixes). Waterfall's sequential phases + explicit "gate" checkpoints map cleanly onto
> that. Agile/sprints suit ongoing build work; for a bounded review pass, phased gates
> give clearer coverage guarantees and a single consolidated report. Within a phase,
> agents run **in parallel** (they are independent); between phases there is a **gate**
> (later phases consume earlier outputs).
>
> **How to run.** Either spawn each role as its own agent (`Agent` tool) or drive the
> whole thing with a `Workflow` (pipeline per phase, barrier at each gate). Each agent
> must return a **structured findings list**, not prose (see "Output contract" below).

---

## Conventions

**Severity scale (every finding uses it):**
`BLOCKER` > `CRITICAL` > `MAJOR` > `MINOR` > `NIT` / `INFO`.

**Output contract (every agent returns this shape):**
```
- id:        <role>-<n>
  title:     <one line>
  severity:  BLOCKER | CRITICAL | MAJOR | MINOR | NIT | INFO
  location:  <file:line(s)>  (or "cross-cutting")
  evidence:  <what was observed — quote/trace, not opinion>
  impact:    <what breaks / what it costs>
  fix:       <concrete recommended change>
  effort:    S | M | L
  confidence: HIGH | MED | LOW
```

**Scope map (what "beginning to end" covers):**
- `src/` — scan engine + worker (TS, ESM/NodeNext).
- `web/` — Next.js 16 SaaS (auth, paywall, payments, admin, tracking).
- Root + `web/` config, tests (`*.test.ts`, vitest, workflow e2e), Docker/Render/Vercel
  deploy artifacts, and all Markdown docs.

**Ground rules for every agent:**
- Read `CLAUDE.md` §5 (gotchas) **first** — do not propose changes that regress them.
- Cite evidence (`file:line`). No finding without a location and an observation.
- Distinguish *defects* (it's wrong) from *risks* (it could go wrong) from *improvements*.
- Stay in your lane; if you spot something outside it, log it as `INFO` and move on.

---

## PHASE 0 — Discovery & Baseline  *(must complete before anything else)*

> Goal: establish the ground truth the rest of the review trusts. No judgments yet.

| Role | Mandate | Key inputs | Deliverable |
|------|---------|-----------|-------------|
| **0.1 System Cartographer** | Map every component, entry point, route, data flow, and external dependency. Produce a dependency graph and a "what calls what" index. | Whole repo, `CLAUDE.md`, `package.json`×2, `render.yaml`, `Dockerfile.worker` | `ARTIFACTS/map.md` — component graph + entrypoint table |
| **0.2 Build & Run Verifier** | Actually install, build, and boot each layer (engine CLI, worker, web `build`, in-mem Mongo). Record exact commands, versions, and any failure. | §7 of `CLAUDE.md`, scripts | Reproducible run log; red/green per layer |
| **0.3 Test Baseline Auditor** | Run all three suites (`npm test`, `web` vitest, `test:workflow`). Record pass/fail, runtime, and **coverage gaps by file**. | `TESTING.md`, test dirs | Coverage matrix; list of untested modules |

**GATE 0:** map + green build log + coverage matrix exist. If the build is red, stop and report.

---

## PHASE 1 — Requirements & Design Review

> Goal: does the design match the stated product, and is it internally consistent?

| Role | Mandate |
|------|---------|
| **1.1 Requirements Analyst** | Reconcile `PLAN.md` / `ABOUT.md` / `SAAS_ARCHITECTURE.md` against the actual code. Flag drift: promised-but-missing, built-but-undocumented, contradictory decisions. |
| **1.2 Software Architect** | Evaluate boundaries (engine ↔ worker ↔ web ↔ db), coupling/cohesion, the serverless-vs-worker split, failure isolation. Flag layering violations and single points of failure. |
| **1.3 Domain Correctness Reviewer (crypto)** | Validate the *honeypot logic itself*: buy→sell round trip, tax math, scoring weights (`statediff.ts`), WETH-not-ETH decision, swap-retry logic. Are the verdicts actually sound? Any way a real honeypot scores SAFE, or a safe token scores HONEYPOT? |
| **1.4 Data Modeler** | Review Mongoose models (`web/models/`): indexes (esp. TTL + unique `txHash`), schema validation, referential integrity, PII footprint. |

**GATE 1:** design findings logged; domain-correctness sign-off (or list of correctness risks).

---

## PHASE 2 — Implementation Quality (the big parallel sweep)

> Goal: the core of the review. Run all of these concurrently; each owns one lens.

| Role | Mandate |
|------|---------|
| **2.1 Code Quality / Maintainability Reviewer** | Readability, naming, function size, duplication, dead abstractions, consistency with surrounding style. Cyclomatic hot-spots. |
| **2.2 Best-Practices Reviewer** | Idiomatic TS/Node (ESM/NodeNext rules), React 19 / Next 16 App Router conventions. Flag anti-patterns and deprecated APIs. |
| **2.3 Simplification Reviewer** | Code that can be simplified or deleted without behavior change: over-engineering, needless indirection, redundant branches, things the stdlib/framework already does. |
| **2.4 Dead / Unused Code Hunter** | Unreferenced exports, files, deps (`package.json` bloat), unreachable branches, commented-out blocks, orphaned env vars. Verify with grep/import-graph, not guesswork. |
| **2.5 Edge-Case & Robustness Reviewer** | Every input boundary and failure path: empty/garbage token addresses, RPC timeouts/failover, anvil crash/port-in-use, zero-liquidity pools, concurrent credit spend, payment dust collisions, partial/duplicate transfers, clock skew on TTL. "What input breaks this?" |
| **2.6 Error-Handling & Logging Reviewer** | Are errors caught at the right layer, surfaced or swallowed correctly? Is logging present, structured, leveled, and free of secrets/PII? Gaps where a failure would be invisible in prod. Propose a logging strategy if absent. |
| **2.7 Type-Safety Reviewer** | `any` leaks, unsafe casts, bigint/ES2017 pitfalls (§5.5), zod-vs-TS-type drift, nullability holes at trust boundaries (API bodies, DB reads, RPC responses). |
| **2.8 Concurrency & Resource Reviewer** | Process hygiene (anvil spawn/kill on Windows, §5.2), connection pooling/caching (`db.ts`), leaks (sockets, child procs, file handles), race conditions, idempotency of payment settlement. |

**GATE 2:** consolidated, de-duplicated findings list across 2.1–2.8.

---

## PHASE 3 — Security & Compliance Review

> Goal: it handles money, auth, and PII — this phase is non-negotiable.

| Role | Mandate |
|------|---------|
| **3.1 Application Security Auditor** | OWASP pass: authn/z (scrypt, session cookies), the paywall bypass surface, admin defence-in-depth (role + key + IP + obscure path), injection, SSRF (the worker calls RPCs), rate-limit soundness, secret handling. |
| **3.2 Payments / Financial-Integrity Auditor** | The crypto flow end-to-end: server-defined packs, amount-attribution dust scheme, on-chain verification (`getLogs`, confirmations), idempotent replay-safe settle, double-credit / refund-abuse paths. Can a user get credits without paying, or pay and not get credits? |
| **3.3 Privacy / PII & Tracking Reviewer** | Fingerprinting + IP/UA capture vs. data-minimization; retention, exposure in admin panel/logs, and what a DB leak reveals. Consent/legal-surface notes (`INFO`). |
| **3.4 Dependency & Supply-Chain Reviewer** | `npm audit` for known CVEs, unpinned/abandoned packages, install-time script risk, Docker base-image provenance. |
| **3.5 Secrets & Config Hygiene Reviewer** | Confirm no secrets committed (§5.6), `.env*` gitignored, env validation (`env.ts`) is complete and fails closed, prod-vs-dev config separation. |

> Note: a dedicated `/security-review` skill exists — 3.1 may invoke it and incorporate output.

**GATE 3:** security findings triaged; any `BLOCKER`/`CRITICAL` flagged for immediate owner attention.

---

## PHASE 4 — Performance, Reliability & Frontend/SEO

> Goal: will it be fast, observable, survivable in prod, and findable?

| Role | Mandate |
|------|---------|
| **4.1 Performance / Optimization Reviewer** | Hot paths: per-scan fork cost, RPC round trips, DB query/index efficiency (N+1, missing indexes), web bundle size, render/data-fetch waterfalls, caching opportunities. Quantify where possible. |
| **4.2 Reliability / Resilience (SRE) Reviewer** | Timeouts, retries/backoff, graceful degradation, health checks (`/health`), what happens when the worker or RPC is down, cold-start behavior on Render/Vercel. |
| **4.3 Observability Reviewer** | Beyond logging: metrics, traces, alerting hooks, audit-trail completeness, and "could you debug a prod incident from what's emitted today?" |
| **4.4 SEO & Web-Discoverability Reviewer** | Landing/public pages (`/`, `/login`, `/register`): metadata, Open Graph, semantic HTML, sitemap/robots, Core Web Vitals, SSR vs CSR for crawlability, structured data. (Authed/admin routes excluded — should be noindex.) |
| **4.5 Accessibility (a11y) Reviewer** | WCAG basics on public + dashboard UI: semantics, labels, contrast, keyboard nav, focus, ARIA. |
| **4.6 UX / Content Reviewer** | Scan-result clarity (traffic-light verdict + plain-English reasons), error messaging, checkout flow friction, copy consistency. |

**GATE 4:** perf/reliability/frontend findings logged with measurements where available.

---

## PHASE 5 — Verification & QA

> Goal: independently confirm the product behaves, and that Phase 0–4 findings are real.

| Role | Mandate |
|------|---------|
| **5.1 QA Test Engineer (functional)** | Author/execute test cases for every user journey: register → login → buy credits → scan → view results → admin view. Happy path + negative path. Map each to pass/fail. |
| **5.2 Integration / E2E Reviewer** | Audit `test:workflow` for completeness; identify untested cross-component contracts (web↔worker secret, payment↔credit grant, web↔worker scan flow). Propose missing e2e cases. |
| **5.3 Adversarial Verifier (red-team the findings)** | Take Phase 2–3 `CRITICAL`/`MAJOR` findings and try to **refute** each (reproduce or disprove). Kills false positives before they reach the report. Default to "unproven" if it can't be reproduced. |
| **5.4 Regression-Risk Reviewer** | For each proposed fix, assess blast radius and the chance it regresses a §5 gotcha. Flag fixes that need their own test. |
| **5.5 Test-Strategy Reviewer** | Overall test pyramid health: unit/integration/e2e balance, flakiness sources (live RPC, anvil), determinism, CI-readiness. |

**GATE 5:** every `CRITICAL+` finding is either verified-real or struck; QA pass/fail recorded.

---

## PHASE 6 — Documentation, Release & Synthesis

> Goal: package the audit into something the owner can act on.

| Role | Mandate |
|------|---------|
| **6.1 Documentation Reviewer** | Accuracy + completeness of `CLAUDE.md`, `README.md`, `SAAS_ARCHITECTURE.md`, `TESTING.md`, `ABOUT.md`. Flag stale claims (esp. "Done & tested" vs reality from Phase 0). |
| **6.2 Release / Deployment Reviewer** | Vercel/Render/Docker readiness, env-var completeness for prod, rollback story, migration safety, the pending GitHub-push situation (§10). |
| **6.3 Compliance / Legal-Surface Reviewer** | ToS/disclaimer for a financial-advice-adjacent tool, "no funds at risk" claims, PII/GDPR-ish posture. All `INFO`/advisory. |
| **6.4 Lead Reviewer / Synthesizer** | Merge all phases into one report: de-dupe, rank by severity×effort, produce an executive summary, a prioritized backlog, and a "fix-first" shortlist. Owns the final deliverable. |

**GATE 6 (final):** single consolidated report + prioritized backlog delivered.

---

## Final deliverable (owned by 6.4)

```
ARTIFACTS/
  map.md                 # Phase 0 system map
  run-log.md             # build/run/test baseline
  findings.json          # all findings, structured (see Output contract)
  REVIEW_REPORT.md       # exec summary + per-phase sections + prioritized backlog
  fix-first.md           # the BLOCKER/CRITICAL shortlist with effort estimates
```

**Prioritization rubric for the backlog:**
`BLOCKER` & `CRITICAL` first (security/payments/correctness), then `MAJOR` sorted by
(impact ÷ effort), then `MINOR`/`NIT` batched as a single cleanup pass.

---

## Quick spawn order (TL;DR)

1. **Phase 0** (3 agents) → gate on green build.
2. **Phase 1** (4 agents, parallel) → domain-correctness sign-off.
3. **Phase 2** (8 agents, parallel) → the main quality sweep.
4. **Phase 3** (5 agents, parallel) → security/payments/privacy.
5. **Phase 4** (6 agents, parallel) → perf/reliability/SEO/a11y/UX.
6. **Phase 5** (5 agents) → QA + adversarial verification of findings.
7. **Phase 6** (4 agents) → docs/release + final synthesis.

Total: ~35 role-agents across 7 gated phases.
