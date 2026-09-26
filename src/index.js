// entry point — loads env vars before anything else touches process.env
require('dotenv').config({ quiet: true });

const app = require('./app');
const logger = require('./lib/logger');
const pool = require('./config/db');
const { redis } = require('./config/redis');
const { closeWebhookQueue } = require('./queues/webhookQueue');

const PORT = process.env.PORT || 3000;
// Longer than the 10s bank timeout, so a /process call that's waiting on
// the bank can finish instead of being cut off mid-payment.
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS) || 20000;

const server = app.listen(PORT, () => {
  logger.info('payment gateway listening', { port: Number(PORT) });
});

// Graceful shutdown. `docker stop` (and every orchestrator) sends SIGTERM,
// waits a grace period, then SIGKILLs. Without this handler Node exits
// immediately -- killing in-flight requests, including a /process that has
// already committed PROCESSING and is waiting on the bank.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown: draining connections', { signal });

  // stop accepting new connections; the callback fires once every
  // connection has closed
  const drained = new Promise((resolve) => server.close(resolve));
  // Nginx keeps pooled keep-alive connections open to us. A connection
  // that finishes its in-flight request AFTER close() was called goes idle
  // and would sit there until Node's keepAliveTimeout (5s) expired -- so
  // keep closing idle sockets while draining, not just once.
  server.closeIdleConnections();
  const idleSweep = setInterval(() => server.closeIdleConnections(), 250);

  const forced = new Promise((resolve) => setTimeout(() => {
    logger.error('shutdown: grace period exceeded, forcing', { grace_ms: SHUTDOWN_GRACE_MS });
    server.closeAllConnections();
    resolve();
  }, SHUTDOWN_GRACE_MS).unref());

  await Promise.race([drained, forced]);
  clearInterval(idleSweep);
  await Promise.allSettled([closeWebhookQueue(), pool.end(), redis.quit()]);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
