const express = require('express');
const adminAuth = require('../middleware/adminAuth');
const { captureRouteBase } = require('../middleware/requestMetrics');
const { runReconciliation, getReport } = require('../jobs/reconciliationJob');

const router = express.Router();
router.use(captureRouteBase);
router.use(adminAuth);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
router.param('date', (req, res, next, date) => {
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  next();
});

// read the stored report for a UTC day
router.get('/reconciliation/:date', async (req, res) => {
  const report = await getReport(req.params.date);
  if (!report) return res.status(404).json({ error: 'No report for that date -- POST to run one' });
  res.json(report);
});

// run (or re-run) reconciliation for a UTC day now; replaces that day's report
router.post('/reconciliation/:date', async (req, res) => {
  res.json(await runReconciliation(req.params.date));
});

module.exports = router;
