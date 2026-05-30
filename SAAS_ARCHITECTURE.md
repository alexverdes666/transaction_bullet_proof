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
- Worker requires `X-Worker-Secret`; rejects all else.

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
