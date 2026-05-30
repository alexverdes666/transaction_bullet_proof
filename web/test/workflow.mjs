/**
 * End-to-end workflow test. Drives the RUNNING app over HTTP (and the DB
 * directly to simulate things we can't do live, like an on-chain payment),
 * asserting the whole user journey + security controls.
 *
 * Prereqs (started separately): the Next app on BASE_URL and the scan worker.
 * Reads config from web/.env.local. Cleans up all data it creates.
 *
 *   node test/workflow.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MongoClient } from 'mongodb';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- load .env.local -------------------------------------------------------
function loadEnv() {
  const txt = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
  const env = {};
  for (const line of txt.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const E = loadEnv();
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const WORKER = E.WORKER_URL || 'http://127.0.0.1:8645';
const WORKER_SECRET = E.WORKER_SHARED_SECRET;
const ADMIN_PATH = E.ADMIN_PATH;
const ADMIN_KEY = E.ADMIN_ACCESS_KEY;
const URI = E.MONGODB_URI;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

const EMAIL = `wftest_${Date.now()}@example.com`;
const PASSWORD = 'StrongPassw0rd!';

// --- cookie jar ------------------------------------------------------------
const jar = new Map();
function absorb(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim();
    const val = pair.slice(i + 1).trim();
    if (val === '' || c.includes('Max-Age=0') || c.includes('Expires=Thu, 01 Jan 1970')) jar.delete(name);
    else jar.set(name, val);
  }
}
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
async function http(method, path, body, base = BASE) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(jar.size ? { cookie: cookieHeader() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  absorb(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

// --- assertion harness -----------------------------------------------------
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const db = new MongoClient(URI);

async function main() {
  await db.connect();
  const D = db.db();
  console.log(`\nWorkflow test against ${BASE}\n`);

  // 1. landing
  let r = await http('GET', '/');
  check('1. landing page loads (200)', r.status === 200, `got ${r.status}`);

  // 2. register
  r = await http('POST', '/api/auth/register', { email: EMAIL, password: PASSWORD });
  check('2. register succeeds (200, ok)', r.status === 200 && r.json?.ok === true, `got ${r.status}`);
  check('2b. session cookie set', jar.has('bp_session'));

  // 3. duplicate register
  r = await http('POST', '/api/auth/register', { email: EMAIL, password: PASSWORD });
  check('3. duplicate register rejected (409)', r.status === 409, `got ${r.status}`);

  // 4. me
  r = await http('GET', '/api/auth/me');
  check('4. me returns user with 0 credits', r.json?.user?.email === EMAIL && r.json?.user?.credits === 0);

  // 5. login wrong password
  r = await http('POST', '/api/auth/login', { email: EMAIL, password: 'WRONGpassword1' });
  check('5. wrong password rejected (401)', r.status === 401, `got ${r.status}`);

  // 6. login correct
  r = await http('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  check('6. correct login succeeds (200)', r.status === 200 && r.json?.ok === true, `got ${r.status}`);

  // 7. scan invalid address
  r = await http('POST', '/api/scan', { token: '0x1234' });
  check('7. invalid address rejected (400)', r.status === 400, `got ${r.status}`);

  // 8. scan with no credits
  r = await http('POST', '/api/scan', { token: USDC });
  check('8. scan blocked without credits (402)', r.status === 402, `got ${r.status}`);

  // 9. create order
  r = await http('POST', '/api/orders', { packId: 'starter' });
  const order = r.json?.order;
  const amt = order ? Number(order.amount) : 0;
  check('9. order created (200)', r.status === 200 && !!order, `got ${r.status}`);
  check('9b. order credits = 10', order?.credits === 10);
  check('9c. unique amount (5_000_001..5_009_999)', amt >= 5_000_001 && amt <= 5_009_999, `amt=${amt}`);
  check('9d. treasury + reference present', !!order?.treasury && !!order?.reference);

  // 10. verify order (no payment yet)
  if (order) {
    r = await http('GET', `/api/orders/${order.id}`);
    check('10. unpaid order verifies as pending', r.json?.status === 'pending', `got ${r.json?.status}`);
  }

  // 11. simulate a confirmed payment by granting credits directly
  await D.collection('users').updateOne({ email: EMAIL }, { $set: { credits: 3 } });
  check('11. granted 3 credits (DB)', true);

  // 12 + 13. real scans (worker does a live fork) + atomic decrement
  r = await http('POST', '/api/scan', { token: USDC });
  check('12. scan USDC succeeds (200)', r.status === 200, `got ${r.status} ${r.json?.error ?? ''}`);
  check('12b. verdict SAFE for USDC', r.json?.report?.verdict === 'SAFE', `got ${r.json?.report?.verdict}`);
  check('12c. creditsRemaining = 2', r.json?.creditsRemaining === 2, `got ${r.json?.creditsRemaining}`);

  r = await http('POST', '/api/scan', { token: USDC });
  check('13. second scan decrements to 1', r.json?.creditsRemaining === 1, `got ${r.json?.creditsRemaining}`);

  // 14. admin secret path as a normal user -> hidden (404)
  r = await http('GET', `/${ADMIN_PATH}`);
  check('14. admin path hidden from normal user (404)', r.status === 404, `got ${r.status}`);

  // 15. promote to admin
  await D.collection('users').updateOne({ email: EMAIL }, { $set: { role: 'admin' } });
  check('15. promoted to admin (DB)', true);

  // 16. admin path, locked (no key) -> unlock form (200)
  r = await http('GET', `/${ADMIN_PATH}`);
  check('16. admin sees unlock form (200)', r.status === 200 && /Restricted|access key/i.test(r.text), `got ${r.status}`);

  // 17. unlock with wrong key
  r = await http('POST', '/api/admin/unlock', { key: 'definitely-wrong' });
  check('17. wrong admin key rejected (401)', r.status === 401, `got ${r.status}`);

  // 18. unlock with correct key
  r = await http('POST', '/api/admin/unlock', { key: ADMIN_KEY });
  check('18. correct admin key accepted (200)', r.status === 200 && r.json?.ok === true, `got ${r.status}`);
  check('18b. admin key cookie set', jar.has('bp_admin_key'));

  // 19. admin dashboard renders with data
  r = await http('GET', `/${ADMIN_PATH}`);
  check('19. admin dashboard renders', r.status === 200 && /Control Panel/i.test(r.text), `got ${r.status}`);
  check('19b. dashboard shows the test user', r.text.includes(EMAIL));

  // 20. internal route blocked directly
  r = await http('GET', '/control-internal');
  check('20. /control-internal blocked directly (404)', r.status === 404, `got ${r.status}`);

  // 21 + 22. worker secret enforcement
  let wr = await fetch(`${WORKER}/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: USDC }) });
  check('21. worker rejects missing secret (401)', wr.status === 401, `got ${wr.status}`);
  wr = await fetch(`${WORKER}/scan`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-worker-secret': WORKER_SECRET }, body: JSON.stringify({ token: USDC }) });
  check('22. worker accepts correct secret (200)', wr.status === 200, `got ${wr.status}`);

  // 23. logout invalidates session
  r = await http('POST', '/api/auth/logout');
  check('23. logout succeeds (200)', r.status === 200);
  r = await http('GET', '/api/auth/me');
  check('23b. session destroyed (me -> null)', r.json?.user === null, `got ${JSON.stringify(r.json)}`);

  // 24. rate limiting on login
  let limited = false;
  for (let i = 0; i < 14; i++) {
    const rr = await http('POST', '/api/auth/login', { email: EMAIL, password: 'WRONGpassword1' });
    if (rr.status === 429) { limited = true; break; }
  }
  check('24. login rate-limited after repeated failures (429)', limited);

  // --- cleanup -------------------------------------------------------------
  const user = await D.collection('users').findOne({ email: EMAIL });
  if (user) {
    const uid = user._id;
    await D.collection('users').deleteOne({ _id: uid });
    await D.collection('sessions').deleteMany({ userId: uid });
    await D.collection('scans').deleteMany({ userId: uid });
    await D.collection('orders').deleteMany({ userId: uid });
    await D.collection('auditlogs').deleteMany({ $or: [{ userId: uid }, { email: EMAIL }] });
  }
  await D.collection('ratelimits').deleteMany({ key: { $regex: 'login|register|scan|admin|order|verify' } });
  console.log('\n  (cleaned up test data)');

  await db.close();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail) { console.log('FAILURES:\n - ' + failures.join('\n - ')); process.exit(1); }
}

main().catch(async (e) => {
  console.error('workflow test crashed:', e);
  try { await db.close(); } catch {}
  process.exit(1);
});
