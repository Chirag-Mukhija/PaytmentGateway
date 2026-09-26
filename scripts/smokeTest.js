// End-to-end smoke test against a running gateway + fake bank + merchant-mock.
//
//   API_KEY=<merchant key> node scripts/smokeTest.js
//
// Optional env: GATEWAY_URL (default http://localhost:3000),
// MERCHANT_URL (default http://localhost:4000), RUNS (default 20).
const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:3000';
const MERCHANT = process.env.MERCHANT_URL || 'http://localhost:4000';
const API_KEY = process.env.API_KEY;
const RUNS = Number(process.env.RUNS) || 20;

if (!API_KEY) {
  console.error('API_KEY env var is required');
  process.exit(1);
}

let failures = 0;
function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!condition) failures += 1;
}

let rateLimitWaits = 0;

// Behaves like a well-mannered client: on 429 it waits for Retry-After and
// tries again. The smoke test sends more than the default 100 req/min from
// one merchant, so without this it would trip the limiter it's testing
// around. (Run the gateway with a higher RATE_LIMIT_PER_MINUTE to avoid
// the waits.)
async function call(method, path, { body, key = API_KEY, headers = {} } = {}) {
  for (;;) {
    const res = await fetch(`${GATEWAY}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'x-api-key': key } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (res.status === 429) {
      rateLimitWaits += 1;
      await new Promise((r) => setTimeout(r, Number(res.headers.get('retry-after') || 1) * 1000));
      continue;
    }
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, headers: res.headers, body: json };
  }
}

const key = (label) => `smoke_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

async function waitFor(fn, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// every payment's event log must be one unbroken chain starting from NULL
function eventsAreContiguous(events) {
  if (!events.length || events[0].from_status !== null) return false;
  for (let i = 1; i < events.length; i += 1) {
    if (events[i].from_status !== events[i - 1].to_status) return false;
  }
  return true;
}

async function main() {
  console.log(`\n== Phase 1: auth, validation, create, idempotency, reads ==`);

  check('missing api key -> 401', (await call('GET', '/payments', { key: null })).status === 401);
  check('invalid api key -> 401', (await call('GET', '/payments', { key: 'nope' })).status === 401);
  check('missing amount -> 400',
    (await call('POST', '/payments', { body: { idempotency_key: key('bad') } })).status === 400);
  check('negative amount -> 400',
    (await call('POST', '/payments', { body: { idempotency_key: key('bad'), amount: -5 } })).status === 400);

  const idem = key('create');
  const created = await call('POST', '/payments', { body: { idempotency_key: idem, amount: 499.5 } });
  check('create -> 201 INITIATED', created.status === 201 && created.body.payment_status === 'INITIATED',
    `status=${created.status}`);

  const replay = await call('POST', '/payments', { body: { idempotency_key: idem, amount: 499.5 } });
  check('same idempotency key -> same payment back', replay.body.id === created.body.id);
  check('replay carries X-Idempotent-Replay header', replay.headers.get('x-idempotent-replay') === 'true');

  const fetched = await call('GET', `/payments/${created.body.id}`);
  check('GET /payments/:id -> 200 with 1 event', fetched.status === 200 && fetched.body.events.length === 1);

  const listed = await call('GET', '/payments?limit=5');
  check('GET /payments -> list', listed.status === 200 && Array.isArray(listed.body.payments));

  console.log(`\n== Phase 2: state machine via POST /payments/:id/process ==`);

  const processed = await call('POST', `/payments/${created.body.id}/process`);
  check('process -> 200 with non-INITIATED status', processed.status === 200
    && ['SUCCESS', 'FAILED', 'PENDING'].includes(processed.body.payment_status),
  `status=${processed.body.payment_status}`);

  const again = await call('POST', `/payments/${created.body.id}/process`);
  check('processing twice -> 409', again.status === 409, `got ${again.status}`);

  const tally = { SUCCESS: 0, FAILED: 0, PENDING: 0, OTHER: 0 };
  const ids = [];
  await Promise.all(Array.from({ length: RUNS }, async (_, i) => {
    const p = await call('POST', '/payments', { body: { idempotency_key: key(`run${i}`), amount: 100 + i } });
    const r = await call('POST', `/payments/${p.body.id}/process`);
    ids.push(p.body.id);
    tally[r.body.payment_status] !== undefined ? tally[r.body.payment_status] += 1 : tally.OTHER += 1;
  }));
  console.log(`      ${RUNS} runs -> ${JSON.stringify(tally)}`);
  check('no payment left in an unexpected status', tally.OTHER === 0);

  let contiguous = true;
  for (const id of ids) {
    const p = await call('GET', `/payments/${id}`);
    if (!eventsAreContiguous(p.body.events)) contiguous = false;
  }
  check('every payment has an unbroken event chain (no skipped status)', contiguous);

  // Since Phase 3 delivery is asynchronous (outbox -> queue -> worker), so
  // poll instead of expecting the webhook to have landed already.
  const terminal = [];
  for (const id of ids) {
    const p = await call('GET', `/payments/${id}`);
    if (['SUCCESS', 'FAILED'].includes(p.body.payment_status)) terminal.push(id);
  }
  const reachable = await fetch(`${MERCHANT}/health`).then((r) => r.ok).catch(() => false);
  if (reachable) {
    let missing = terminal;
    await waitFor(async () => {
      const webhooks = await fetch(`${MERCHANT}/webhooks`).then((r) => r.json());
      const delivered = new Set(webhooks.webhooks.map((w) => w.payload.payment_id));
      missing = terminal.filter((id) => !delivered.has(id));
      return missing.length === 0;
    }, 30000);
    check('merchant-mock received a webhook for every SUCCESS/FAILED payment',
      missing.length === 0, `${terminal.length - missing.length}/${terminal.length}`);
  } else {
    console.log('SKIP  webhook delivery check (merchant-mock not reachable)');
  }

  console.log(`\n== Phase 3: idempotency lock, outbox, resolution ==`);

  const sharedKey = key('concurrent');
  const burst = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/payments', {
    body: { idempotency_key: sharedKey, amount: 250 },
  })));
  const burstIds = new Set(burst.filter((r) => r.status === 201).map((r) => r.body.id));
  const burstCodes = burst.map((r) => r.status);
  check('10 concurrent creates with one key -> exactly one payment', burstIds.size === 1,
    `codes=${[...new Set(burstCodes)].join(',')}`);
  check('...and no 500s among them', burstCodes.every((c) => c === 201 || c === 409));

  const mismatch = await call('POST', '/payments', { body: { idempotency_key: sharedKey, amount: 999 } });
  check('same key, different amount -> 422', mismatch.status === 422, `got ${mismatch.status}`);

  check('3 decimal places -> 400',
    (await call('POST', '/payments', { body: { idempotency_key: key('dec'), amount: 10.005 } })).status === 400);
  check('non-UUID id -> 404 (not 500)', (await call('GET', '/payments/not-a-uuid')).status === 404);

  const filtered = await call('GET', '/payments?status=SUCCESS&limit=2');
  check('list filters by status and reports total', filtered.status === 200
    && typeof filtered.body.total === 'number'
    && filtered.body.payments.every((p) => p.payment_status === 'SUCCESS'));

  const sample = await call('GET', `/payments/${ids[0]}`);
  check('events carry a reason for bank-driven transitions',
    sample.body.events.slice(2).every((e) => e.reason), JSON.stringify(sample.body.events.map((e) => e.reason)));

  if (terminal.length) {
    const delivered = await waitFor(async () => {
      const p = await call('GET', `/payments/${terminal[0]}`);
      return p.body.webhooks.length === 1 && p.body.webhooks[0].delivery_status === 'delivered' ? p : null;
    }, 30000);
    check('outbox row for a terminal payment ends up delivered', Boolean(delivered));
  }

  console.log(`\n== Phase 4: rate limit headers, cache, metrics ==`);

  const limited = await call('GET', '/payments?limit=1');
  check('responses carry X-RateLimit-Limit / Remaining',
    limited.headers.get('x-ratelimit-limit') !== null && limited.headers.get('x-ratelimit-remaining') !== null);

  // The /process response is built on the uncached path (and warms the
  // cache if terminal), so comparing it to a later GET compares MISS vs HIT.
  let uncached = null;
  for (let i = 0; i < 5 && !uncached; i += 1) {
    const p = await call('POST', '/payments', { body: { idempotency_key: key('cache'), amount: 77 } });
    const r = await call('POST', `/payments/${p.body.id}/process`);
    if (['SUCCESS', 'FAILED'].includes(r.body.payment_status)) uncached = r.body;
  }
  if (uncached) {
    const cached = await call('GET', `/payments/${uncached.id}`);
    check('terminal payment: GET after processing is served from cache', cached.headers.get('x-cache') === 'HIT');
    check('cached response matches the uncached one field-for-field (webhooks excluded, they are live)',
      JSON.stringify({ ...uncached, webhooks: null }) === JSON.stringify({ ...cached.body, webhooks: null }));
  } else {
    console.log('SKIP  cache equality check (5 payments in a row went PENDING)');
  }

  const fresh = await call('POST', '/payments', { body: { idempotency_key: key('nocache'), amount: 5 } });
  await call('GET', `/payments/${fresh.body.id}`);
  const freshAgain = await call('GET', `/payments/${fresh.body.id}`);
  check('non-terminal payment is never served from cache', freshAgain.headers.get('x-cache') === 'MISS');

  const noToken = await fetch(`${GATEWAY}/metrics`, { headers: { 'x-api-key': API_KEY } });
  check('/metrics rejects a merchant API key', [401, 404].includes(noToken.status), `got ${noToken.status}`);

  if (process.env.ADMIN_TOKEN) {
    const metrics = await fetch(`${GATEWAY}/metrics`, { headers: { 'x-admin-token': process.env.ADMIN_TOKEN } })
      .then((r) => r.json());
    check('/metrics reports success rate and p95 latency',
      typeof metrics.payments.success_rate === 'number'
      && metrics.latency_ms['POST /payments/:id/process']?.p95 !== undefined,
      `success_rate=${metrics.payments.success_rate} p95(process)=${metrics.latency_ms['POST /payments/:id/process']?.p95}`);
  } else {
    console.log('SKIP  /metrics content check (set ADMIN_TOKEN to run it)');
  }

  if (rateLimitWaits) console.log(`\n(waited out the rate limiter ${rateLimitWaits} time(s))`);
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
