const pool = require('../config/db');
const { redis } = require('../config/redis');
const { getWebhookQueue } = require('../queues/webhookQueue');

// Latency is kept as a bounded sample in Redis: the most recent N
// durations per operation (LPUSH + LTRIM). Shared by every API instance,
// fixed memory, and good enough to read a p95 from. A production system
// would use histograms (Prometheus) instead -- see DECISIONS.md #018.
const SAMPLE_SIZE = 1000;
const NAMES_KEY = 'metrics:latency:names';

function sampleKey(name) {
  return `metrics:latency:${name}`;
}

// Fire-and-forget: recording a metric must never slow down or fail the
// request it's measuring.
function recordLatency(name, ms) {
  redis.multi()
    .sadd(NAMES_KEY, name)
    .lpush(sampleKey(name), Math.round(ms))
    .ltrim(sampleKey(name), 0, SAMPLE_SIZE - 1)
    .exec()
    .catch(() => {});
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

async function latencySummary() {
  const names = await redis.smembers(NAMES_KEY);
  const summary = {};
  for (const name of names.sort()) {
    const values = (await redis.lrange(sampleKey(name), 0, -1)).map(Number).sort((a, b) => a - b);
    summary[name] = {
      samples: values.length,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      p99: percentile(values, 99),
      max: values.length ? values[values.length - 1] : null,
    };
  }
  return summary;
}

async function paymentSummary(hours) {
  const { rows } = await pool.query(
    `SELECT payment_status, COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::text AS amount
     FROM payments
     WHERE created_at > NOW() - make_interval(hours => $1)
     GROUP BY payment_status`,
    [hours]
  );

  const byStatus = {};
  let total = 0;
  for (const r of rows) {
    byStatus[r.payment_status] = { count: r.count, amount: r.amount };
    total += r.count;
  }

  const success = byStatus.SUCCESS?.count || 0;
  const failed = byStatus.FAILED?.count || 0;
  return {
    window_hours: hours,
    total,
    by_status: byStatus,
    // over payments that actually reached an answer -- counting PENDING or
    // INITIATED in the denominator would make the bank look worse than it is
    success_rate: success + failed ? Number((success / (success + failed)).toFixed(4)) : null,
    volume_succeeded: byStatus.SUCCESS?.amount || '0',
  };
}

async function healthSignals() {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM payments
          WHERE payment_status = 'PENDING' AND updated_at < NOW() - interval '15 minutes') AS pending_over_15m,
       (SELECT COUNT(*)::int FROM payments
          WHERE payment_status = 'PROCESSING' AND updated_at < NOW() - interval '2 minutes') AS processing_over_2m,
       (SELECT COUNT(*)::int FROM webhook_deliveries WHERE delivery_status = 'pending') AS webhooks_pending,
       (SELECT COUNT(*)::int FROM webhook_deliveries WHERE delivery_status = 'dead_letter') AS webhooks_dead_letter`
  );
  return rows[0];
}

async function getMetrics({ hours }) {
  const [payments, signals, latency, queue] = await Promise.all([
    paymentSummary(hours),
    healthSignals(),
    latencySummary().catch(() => ({ error: 'redis unavailable' })),
    getWebhookQueue().getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')
      .catch(() => ({ error: 'redis unavailable' })),
  ]);

  return {
    generated_at: new Date().toISOString(),
    payments,
    stuck: {
      pending_over_15m: signals.pending_over_15m,
      processing_over_2m: signals.processing_over_2m,
    },
    webhooks: {
      outbox_pending: signals.webhooks_pending,
      dead_letter: signals.webhooks_dead_letter,
      queue,
    },
    latency_ms: latency,
  };
}

module.exports = { recordLatency, getMetrics, percentile };
