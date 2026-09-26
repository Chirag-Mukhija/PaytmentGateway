const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.FAKE_BANK_PORT || 5000;

// BANK_BEHAVIOR forces a specific outcome for testing instead of the
// random mix — always_success | always_fail | always_timeout | random
const BANK_BEHAVIOR = process.env.BANK_BEHAVIOR || 'random';

// Where the bank keeps its own ledger. A real bank's records survive a
// restart; if ours lived only in memory, restarting the bank would erase
// the fact that it charged someone — and both PENDING resolution and
// reconciliation would then draw the wrong conclusion.
const DATA_FILE = process.env.FAKE_BANK_DATA_FILE
  || path.join(__dirname, '..', 'data', 'transactions.jsonl');

const FAILURE_REASONS = ['insufficient_funds', 'card_declined'];

// keyed by payment_id, not bank_reference -- a timed-out charge never
// gets a bank_reference back to the caller, but the bank still knows
// what it decided internally. The PENDING resolution job looks it up here.
const transactions = new Map();

function loadLedger() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (!fs.existsSync(DATA_FILE)) return;
  const lines = fs.readFileSync(DATA_FILE, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    const record = JSON.parse(line);
    transactions.set(record.payment_id, record);
  }
}

// append-only: one line per decided transaction, never rewritten
function record(paymentId, amount, currency, result) {
  const entry = {
    payment_id: paymentId,
    amount,
    currency: currency || 'INR',
    ...result,
    decided_at: new Date().toISOString(),
  };
  transactions.set(paymentId, entry);
  fs.appendFileSync(DATA_FILE, `${JSON.stringify(entry)}\n`);
  return entry;
}

function publicView(entry) {
  const { status, bank_reference: bankReference, reason } = entry;
  return status === 'success'
    ? { status, bank_reference: bankReference }
    : { status, reason };
}

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

function successResult() {
  return { status: 'success', bank_reference: `BANK-${crypto.randomUUID()}` };
}

function failureResult() {
  return { status: 'failed', reason: FAILURE_REASONS[Math.floor(Math.random() * FAILURE_REASONS.length)] };
}

app.post('/charge', async (req, res) => {
  const { amount, currency, payment_id: paymentId } = req.body;

  if (!paymentId || typeof amount !== 'number') {
    return res.status(400).json({ error: 'amount and payment_id are required' });
  }

  // Idempotent on payment_id, like a real processor: asking to charge the
  // same payment twice returns the original decision, never a second charge.
  const existing = transactions.get(paymentId);
  if (existing) return res.json(publicView(existing));

  const outcome = pickOutcome();

  if (outcome === 'success') {
    await randomDelay(200, 800);
    return res.json(publicView(record(paymentId, amount, currency, successResult())));
  }

  if (outcome === 'failure') {
    await randomDelay(200, 800);
    return res.json(publicView(record(paymentId, amount, currency, failureResult())));
  }

  // timeout: the bank still decides an outcome internally (recorded for
  // later lookup) -- it just never tells the caller synchronously. Real
  // gateways face exactly this: the request timed out on your side, not
  // necessarily on the bank's.
  randomDelay(3000, 6000).then(() => {
    record(paymentId, amount, currency, Math.random() < 0.5 ? successResult() : failureResult());
  });
  // deliberately never respond -- the caller's own timeout must fire
});

app.get('/transactions/:paymentId', (req, res) => {
  const entry = transactions.get(req.params.paymentId);
  if (!entry) {
    return res.status(404).json({ error: 'No transaction recorded for this payment' });
  }
  res.json(publicView(entry));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', transactions: transactions.size });
});

loadLedger();
app.listen(PORT, () => {
  console.log(`fake-bank listening on port ${PORT} (BANK_BEHAVIOR=${BANK_BEHAVIOR}, ledger=${DATA_FILE}, ${transactions.size} records loaded)`);
});
