# Bullet Proof — SaaS Architecture & Security Model

This document is the source of truth for the paid service built on top of the honeypot
scan engine. Decisions (locked): **crypto payments**, **email + password auth**,
**fully paid (no free scans)**, sold as **one-time credit packs** (pay crypto → receive N
scan credits; recurring crypto billing is impractical).

## Why three pieces (and why the engine can't live on Vercel)

The scan engine spawns `anvil` and runs live mainnet forks — long-running native processes
that **cannot** run on Vercel/serverless. So the system is split:

| Component | Host | Responsibility |
|-----------|------|----------------|
| **web** (Next.js) | Vercel | Landing page, email+password auth, user dashboard, crypto checkout, **admin panel**, all DB access, calls the worker. The only public surface. |
| **worker** (this repo's engine + Dockerfile) | Render | Runs the actual honeypot scan (Foundry/anvil). **Internal only** — reachable solely by `web` via a shared secret. Never exposed to end users. |
| **MongoDB Atlas** | Atlas | `users`, `sessions`, `orders`, `scans`, `auditLogs`. |

```
Browser ──https──▶ Next.js (Vercel) ──https + X-Worker-Secret──▶ Scan Worker (Render) ──▶ anvil fork
                      │  auth, credits, payments, admin
                      └──────────▶ MongoDB Atlas
```

## The paywall — how bypass is prevented

Every rule that protects revenue is enforced **server-side only**; the client is never
trusted. A scan request flows:

1. `web` verifies the **session cookie** (httpOnly, Secure, SameSite=strict; the cookie is an
   opaque random token, and only a keyed HMAC of it is stored server-side).
2. `web` checks `user.credits > 0` **in the database** (not from any client value).
3. Only then does `web` call the worker with the server-held `WORKER_SHARED_SECRET`.
4. On a successful scan, `web` **atomically decrements** credits (`findOneAndUpdate` with a
   `credits: { $gt: 0 }` guard, so concurrent requests can't double-spend).
5. The activity is written to `auditLogs`.

Because the worker is not publicly routable for users and requires the secret, **users
cannot call the engine directly** to get free scans. Because credit accounting is atomic
and DB-side, they cannot tamper with it from the browser.

## Crypto payment verification (trustless, server-side)

1. User picks a credit pack (price + credits defined **server-side** in a price table).
2. `web` creates an `order`: a unique `reference`, the exact expected token/amount, the
   treasury receiving address, a `status: "pending"`, and an expiry.
3. User pays the exact amount of the configured stablecoin to the treasury address.
4. A verification step (polled by `web`, confirmed on-chain via RPC — the same viem tooling
   the engine already uses) matches an inbound transfer to the order by (to=treasury,
   token, amount, after createdAt) and confirmation depth. **Payment is only credited after
   on-chain confirmation; the client cannot self-report payment.**
5. On confirmation: order → `paid`, credits granted atomically, audit logged. Each on-chain
   tx hash can settle **at most one** order (uniqueness guard) to stop replay.

> Matching by unique amount works for low volume (a random dust offset of 1–9999 base units
> distinguishes concurrent orders for the same pack). Defaults: settlement requires
> `minConfirmations` (6) confirmations; orders expire after `orderTtlMinutes` (60). It could be
> extended to per-order derived deposit addresses (HD wallet) for exact attribution at scale.

### ⚠️ KNOWN LIMITATION — payment attribution (PAY-1 / PAY-2 / PAY-3) — MUST-FIX-before-real-volume

Settlement currently matches **only** `(to == treasury, value == expectedAmount)` against a
single shared treasury address and does **not** verify the sender (`from`). This is acceptable
at low/no volume but breaks down at real concurrency:

- **PAY-1 (front-running / theft of another user's payment):** because the payer is never bound
  to the order, a non-paying user whose pending order happens to carry the same `expectedAmount`
  as a victim's inbound transfer can have the victim's on-chain `Transfer` settle *their* order
  (whichever pending order the verifier matches first). One real payment, credited to the wrong
  account.
- **PAY-2 (dust-space collision):** uniqueness relies on `base price + random dust` over a tiny
  1–9999 smallest-unit window. By the birthday bound, only ~**118 concurrent pending orders at
  the same base price** give a ~50% chance two share an `expectedAmount` → ambiguous/incorrect
  attribution.
- **PAY-3 (rounded / overpaid transfers are lost):** exact-amount matching means a transfer that
  is rounded up, batched, or overpaid by any amount never matches any order, so the funds are
  silently stranded and no order is credited.

**Correct fix (owner task — needs key management):** issue a **per-order, HD-derived deposit
address** (BIP-32 from the treasury **xpub**; sweep later) so each order has its own address and
attribution is unambiguous regardless of amount — OR bind the payer's **from-address** to the
order up front (user registers/declares the sending wallet) and require `from == boundPayer`.
Both require the treasury xpub / key-management decision, which is the **owner's** responsibility.
Marked **MUST-FIX-before-real-volume**.

### ⚠️ PRIVACY POSTURE — fingerprinting + IP capture (PRIV-3 / PRIV-7) — owner legal/product decision

The admin tracking described below performs **always-on** canvas/WebGL device fingerprinting
plus IP capture on every security-relevant request. This is intentional (fraud/abuse tracing,
linking multi-account abuse) but there is currently **no consent surface, cookie banner, or
privacy policy** covering it. Depending on user jurisdictions this may trigger GDPR / ePrivacy /
CCPA obligations (fingerprinting is widely treated as personal data / a non-essential cookie
requiring consent). Flagged as a **legal/product decision for the owner** before public launch —
not a code defect.

## Admin panel

- Served at a **non-obvious, env-configured path** (`ADMIN_PATH`, default a random-looking
  slug — *not* `/admin`). Path secrecy is obfuscation, not the control.
- Real control: a separate **admin role** on the account **plus** a second factor —
  an `ADMIN_ACCESS_KEY` and an optional IP allowlist (`ADMIN_IP_ALLOWLIST`).
- Capabilities: list registered users with their emails, **IP addresses**, **browser
  fingerprints**, signup/login history, every scan they ran, payments/orders, and a full
  activity audit trail.

## Tracking captured per request

Stored in `auditLogs` and aggregated onto the user: IP (from `x-forwarded-for` on Vercel),
user-agent, a client **fingerprint** (hashed canvas/WebGL/navigator signals collected in the
browser), event type (`register`, `login`, `login_failed`, `scan`, `order_created`,
`order_paid`, `admin_view`…), timestamp, and event-specific detail.

## Security checklist (enforced in code)

- Passwords hashed with **scrypt** (Node built-in, per-user salt) — never stored plaintext.
- Sessions: server-side records keyed by a **keyed HMAC** (SESSION_SECRET) of an opaque
  256-bit token; httpOnly + Secure + SameSite=strict cookie; TTL expiry + revocation on logout.
  (A DB leak yields no usable cookie — the server-held secret is also required.)
- **CSRF**: SameSite=strict cookies + origin checks on state-changing routes.
- **Rate limiting** on auth + scan + payment endpoints (auth keyed per-IP; scan & payment
  keyed per-account — e.g. scan 20/min, order-create 10/10min, order-verify 30/min). The
  bucket key is unique so concurrent first-hits can't race into duplicate, undercounting buckets.
- Strict input validation (addresses, amounts) with `viem` helpers.
- Secure headers (CSP, HSTS, X-Frame-Options) via middleware.
- Secrets only in env (`.env.local`, Vercel/Render secrets) — never committed.
- Worker requires `X-Worker-Secret`; rejects all else. **The worker now also fails CLOSED at
  boot in production** (PORT set or `NODE_ENV=production`) if the secret is missing/empty, so a
  misconfigured deploy can never expose the engine open (CFG-3).

### Remaining web-side security items (in flight)

Tracked and owned by the **web/** layer (recorded here so the docs reflect reality):

- **SEC-1 — trusted client IP:** the IP used for rate-limiting / audit / admin allowlist must
  come from a **trusted** source (the platform's verified forwarded-for), not a raw
  attacker-controllable `X-Forwarded-For`. Being hardened in `web/lib/request.ts`.
- **SEC-2 — CSP / security headers:** add Content-Security-Policy and the standard hardening
  headers (HSTS, X-Content-Type-Options, Referrer-Policy, frame-ancestors) in the web app.
- **SEC-3 — origin/CSRF defence:** SameSite=strict cookies already block most CSRF; add explicit
  **Origin/Referer** checks on state-changing API routes as defence in depth.

## Repo layout (target)

```
/ (root)            existing scan engine  ─┐ becomes the WORKER
  src/ …                                    │  + Dockerfile.worker (installs Foundry)
  Dockerfile.worker                         │
web/                Next.js app (Vercel) ───┘ the public SERVICE
  app/              routes: landing, auth, dashboard, [adminPath], api/*
  lib/              db, auth, sessions, crypto-pay, worker client, fingerprint
  models/           Mongoose schemas
```

## What I can and cannot do for you

I will build deployment-ready code, Dockerfile, and `.env` templates, and document the exact
deploy steps. I **cannot** provision your Vercel/Render/Atlas accounts or hold your private
keys/treasury — you'll paste those secrets into the hosting dashboards yourself.
