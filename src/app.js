const express = require('express');
const requestLogger = require('./middleware/requestLogger');
const requestMetrics = require('./middleware/requestMetrics');
const errorHandler = require('./middleware/errorHandler');
const paymentsRouter = require('./routes/payments');
const metricsRouter = require('./routes/metrics');

const app = express();

app.use(requestLogger);
app.use(requestMetrics);
app.use(express.json()); // parses JSON request bodies into req.body

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/metrics', metricsRouter);
app.use('/payments', paymentsRouter);

// error handler must be last — Express only reaches this after every
// route/middleware above it has run (or one of them called next(err))
app.use(errorHandler);

module.exports = app;
