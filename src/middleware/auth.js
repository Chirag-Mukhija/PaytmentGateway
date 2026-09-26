const crypto = require('crypto');
const pool = require('../config/db');
const cache = require('../services/cache');

// How long a merchant lookup is reused. This is also the worst-case delay
// between revoking/rotating a key in the DB and it actually stopping
// working -- see DECISIONS.md #016.
const MERCHANT_CACHE_TTL_SECONDS = Number(process.env.MERCHANT_CACHE_TTL_SECONDS) || 30;

// The cache key is a hash of the API key, never the key itself -- anyone
// who can run KEYS * on Redis shouldn't be handed every merchant's secret.
function cacheKeyFor(apiKey) {
  return `merchant_by_key:${crypto.createHash('sha256').update(apiKey).digest('hex')}`;
}

// every /payments request must carry x-api-key. looks up the merchant,
// attaches it to req.merchant so downstream handlers never touch the
// key itself again.
async function auth(req, res, next) {
  const apiKey = req.header('x-api-key'); // this key is for merchant .

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing x-api-key header' });
  }

  const cacheKey = cacheKeyFor(apiKey);
  let merchant = await cache.getJSON(cacheKey);

  if (!merchant) {
    // parameterized ($1), not string-concatenated — same SQL injection
    // reasoning as everywhere else we touch the DB
    const { rows } = await pool.query(
      'SELECT id, name, webhook_url FROM merchants WHERE api_key = $1',
      [apiKey]
    );

    // Invalid keys are deliberately NOT cached: caching misses would let
    // anyone fill Redis with junk entries by sending random keys.
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    merchant = rows[0];
    await cache.setJSON(cacheKey, merchant, MERCHANT_CACHE_TTL_SECONDS);
  }

  req.merchant = merchant;
  next();
}

module.exports = auth;

// ok in the request header itself there is a x-api-key ,which is basically an alternate to what we
// are used to in CRUD app , where we have a session key , which gets verified . here we have this
// api key which is known to merchant only . so this verifies that the request is from this merchant.
