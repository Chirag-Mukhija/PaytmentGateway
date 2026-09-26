const crypto = require('crypto');
const { redis } = require('../config/redis');

const LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE) || 100;
const WINDOW_MS = 60 * 1000;

// Sliding-window LOG: one sorted-set entry per accepted request, scored by
// its timestamp. To decide, drop entries older than the window and count
// what's left. Everything happens in one Lua script, so two concurrent
// requests can't both read "99" and both get in.
//
// Time comes from Redis (TIME), not Date.now(): with several API instances,
// each one's clock drifts a little -- using the one clock they all share
// keeps the window consistent.
//
// Returns { allowed (1/0), count, retryAfterMs }.
const SLIDING_WINDOW_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])

redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)
local count = redis.call('ZCARD', KEYS[1])

if count < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], window)
  return {1, count + 1, 0}
end

local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return {0, count, tonumber(oldest[2]) + window - now}
`;

async function rateLimiter(req, res, next) {
  const key = `rate_limit:${req.merchant.id}`;

  let result;
  try {
    // member must be unique per request, or two requests in the same
    // millisecond would collapse into one entry and be under-counted
    result = await redis.eval(SLIDING_WINDOW_SCRIPT, 1, key, WINDOW_MS, LIMIT, crypto.randomUUID());
  } catch (err) {
    // Fail open: a Redis outage must not take payments down with it.
    // Rate limiting protects capacity; it is not a correctness guarantee.
    console.error('rate limiter unavailable, allowing request:', err.message);
    return next();
  }

  const [allowed, count, retryAfterMs] = result;
  res.setHeader('X-RateLimit-Limit', LIMIT);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, LIMIT - count));

  if (!allowed) {
    const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({ error: 'Rate limit exceeded', retry_after_seconds: retryAfter });
  }

  next();
}

module.exports = rateLimiter;
