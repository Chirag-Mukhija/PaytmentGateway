const express = require('express');
const adminAuth = require('../middleware/adminAuth');
const { getMetrics } = require('../services/metricsService');
const { captureRouteBase } = require('../middleware/requestMetrics');

const router = express.Router();
router.use(captureRouteBase);

router.get('/', adminAuth, async (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 24 * 30);
  res.json(await getMetrics({ hours }));
});

module.exports = router;
