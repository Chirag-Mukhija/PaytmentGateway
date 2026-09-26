const { redis } = require('../config/redis');

// Thin cache-aside helpers. Every function fails OPEN: a Redis error is a
// cache miss (or a skipped write), never a failed request. The database is
// always the source of truth, so losing the cache only costs speed.

async function getJSON(key) {
  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

async function setJSON(key, value, ttlSeconds) {
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    // skipped write -- next read is a miss and repopulates
  }
}

async function del(key) {
  try {
    await redis.del(key);
  } catch (err) {
    // TTL will expire it
  }
}

module.exports = { getJSON, setJSON, del };
