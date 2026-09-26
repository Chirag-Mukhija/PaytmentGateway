// Background worker entry point -- a separate process from the API server.
//
//   node src/worker.js
//
// Runs:
//   - the webhook delivery worker (BullMQ 'webhooks' queue)
//   - scheduled maintenance: PENDING resolution + outbox sweep (every 30s)
//     and reconciliation of the previous UTC day (daily, 00:10 UTC)
//
// Kept out of the API process so a slow bank lookup or a backlog of
// webhook retries can never eat into the capacity that serves requests,
// and so each can be scaled (or restarted) independently.
require('dotenv').config({ quiet: true });
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'worker';

const os = require('os');
const { Queue, Worker } = require('bullmq');
const pool = require('./config/db');
const logger = require('./lib/logger');
const { redis, createBullConnection } = require('./config/redis');
const { startWebhookWorker } = require('./jobs/webhookWorker');
const { runPendingResolution } = require('./jobs/pendingResolutionJob');
const { sweepOutbox } = require('./jobs/outboxSweeper');
const { runReconciliation, yesterdayUTC } = require('./jobs/reconciliationJob');
const { closeWebhookQueue } = require('./queues/webhookQueue');
const { WORKER_HEARTBEAT_KEY } = require('./services/healthService');

const HEARTBEAT_INTERVAL_MS = 10000;
const MAINTENANCE_QUEUE = 'maintenance';
const RESOLUTION_INTERVAL_MS = Number(process.env.RESOLUTION_INTERVAL_MS) || 30000;
const SWEEP_INTERVAL_MS = Number(process.env.OUTBOX_SWEEP_INTERVAL_MS) || 30000;
// 00:10 UTC, not 00:00: gives payments decided in the last seconds of the
// day time to finish their second transaction before the day is judged
const RECONCILIATION_CRON = process.env.RECONCILIATION_CRON || '10 0 * * *';

// each handler returns a summary object that gets logged
const handlers = {
  'resolve-pending': runPendingResolution,
  'sweep-outbox': sweepOutbox,
  'reconcile-daily': async () => (await runReconciliation(yesterdayUTC())).summary,
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
    await maintenanceQueue.upsertJobScheduler('reconcile-daily', { pattern: RECONCILIATION_CRON, tz: 'UTC' }, { name: 'reconcile-daily', opts });
  }
  await ensureSchedulers();
  schedulerConnection.on('ready', () => {
    ensureSchedulers().catch((err) => logger.error('re-registering schedulers failed', { error: err.message }));
  });

  const maintenanceWorker = new Worker(MAINTENANCE_QUEUE, (job) => (
    // every log line written while this job runs carries its name and id
    logger.runWithContext({ job: job.name, job_id: job.id }, async () => {
      const handler = handlers[job.name];
      if (!handler) throw new Error(`unknown maintenance job: ${job.name}`);
      const summary = await handler();
      // the 30s jobs only log when they actually did something
      const didSomething = Object.values(summary).some((v) => typeof v === 'number' && v > 0);
      if (didSomething && job.name !== 'reconcile-daily') logger.info('maintenance job did work', summary);
      return summary;
    })
  ), {
    connection: createBullConnection({ forWorker: true }),
    concurrency: 1,
  });

  maintenanceWorker.on('failed', (job, err) => {
    logger.error('maintenance job failed', { job: job?.name, error: err.message });
  });

  // Heartbeat: the API's /health reads this to report whether ANY worker is
  // alive. Without it, a dead worker is invisible -- the API keeps taking
  // payments while webhooks and PENDING resolution silently pile up.
  const workerId = `${os.hostname()}:${process.pid}`;
  async function beat() {
    const now = Date.now();
    await redis.multi()
      .zadd(WORKER_HEARTBEAT_KEY, now, workerId)
      .zremrangebyscore(WORKER_HEARTBEAT_KEY, 0, now - 5 * 60 * 1000)
      .exec();
  }
  const heartbeat = setInterval(() => beat().catch(() => {}), HEARTBEAT_INTERVAL_MS);
  beat().catch(() => {});

  logger.info('worker started', {
    worker_id: workerId,
    resolution_interval_ms: RESOLUTION_INTERVAL_MS,
    sweep_interval_ms: SWEEP_INTERVAL_MS,
    reconciliation_cron: `${RECONCILIATION_CRON} UTC`,
  });

  // Graceful shutdown: let in-flight jobs finish instead of killing a
  // webhook mid-send or a resolution mid-transaction.
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('worker shutting down', { signal });
    clearInterval(heartbeat);
    await redis.zrem(WORKER_HEARTBEAT_KEY, workerId).catch(() => {});
    await Promise.allSettled([webhookWorker.close(), maintenanceWorker.close()]);
    await Promise.allSettled([maintenanceQueue.close(), closeWebhookQueue()]);
    await Promise.allSettled([pool.end(), redis.quit()]);
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('worker failed to start', { err });
  process.exit(1);
});
