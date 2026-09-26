// Background worker entry point -- a separate process from the API server.
//
//   node src/worker.js
//
// Runs:
//   - the webhook delivery worker (BullMQ 'webhooks' queue)
//   - scheduled maintenance: PENDING resolution + outbox sweep
//
// Kept out of the API process so a slow bank lookup or a backlog of
// webhook retries can never eat into the capacity that serves requests,
// and so each can be scaled (or restarted) independently.
require('dotenv').config();

const { Queue, Worker } = require('bullmq');
const pool = require('./config/db');
const { redis, createBullConnection } = require('./config/redis');
const { startWebhookWorker } = require('./jobs/webhookWorker');
const { runPendingResolution } = require('./jobs/pendingResolutionJob');
const { sweepOutbox } = require('./jobs/outboxSweeper');
const { closeWebhookQueue } = require('./queues/webhookQueue');

const MAINTENANCE_QUEUE = 'maintenance';
const RESOLUTION_INTERVAL_MS = Number(process.env.RESOLUTION_INTERVAL_MS) || 30000;
const SWEEP_INTERVAL_MS = Number(process.env.OUTBOX_SWEEP_INTERVAL_MS) || 30000;

const handlers = {
  'resolve-pending': runPendingResolution,
  'sweep-outbox': sweepOutbox,
};

async function main() {
  const webhookWorker = startWebhookWorker();

  // Scheduled via BullMQ rather than setInterval: a job scheduler lives in
  // Redis, so running two worker processes still produces ONE run per
  // interval instead of two workers resolving the same payments at once.
  const schedulerConnection = createBullConnection({ forWorker: true });
  const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection: schedulerConnection });

  // Schedulers live in Redis. If Redis restarts without persistence they
  // are simply gone, and PENDING resolution + outbox sweeping would stop
  // silently. Upserting is idempotent, so re-register on every (re)connect.
  async function ensureSchedulers() {
    const opts = { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } };
    await maintenanceQueue.upsertJobScheduler('resolve-pending', { every: RESOLUTION_INTERVAL_MS }, { name: 'resolve-pending', opts });
    await maintenanceQueue.upsertJobScheduler('sweep-outbox', { every: SWEEP_INTERVAL_MS }, { name: 'sweep-outbox', opts });
  }
  await ensureSchedulers();
  schedulerConnection.on('ready', () => {
    ensureSchedulers().catch((err) => console.error('re-registering schedulers failed:', err.message));
  });

  const maintenanceWorker = new Worker(MAINTENANCE_QUEUE, async (job) => {
    const handler = handlers[job.name];
    if (!handler) throw new Error(`unknown maintenance job: ${job.name}`);
    const summary = await handler();
    const didSomething = Object.values(summary).some((n) => n > 0);
    if (didSomething) console.log(`${job.name}: ${JSON.stringify(summary)}`);
    return summary;
  }, {
    connection: createBullConnection({ forWorker: true }),
    concurrency: 1,
  });

  maintenanceWorker.on('failed', (job, err) => {
    console.error(`maintenance job ${job?.name} failed:`, err.message);
  });

  console.log(`worker started (resolution every ${RESOLUTION_INTERVAL_MS}ms, outbox sweep every ${SWEEP_INTERVAL_MS}ms)`);

  // Graceful shutdown: let in-flight jobs finish instead of killing a
  // webhook mid-send or a resolution mid-transaction.
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`worker received ${signal}, shutting down`);
    await Promise.allSettled([webhookWorker.close(), maintenanceWorker.close()]);
    await Promise.allSettled([maintenanceQueue.close(), closeWebhookQueue()]);
    await Promise.allSettled([pool.end(), redis.quit()]);
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('worker failed to start:', err);
  process.exit(1);
});
