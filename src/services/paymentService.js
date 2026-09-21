const pool = require('../config/db');
const bankClient = require('./bankClient');
const { sendWebhook } = require('./webhookService');

async function findPaymentByIdempotencyKey(merchantId, idempotencyKey) {
  const { rows } = await pool.query(
    'SELECT * FROM payments WHERE merchant_id = $1 AND idempotency_key = $2',
    [merchantId, idempotencyKey]
  ); // dollar $ thing is done to avoid sql injection .
  return rows[0] || null;
}

async function createPayment({ merchantId, idempotencyKey, amount }) {
  // a single client for the whole transaction — pool.query() alone would
  // hand out a random connection per call, so BEGIN on one call and the
  // actual INSERT on another could land on two different connections,
  // making the transaction meaningless
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO payments (merchant_id, idempotency_key, amount)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [merchantId, idempotencyKey, amount]
    );
    const payment = rows[0];

    // payment row and its first audit event must exist together or not
    // at all — that's exactly what the transaction guarantees
    await client.query(
      `INSERT INTO payment_events (payment_id, from_status, to_status)
       VALUES ($1, NULL, $2)`,
      [payment.id, payment.payment_status]
    );

    await client.query('COMMIT');
    return payment;
  } catch (err) {
    await client.query('ROLLBACK');

    // 23505 = unique_violation. Two near-simultaneous requests with the
    // same idempotency_key can both pass findPaymentByIdempotencyKey's
    // SELECT before either INSERT commits — the UNIQUE constraint is what
    // actually stops the second one, here. Turn that into a clean 409
    // instead of a raw 500. Not a full fix for the race (that's the
    // Redis lock in Phase 3) — just don't fail ugly when it's hit.
    if (err.code === '23505') {
      const conflict = new Error('idempotency_key already used for this merchant');
      conflict.status = 409;
      throw conflict;
    }
    throw err;
  } finally {
    client.release();
  }
}

async function getPaymentById(paymentId, merchantId) {
  const { rows } = await pool.query(
    'SELECT * FROM payments WHERE id = $1 AND merchant_id = $2',
    [paymentId, merchantId]
  );
  const payment = rows[0];
  if (!payment) return null;

  const { rows: events } = await pool.query(
    'SELECT from_status, to_status, created_at FROM payment_events WHERE payment_id = $1 ORDER BY created_at ASC',
    [paymentId]
  );

  return { ...payment, events };
}

// the only function allowed to change payment_status — locks the row,
// checks it's actually in the state the caller thinks it's in (so two
// racing transitions can't both apply), then writes the new status and
// its audit event together.
async function transitionStatus(client, paymentId, fromStatus, toStatus) {
  const { rows } = await client.query(
    'SELECT payment_status FROM payments WHERE id = $1 FOR UPDATE',
    [paymentId]
  );

  if (!rows[0] || rows[0].payment_status !== fromStatus) {
    const err = new Error(
      `Invalid transition: expected ${fromStatus}, got ${rows[0] ? rows[0].payment_status : 'no such payment'}`
    );
    err.status = 409;
    throw err;
  }

  await client.query(
    'UPDATE payments SET payment_status = $1, updated_at = NOW() WHERE id = $2',
    [toStatus, paymentId]
  );
  await client.query(
    'INSERT INTO payment_events (payment_id, from_status, to_status) VALUES ($1, $2, $3)',
    [paymentId, fromStatus, toStatus]
  );
}

// Phase 2's state machine: INITIATED -> PROCESSING -> SUCCESS/FAILED/PENDING.
//
// Critical ordering rule (see DECISIONS.md): PROCESSING is written and
// committed BEFORE the bank is ever called. If the process crashes during
// the bank call, the DB still truthfully says "this was in flight" instead
// of lying that it's still INITIATED (which would let a retry double-charge).
async function processPayment(paymentId, merchantId) {
  const client = await pool.connect();
  let payment;

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT p.*, m.webhook_url
       FROM payments p
       JOIN merchants m ON m.id = p.merchant_id
       WHERE p.id = $1 AND p.merchant_id = $2
       FOR UPDATE OF p`,
      [paymentId, merchantId]
    );
    payment = rows[0];

    if (!payment) {
      const err = new Error('Payment not found');
      err.status = 404;
      throw err;
    }
    if (payment.payment_status !== 'INITIATED') {
      const err = new Error(`Cannot process payment in status: ${payment.payment_status}`);
      err.status = 409;
      throw err;
    }

    await transitionStatus(client, paymentId, 'INITIATED', 'PROCESSING');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // The bank call happens with no pooled connection held — it can take
  // seconds (or, on a timeout, up to the full 10s), and holding a
  // connection from the pool of 20 that whole time would starve every
  // other request. This is also exactly the dual-write gap from
  // DECISIONS.md: whatever happens between here and the next write is
  // where our record and the bank's can end up disagreeing.
  let bankResult;
  let timedOut = false;
  try {
    bankResult = await bankClient.chargeBank({
      paymentId: payment.id,
      amount: Number(payment.amount),
      currency: 'INR',
    });
  } catch (err) {
    if (err.code === 'BANK_TIMEOUT') {
      timedOut = true;
    } else {
      throw err;
    }
  }

  const client2 = await pool.connect();
  try {
    await client2.query('BEGIN');

    if (timedOut) {
      // Not FAILED — we genuinely don't know what happened. Phase 3's
      // resolution job is what eventually finds out.
      await transitionStatus(client2, paymentId, 'PROCESSING', 'PENDING');
    } else if (bankResult.status === 'success') {
      await client2.query('UPDATE payments SET bank_reference = $1 WHERE id = $2', [
        bankResult.bank_reference,
        paymentId,
      ]);
      await transitionStatus(client2, paymentId, 'PROCESSING', 'SUCCESS');
    } else {
      await client2.query('UPDATE payments SET failure_reason = $1 WHERE id = $2', [
        bankResult.reason,
        paymentId,
      ]);
      await transitionStatus(client2, paymentId, 'PROCESSING', 'FAILED');
    }

    await client2.query('COMMIT');
  } catch (err) {
    await client2.query('ROLLBACK');
    throw err;
  } finally {
    client2.release();
  }

  // No webhook on PENDING — there's nothing final to tell the merchant yet.
  if (!timedOut) {
    await sendWebhook(payment, {
      event: 'payment.updated',
      payment_id: paymentId,
      status: bankResult.status === 'success' ? 'SUCCESS' : 'FAILED',
      amount: payment.amount,
      timestamp: new Date().toISOString(),
    });
  }

  return getPaymentById(paymentId, merchantId);
}

async function listPayments(merchantId, { limit, offset }) {
  const { rows } = await pool.query(
    `SELECT * FROM payments
     WHERE merchant_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [merchantId, limit, offset]
  );
  return rows;
}

module.exports = {
  findPaymentByIdempotencyKey,
  createPayment,
  getPaymentById,
  listPayments,
  processPayment,
};
