const pool = require('../config/db');
const { getWebhookQueue, enqueueDelivery } = require('../queues/webhookQueue');

// Only rows older than this -- younger ones are almost certainly still on
// their way through the request's own fast-path enqueue.
const SWEEP_MIN_AGE_SECONDS = Number(process.env.OUTBOX_SWEEP_MIN_AGE_SECONDS) || 30;
const SWEEP_BATCH = 200;

// The safety net behind the outbox. A row can be 'pending' with no job in
// the queue if the process crashed between COMMIT and enqueue, or Redis
// was down at that moment. This finds those and enqueues them.
//
// It also reconciles one other case: a job that exhausted its retries but
// whose process died before marking the row dead_letter.
async function sweepOutbox() {
  const summary = { enqueued: 0, alreadyQueued: 0, deadLettered: 0 };
  const queue = getWebhookQueue();

  const { rows } = await pool.query(
    `SELECT id FROM webhook_deliveries
     WHERE delivery_status = 'pending'
       AND created_at < NOW() - make_interval(secs => $1)
     ORDER BY created_at
     LIMIT $2`,
    [SWEEP_MIN_AGE_SECONDS, SWEEP_BATCH]
  );

  for (const { id } of rows) {
    const job = await queue.getJob(id);

    if (!job) {
      await enqueueDelivery(id);
      summary.enqueued += 1;
      continue;
    }

    const state = await job.getState();
    if (state === 'failed' && job.attemptsMade >= job.opts.attempts) {
      await pool.query(
        `UPDATE webhook_deliveries
         SET delivery_status = 'dead_letter', updated_at = NOW()
         WHERE id = $1 AND delivery_status = 'pending'`,
        [id]
      );
      summary.deadLettered += 1;
    } else if (state === 'completed') {
      // job finished but the row never got marked -- the DB update after a
      // send must have failed. Deliver again (at-least-once; merchants
      // dedupe on X-Webhook-Id).
      await job.remove();
      await enqueueDelivery(id);
      summary.enqueued += 1;
    } else {
      summary.alreadyQueued += 1; // waiting, delayed (backing off), or active
    }
  }

  return summary;
}

module.exports = { sweepOutbox };
