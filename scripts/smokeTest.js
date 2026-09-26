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

async function call(method, path, { body, key = API_KEY, headers = {} } = {}) {
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
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, headers: res.headers, body: json };
}

const key = (label) => `smoke_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

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

  const webhooks = await fetch(`${MERCHANT}/webhooks`).then((r) => r.json()).catch(() => null);
  if (webhooks) {
    const delivered = new Set(webhooks.webhooks.map((w) => w.payload.payment_id));
    const terminal = [];
    for (const id of ids) {
      const p = await call('GET', `/payments/${id}`);
      if (['SUCCESS', 'FAILED'].includes(p.body.payment_status)) terminal.push(id);
    }
    const missing = terminal.filter((id) => !delivered.has(id));
    check('merchant-mock received a webhook for every SUCCESS/FAILED payment',
      missing.length === 0, `${terminal.length - missing.length}/${terminal.length}`);
  } else {
    console.log('SKIP  webhook delivery check (merchant-mock not reachable)');
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
