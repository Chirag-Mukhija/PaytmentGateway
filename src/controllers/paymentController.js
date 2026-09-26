const paymentService = require('../services/paymentService');

// Express 5 forwards a thrown/rejected error from these async handlers
// straight to errorHandler.js — no try/catch needed here for that

const MAX_AMOUNT = 9999999999.99; // largest value DECIMAL(12,2) can hold
const VALID_STATUSES = ['INITIATED', 'PROCESSING', 'SUCCESS', 'FAILED', 'PENDING'];

// Money has exactly two decimal places. 10.005 would be silently rounded
// by Postgres to 10.01, and then an idempotent replay of the same request
// (amount 10.005) would no longer match the stored amount -- reject it up
// front instead.
function hasAtMostTwoDecimals(n) {
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-9;
}

async function createPaymentHandler(req, res) {
  const { idempotency_key, amount } = req.body;

  if (!idempotency_key || typeof idempotency_key !== 'string' || idempotency_key.length > 255) {
    return res.status(400).json({ error: 'idempotency_key is required (string, max 255 chars)' });
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  if (!hasAtMostTwoDecimals(amount) || amount > MAX_AMOUNT) {
    return res.status(400).json({ error: `amount must have at most 2 decimal places and be <= ${MAX_AMOUNT}` });
  }

  try {
    const { payment, replayed } = await paymentService.createPaymentIdempotent({
      merchantId: req.merchant.id,
      idempotencyKey: idempotency_key,
      amount,
    });

    if (replayed) res.setHeader('X-Idempotent-Replay', 'true');
    return res.status(201).json(payment);
  } catch (err) {
    if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
    throw err;
  }
}

async function processPaymentHandler(req, res) {
  const payment = await paymentService.processPayment(req.params.id, req.merchant.id);
  res.json(payment);
}

async function getPaymentHandler(req, res) {
  const payment = await paymentService.getPaymentById(req.params.id, req.merchant.id);
  if (!payment) {
    return res.status(404).json({ error: 'Payment not found' });
  }
  res.json(payment);
}

async function listPaymentsHandler(req, res) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;

  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${VALID_STATUSES.join(', ')}` });
  }

  const { payments, total } = await paymentService.listPayments(req.merchant.id, { limit, offset, status });
  res.json({ payments, total, limit, offset });
}

module.exports = {
  createPaymentHandler,
  processPaymentHandler,
  getPaymentHandler,
  listPaymentsHandler,
};
