const pool = require('../config/db');
const { redis } = require('../config/redis');
const { getWebhookQueue } = require('../queues/webhookQueue');

const FAKE_BANK_URL = process.env.FAKE_BANK_URL || 'http://localhost:5000';
const CHECK_TIMEOUT_MS = 2000;
const WORKER_HEARTBEAT_KEY = 'workers:heartbeat';
const WORKER_STALE_MS = 30000;

// Every check gets a hard timeout: a health endpoint that hangs because a
// dependency hangs is useless to the load balancer asking it.
function withTimeout(promise, ms = CHECK_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

async function check(fn) {
  const start = Date.now();
  try {
    const detail = await withTimeout(fn());
    return { status: 'ok', latency_ms: Date.now() - start, ...(detail || {}) };
  } catch (err) {
    return { status: 'down', latency_ms: Date.now() - start, error: err.message };
  }
}

// Which dependencies are CRITICAL decides the HTTP status:
//   postgres down      -> 503: no payment can be created or read
//   redis down         -> 200 "degraded": locks/limits/cache fail open
//   bank down          -> 200 "degraded": payments go PENDING, resolved later
//   no live worker     -> 200 "degraded": webhooks + resolution pile up
// A load balancer should only stop sending traffic for the first one.
async function getHealth() {
  // each check returns nothing, or an object of details worth reporting
  const [postgres, redisCheck, bank, workers] = await Promise.all([
    check(async () => { await pool.query('SELECT 1'); }),
    check(async () => { await redis.ping(); }),
    check(async () => {
      const res = await fetch(`${FAKE_BANK_URL}/health`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }),
    check(async () => {
      const alive = await redis.zcount(WORKER_HEARTBEAT_KEY, Date.now() - WORKER_STALE_MS, '+inf');
      if (alive === 0) throw new Error(`no worker heartbeat in the last ${WORKER_STALE_MS / 1000}s`);
      const counts = await getWebhookQueue().getJobCounts('waiting', 'delayed', 'failed');
      return { alive, webhook_queue: counts };
    }),
  ]);

  const components = { postgres, redis: redisCheck, bank, workers };
  let status = 'ok';
  if (postgres.status !== 'ok') status = 'down';
  else if (Object.values(components).some((c) => c.status !== 'ok')) status = 'degraded';

  return { status, components };
}

module.exports = { getHealth, WORKER_HEARTBEAT_KEY };
