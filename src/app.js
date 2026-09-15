const express = require('express');
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');
const paymentsRouter = require('./routes/payments');

const app = express();

app.use(requestLogger);
app.use(express.json()); // parses JSON request bodies into req.body

// temporary — proves the server boots before we wire up real routes
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/payments', paymentsRouter);

// error handler must be last — Express only reaches this after every
// route/middleware above it has run (or one of them called next(err))
app.use(errorHandler);

module.exports = app;
