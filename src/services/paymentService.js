const pool = require('../config/db');

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
};
