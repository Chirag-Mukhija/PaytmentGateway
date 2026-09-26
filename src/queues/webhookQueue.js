const { Queue } = require('bullmq');
const { createBullConnection } = require('../config/redis');

const WEBHOOK_QUEUE = 'webhooks';
const MAX_ATTEMPTS = Number(process.env.WEBHOOK_MAX_ATTEMPTS) || 5;
const BACKOFF_MS = Number(process.env.WEBHOOK_BACKOFF_MS) || 2000;

let queue;

// Created lazily so that requiring this module (e.g. from a test or the
// API process before first use) doesn't open a Redis connection.
function getWebhookQueue() {
  if (!queue) {
    queue = new Queue(WEBHOOK_QUEUE, {
      connection: createBullConnection(),
      defaultJobOptions: {
        attempts: MAX_ATTEMPTS,
        // 2s, 4s, 8s, 16s between attempts -- a merchant that's down for a
        // few seconds recovers quickly, one that's down for minutes isn't
        // hammered while it's struggling
        backoff: { type: 'exponential', delay: BACKOFF_MS },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }
  return queue;
}

// jobId = the outbox row's id. Enqueueing the same delivery twice (the
// request's fast path AND the sweeper) is then a no-op instead of a
// duplicate job -- BullMQ ignores add() for a jobId that already exists.
async function enqueueDelivery(deliveryId) {
  await getWebhookQueue().add('deliver', { deliveryId }, { jobId: deliveryId });
}

// Fast path, called right after the transaction that created the outbox
// row commits. Failure here is fine: the row is already durable in
// Postgres, and the outbox sweeper will enqueue it on its next pass.
async function tryEnqueueDelivery(deliveryId) {
  if (!deliveryId) return;
  try {
    await enqueueDelivery(deliveryId);
  } catch (err) {
    console.error(`webhook enqueue failed for ${deliveryId} (sweeper will retry):`, err.message);
  }
}

async function closeWebhookQueue() {
  if (queue) await queue.close();
}

module.exports = {
  WEBHOOK_QUEUE,
  MAX_ATTEMPTS,
  getWebhookQueue,
  enqueueDelivery,
  tryEnqueueDelivery,
  closeWebhookQueue,
};
