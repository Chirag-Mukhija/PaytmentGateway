// Load test + correctness audit.
//
//   API_KEY=<key> node scripts/loadTest.js
//
// Env: GATEWAY_URL (default http://localhost:3000), TOTAL (1000 payments),
//      CONCURRENCY (50), PROCESS (1: also run /process on each; 0: creates only),
//      DUPLICATES (1: send every create twice at the same moment).
//
// Point it at the gateway directly with the rate limits lifted (see
// docker-compose.loadtest.yml) -- otherwise it measures the limiters.
//
// Speed is half the point. The other half is proving that under load the
// system still never double-creates, never loses a payment, never skips a
// state, and never sends a webhook twice for one transition.
const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY;
const TOTAL = Number(process.env.TOTAL) || 1000;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 50;
const PROCESS = process.env.PROCESS !== '0';
const DUPLICATES = process.env.DUPLICATES !== '0';
const SETTLE_TIMEOUT_MS = Number(process.env.SETTLE_TIMEOUT_MS) || 180000;

if (!API_KEY) {
  console.error('API_KEY env var is required');
  process.exit(1);
}

const run = Date.now().toString(36);

async function call(method, path, body) {
  const start = performance.now();
  try {
    const res = await fetch(`${GATEWAY}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json, ms: performance.now() - start };
  } catch (err) {
    return { status: 'network_error', body: null, ms: performance.now() - start, error: err.message };
  }
}

// run fn over items with at most `limit` in flight
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  return {
    p50: Math.round(pct(50)), p95: Math.round(pct(95)), p99: Math.round(pct(99)), max: Math.round(sorted[sorted.length - 1]),
  };
}

function countBy(values) {
  return values.reduce((acc, v) => ({ ...acc, [v]: (acc[v] || 0) + 1 }), {});
}

function report(label, results, wallMs) {
  const codes = countBy(results.map((r) => r.status));
  const s = stats(results.map((r) => r.ms));
  console.log(`\n${label}: ${results.length} requests in ${(wallMs / 1000).toFixed(1)}s `
    + `= ${(results.length / (wallMs / 1000)).toFixed(0)} req/s`);
  console.log(`  latency ms  p50=${s.p50}  p95=${s.p95}  p99=${s.p99}  max=${s.max}`);
  console.log(`  status codes ${JSON.stringify(codes)}`);
  return { codes, latency: s };
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  console.log(`load test: ${TOTAL} payments, concurrency ${CONCURRENCY}, `
    + `duplicate creates ${DUPLICATES ? 'on' : 'off'}, process ${PROCESS ? 'on' : 'off'} -> ${GATEWAY}`);

  const before = (await call('GET', '/payments?limit=1')).body.total;
  const keys = Array.from({ length: TOTAL }, (_, i) => `lt_${run}_${i}`);

  // ---- creates (each key sent twice at the same instant) ------------------
  let t0 = performance.now();
  const createPairs = await pool(keys, CONCURRENCY, async (key, i) => {
    const body = { idempotency_key: key, amount: 10 + (i % 90) + 0.5 };
    return DUPLICATES
      ? Promise.all([call('POST', '/payments', body), call('POST', '/payments', body)])
      : [await call('POST', '/payments', body)];
  });
  const creates = report('POST /payments', createPairs.flat(), performance.now() - t0);

  const idByKey = new Map();
  let splitKeys = 0;
  createPairs.forEach((pair, i) => {
    const ids = new Set(pair.filter((r) => r.status === 201).map((r) => r.body.id));
    if (ids.size > 1) splitKeys += 1;
    if (ids.size >= 1) idByKey.set(keys[i], [...ids][0]);
  });
  // a duplicate that lost the race gets 409 "in progress" -- it has no id,
  // so fetch the winner's payment by retrying once the lock is released
  for (const [i, key] of keys.entries()) {
    if (idByKey.has(key)) continue;
    const retry = await call('POST', '/payments', { idempotency_key: key, amount: 10 + (i % 90) + 0.5 });
    if (retry.status === 201) idByKey.set(key, retry.body.id);
  }

  const after = (await call('GET', '/payments?limit=1')).body.total;
  check('no 5xx or network errors on create', Object.keys(creates.codes).every((c) => c === '201' || c === '409'));
  check('each idempotency key produced exactly one payment id', splitKeys === 0, `${splitKeys} keys split`);
  check('rows created == keys sent (no duplicates, nothing lost)', after - before === TOTAL,
    `${after - before} new rows for ${TOTAL} keys, ${createPairs.flat().length} create requests`);

  const ids = [...idByKey.values()];
  if (!PROCESS) return finish();

  // ---- process -------------------------------------------------------------
  t0 = performance.now();
  const processed = await pool(ids, CONCURRENCY, (id) => call('POST', `/payments/${id}/process`));
  const proc = report('POST /payments/:id/process', processed, performance.now() - t0);
  check('no 5xx or network errors on process', Object.keys(proc.codes).every((c) => c === '200'));
  const firstStatus = countBy(processed.map((r) => r.body?.payment_status));
  console.log(`  immediate outcomes ${JSON.stringify(firstStatus)}`);

  // ---- settle: wait for the worker to resolve every PENDING payment -------
  console.log(`\nwaiting for PENDING payments to resolve (worker) ...`);
  t0 = Date.now();
  let payments = [];
  for (;;) {
    payments = (await pool(ids, CONCURRENCY, (id) => call('GET', `/payments/${id}`))).map((r) => r.body);
    const open = payments.filter((p) => !['SUCCESS', 'FAILED'].includes(p.payment_status)).length;
    if (open === 0 || Date.now() - t0 > SETTLE_TIMEOUT_MS) break;
    process.stdout.write(`  ${open} still open after ${Math.round((Date.now() - t0) / 1000)}s\n`);
    await new Promise((r) => setTimeout(r, 10000));
  }
  const finalStatus = countBy(payments.map((p) => p.payment_status));
  console.log(`  final outcomes ${JSON.stringify(finalStatus)} after ${Math.round((Date.now() - t0) / 1000)}s`);

  // ---- audit ---------------------------------------------------------------
  check('every payment reached a terminal status', (finalStatus.SUCCESS || 0) + (finalStatus.FAILED || 0) === ids.length);

  const brokenChains = payments.filter((p) => {
    const e = p.events;
    if (!e.length || e[0].from_status !== null) return true;
    return e.some((ev, i) => i > 0 && ev.from_status !== e[i - 1].to_status);
  }).length;
  check('every event chain is unbroken (no skipped or duplicated transitions)', brokenChains === 0, `${brokenChains} broken`);

  const webhookCounts = payments.map((p) => p.webhooks.length);
  check('exactly one webhook per terminal payment', webhookCounts.every((n) => n === 1),
    JSON.stringify(countBy(webhookCounts)));

  // webhooks are delivered asynchronously; give the worker a moment
  t0 = Date.now();
  let undelivered;
  for (;;) {
    payments = (await pool(ids, CONCURRENCY, (id) => call('GET', `/payments/${id}`))).map((r) => r.body);
    undelivered = payments.filter((p) => p.webhooks[0]?.delivery_status !== 'delivered').length;
    if (undelivered === 0 || Date.now() - t0 > 60000) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  check('every webhook delivered', undelivered === 0, `${undelivered} not delivered`);

  const successAmountsOk = payments.every((p) => p.payment_status !== 'SUCCESS' || p.bank_reference);
  check('every SUCCESS has a bank_reference', successAmountsOk);

  return finish();
}

function finish() {
  console.log(`\n${failures === 0 ? 'ZERO DATA CORRUPTION -- ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
