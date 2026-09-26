const crypto = require('crypto');
const { redis } = require('../config/redis');

const LOCK_TTL_SECONDS = 10;

// Only delete the lock if it still holds OUR token. A plain DEL has a real
// bug: if this request ran longer than the TTL, the lock already expired,
// another request acquired it, and our DEL would release THEIR lock. GET +
// compare + DEL must happen atomically, which is what a Lua script gives
// you -- Redis runs a script as one uninterruptible step.
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

function lockKey(merchantId, idempotencyKey) {
  return `idempotency_lock:${merchantId}:${idempotencyKey}`;
}

// Returns a token if we got the lock, null if another request holds it.
// Throws if Redis itself is unreachable -- the caller decides what that means.
async function acquireLock(merchantId, idempotencyKey) {
  const token = crypto.randomUUID();
  // SET ... NX EX: set only if the key does not exist, with an expiry, in
  // one atomic command. The expiry is what stops a crashed request from
  // holding the lock forever.
  const result = await redis.set(lockKey(merchantId, idempotencyKey), token, 'EX', LOCK_TTL_SECONDS, 'NX');
  return result === 'OK' ? token : null;
}

async function releaseLock(merchantId, idempotencyKey, token) {
  try {
    await redis.eval(RELEASE_SCRIPT, 1, lockKey(merchantId, idempotencyKey), token);
  } catch (err) {
    // the TTL will clean it up; never fail a request over lock cleanup
    console.error('idempotency lock release failed:', err.message);
  }
}

module.exports = { acquireLock, releaseLock, LOCK_TTL_SECONDS };
