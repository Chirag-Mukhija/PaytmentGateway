const paymentService = require('../services/paymentService');

// Express 5 forwards a thrown/rejected error from these async handlers
// straight to errorHandler.js — no try/catch needed here for that

async function createPaymentHandler(req, res) {
  const { idempotency_key, amount } = req.body;

  if (!idempotency_key || typeof idempotency_key !== 'string') {
    return res.status(400).json({ error: 'idempotency_key is required' });
  }
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  const existing = await paymentService.findPaymentByIdempotencyKey(req.merchant.id, idempotency_key);
  if (existing) {
    res.setHeader('X-Idempotent-Replay', 'true');
    return res.status(201).json(existing);
  }

  const payment = await paymentService.createPayment({
    merchantId: req.merchant.id,
    idempotencyKey: idempotency_key,
    amount,
  });

  res.status(201).json(payment);
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
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = parseInt(req.query.offset, 10) || 0;

  const payments = await paymentService.listPayments(req.merchant.id, { limit, offset });
  res.json({ payments, limit, offset });
}

module.exports = {
  createPaymentHandler,
  processPaymentHandler,
  getPaymentHandler,
  listPaymentsHandler,
};
