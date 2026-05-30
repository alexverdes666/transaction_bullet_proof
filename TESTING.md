# Testing

Three layers cover the system: engine unit tests, web unit tests, and a full
end-to-end workflow test.

## 1. Engine unit tests (root)

Pure-function tests for the scan engine — verdict scoring, state diffing, unit
formatting, storage-slot derivation. No network or DB.

```bash
npm test
```
Covers: `src/statediff.ts` (verdict/anomaly scoring, balance & storage diff),
`src/util.ts` (formatUnits, jsonSafe, revert-reason extraction), `src/token.ts`
(balance-slot key derivation).

## 2. Web unit tests (web/)

Pure-logic tests for the service layer. `server-only` is aliased to a stub and
dummy env is injected (see `web/vitest.config.ts`).

```bash
cd web && npm test
```
Covers: `lib/password.ts` (scrypt hash/verify, salting), `lib/validation.ts`
(zod schemas), `lib/payments.ts` (pack table, base-unit pricing).

## 3. End-to-end workflow test (web/)

Drives the **running** app over HTTP and asserts the entire journey plus the
security controls. It reads config from `web/.env.local` and cleans up every
record it creates.

Prerequisites — in three terminals:

```bash
# 1. the scan worker (needs Foundry/anvil + a mainnet RPC in the root .env)
WORKER_SHARED_SECRET=$(grep '^WORKER_SHARED_SECRET=' web/.env.local | cut -d= -f2-) npm run server

# 2. the web app (reads web/.env.local: Atlas URI, secrets, admin path…)
cd web && npm run build && npm run start

# 3. the test
cd web && npm run test:workflow
```

The workflow test asserts (33 checks):

- **Auth**: register, duplicate-email rejection, `me`, wrong/right login,
  logout invalidates the session.
- **Paywall**: invalid address rejected, scan blocked at 0 credits (402),
  scan succeeds after credits granted, credits decrement atomically.
- **Payments**: order creation with a server-set price + unique amount, unpaid
  order verifies as `pending`.
- **Live scan**: real fork on the worker returns `SAFE` for mainnet USDC.
- **Admin**: secret path hidden (404) from non-admins, unlock form for admins,
  wrong/right access key, dashboard renders with tracked data, internal route
  blocked.
- **Worker**: rejects missing/wrong shared secret (401), accepts the correct
  one (200) — i.e. the paywall cannot be bypassed.
- **Rate limiting**: repeated failed logins get 429.

> The workflow test uses a real MongoDB and the live scan worker. Keep secrets
> in `web/.env.local` (gitignored) — never commit them.
