const Redis = require('ioredis');
const logger = require('../lib/logger');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Two kinds of Redis connection, because they want opposite behavior when
// Redis is down:
//
// - Request-path commands (idempotency lock, rate limit, cache) must fail
//   FAST. enableOfflineQueue:false makes a command error immediately instead
//   of queueing until Redis comes back, so a Redis outage degrades to "skip
//   the Redis step" rather than "every request hangs".
//
// - BullMQ workers must WAIT. A worker blocked on "give me the next job"
//   should ride out a Redis restart, not crash — BullMQ requires
//   maxRetriesPerRequest:null for exactly that reason.
function createRequestClient() {
  const client = new Redis(REDIS_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 1000,
  });
  client.on('error', (err) => logger.warn('redis error', { connection: 'request', error: err.message }));
  return client;
}

// Producers (Queue.add) also get enableOfflineQueue:false, per BullMQ's own
// guidance: an enqueue during an outage should fail fast, and the outbox
// sweeper picks the job up later. Workers get the blocking-friendly config.
function createBullConnection({ forWorker = false } = {}) {
  const client = new Redis(REDIS_URL, forWorker
    ? { maxRetriesPerRequest: null }
    : { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  client.on('error', (err) => logger.warn('redis error', {
    connection: forWorker ? 'bull-worker' : 'bull-producer',
    error: err.message,
  }));
  return client;
}

const redis = createRequestClient();

module.exports = { redis, createBullConnection };
