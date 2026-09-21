const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const PORT = process.env.FAKE_BANK_PORT || 5000;

// BANK_BEHAVIOR forces a specific outcome for testing instead of the
// random mix — always_success | always_fail | always_timeout | random
const BANK_BEHAVIOR = process.env.BANK_BEHAVIOR || 'random';

const FAILURE_REASONS = ['insufficient_funds', 'card_declined'];

// keyed by payment_id, not bank_reference -- a timed-out charge never
// gets a bank_reference back to the caller, but the bank still knows
// what it decided internally. This is what Phase 3's PENDING resolution
// job will read to find out what actually happened.
const transactions = new Map();

function pickOutcome() {
  if (BANK_BEHAVIOR === 'always_success') return 'success';
  if (BANK_BEHAVIOR === 'always_fail') return 'failure';
  if (BANK_BEHAVIOR === 'always_timeout') return 'timeout';

  const roll = Math.random();
  if (roll < 0.65) return 'success';
  if (roll < 0.85) return 'failure';
  return 'timeout';
}

function randomDelay(min, max) {
  return new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
}

app.post('/charge', async (req, res) => {
  const { amount, currency, payment_id: paymentId } = req.body;

  if (!paymentId || typeof amount !== 'number') {
    return res.status(400).json({ error: 'amount and payment_id are required' });
  }

  const outcome = pickOutcome();

  if (outcome === 'success') {
    await randomDelay(200, 800);
    const result = { status: 'success', bank_reference: `BANK-${crypto.randomUUID()}` };
    transactions.set(paymentId, result);
    return res.json(result);
  }

  if (outcome === 'failure') {
    await randomDelay(200, 800);
    const reason = FAILURE_REASONS[Math.floor(Math.random() * FAILURE_REASONS.length)];
    const result = { status: 'failed', reason };
    transactions.set(paymentId, result);
    return res.json(result);
  }

  // timeout: the bank still decides an outcome internally (recorded below
  // for later lookup) -- it just never tells the caller synchronously.
  // Real gateways face exactly this: the request timed out on your side,
  // not necessarily on the bank's.
  randomDelay(3000, 6000).then(() => {
    const reason = FAILURE_REASONS[Math.floor(Math.random() * FAILURE_REASONS.length)];
    const result = Math.random() < 0.5
      ? { status: 'success', bank_reference: `BANK-${crypto.randomUUID()}` }
      : { status: 'failed', reason };
    transactions.set(paymentId, result);
  });
  // deliberately never respond -- the caller's own timeout must fire
});

app.get('/transactions/:paymentId', (req, res) => {
  const result = transactions.get(req.params.paymentId);
  if (!result) {
    return res.status(404).json({ error: 'No transaction recorded for this payment yet' });
  }
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`fake-bank listening on port ${PORT} (BANK_BEHAVIOR=${BANK_BEHAVIOR})`);
});
