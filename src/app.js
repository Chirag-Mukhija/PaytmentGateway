const express = require('express');
const requestLogger = require('./middleware/requestLogger');
const requestMetrics = require('./middleware/requestMetrics');
const errorHandler = require('./middleware/errorHandler');
const paymentsRouter = require('./routes/payments');
const metricsRouter = require('./routes/metrics');
const { getHealth } = require('./services/healthService');

const app = express();

// behind Nginx: trust ONE proxy hop so req.ip is the real client, not
// Nginx's container address. Trusting more hops would let a client spoof
// its IP with its own X-Forwarded-For header.
app.set('trust proxy', 1);

app.use(requestLogger);
app.use(requestMetrics);
app.use(express.json({ limit: '16kb' })); // parses JSON request bodies into req.body

// Liveness: "is this process able to answer at all?" Deliberately checks
// nothing else -- if Postgres is down, restarting the gateway fixes
// nothing, so Docker's healthcheck must not restart it for that.
app.get('/health/live', (req, res) => {
  res.json({ status: 'ok' });
});

// Readiness / status: every dependency, with a status code a load
// balancer can act on (503 only when payments genuinely can't work).
app.get('/health', async (req, res) => {
  const health = await getHealth();
  res.status(health.status === 'down' ? 503 : 200).json(health);
});

app.use('/metrics', metricsRouter);
app.use('/payments', paymentsRouter);

// error handler must be last — Express only reaches this after every
// route/middleware above it has run (or one of them called next(err))
app.use(errorHandler);

module.exports = app;
