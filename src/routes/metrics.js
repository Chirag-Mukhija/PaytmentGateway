const crypto = require('crypto');
const express = require('express');
const { getMetrics } = require('../services/metricsService');
const { captureRouteBase } = require('../middleware/requestMetrics');

const router = express.Router();
router.use(captureRouteBase);

// Metrics describe the whole gateway (every merchant's volume), so a
// merchant API key must NOT grant access. It's an operator endpoint,
// guarded by a separate admin token -- and if no token is configured the
// endpoint doesn't exist at all (secure default).
function adminOnly(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return res.status(404).json({ error: 'Not found' });

  const given = req.header('x-admin-token') || '';
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Invalid admin token' });
  }
  next();
}

router.get('/', adminOnly, async (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 24 * 30);
  res.json(await getMetrics({ hours }));
});

module.exports = router;
