const { Worker, UnrecoverableError } = require('bullmq');
const pool = require('../config/db');
const { createBullConnection } = require('../config/redis');
const { WEBHOOK_QUEUE } = require('../queues/webhookQueue');
const { sendSignedWebhook } = require('../services/webhookService');

// One job = one attempt at one outbox row. The DB row, not the BullMQ job,
// is the source of truth for whether a delivery happened: jobs get trimmed
// from Redis, rows don't.
async function processWebhookJob(job) {
  const { deliveryId } = job.data;
  const attempt = job.attemptsMade + 1;

  const { rows } = await pool.query(
    `SELECT d.id, d.payload, d.delivery_status, m.webhook_url, m.webhook_secret
     FROM webhook_deliveries d
     JOIN merchants m ON m.id = d.merchant_id
     WHERE d.id = $1`,
    [deliveryId]
  );
  const delivery = rows[0];

  // already delivered or dead-lettered by an earlier job -- nothing to do
  if (!delivery || delivery.delivery_status !== 'pending') return 'skipped';

  if (!delivery.webhook_url) {
    await markDelivery(deliveryId, 'dead_letter', attempt, 'merchant has no webhook_url');
    // UnrecoverableError: retrying can't fix a missing URL, so don't
    throw new UnrecoverableError('merchant has no webhook_url');
  }

  try {
    await sendSignedWebhook({
      deliveryId,
      webhookUrl: delivery.webhook_url,
      secret: delivery.webhook_secret,
      payload: delivery.payload,
    });
  } catch (err) {
    const isFinalAttempt = attempt >= job.opts.attempts;
    await markDelivery(deliveryId, isFinalAttempt ? 'dead_letter' : 'pending', attempt, err.message);
    throw err; // hands the retry decision (and backoff delay) to BullMQ
  }

  await markDelivery(deliveryId, 'delivered', attempt, null);
  return 'delivered';
}

async function markDelivery(deliveryId, status, attempts, lastError) {
  await pool.query(
    `UPDATE webhook_deliveries
     SET delivery_status = $2,
         attempts = $3,
         last_error = $4,
         delivered_at = CASE WHEN $2 = 'delivered' THEN NOW() ELSE delivered_at END,
         updated_at = NOW()
     WHERE id = $1`,
    [deliveryId, status, attempts, lastError]
  );
}

function startWebhookWorker() {
  const worker = new Worker(WEBHOOK_QUEUE, processWebhookJob, {
    connection: createBullConnection({ forWorker: true }),
    concurrency: Number(process.env.WEBHOOK_CONCURRENCY) || 10,
  });

  worker.on('failed', (job, err) => {
    if (!job) return;
    const final = job.attemptsMade >= job.opts.attempts || err instanceof UnrecoverableError;
    console.error(
      `webhook ${job.data.deliveryId} attempt ${job.attemptsMade}/${job.opts.attempts} failed: ${err.message}`
      + (final ? ' -> dead_letter' : ' -> will retry')
    );
  });

  return worker;
}

module.exports = { startWebhookWorker, processWebhookJob };
