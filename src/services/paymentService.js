const pool = require('../config/db');
const bankClient = require('./bankClient');
const idempotency = require('./idempotencyService');
const cache = require('./cache');
const { recordLatency } = require('./metricsService');
const { tryEnqueueDelivery } = require('../queues/webhookQueue');
const logger = require('../lib/logger');

const TERMINAL_STATUSES = ['SUCCESS', 'FAILED'];
const PAYMENT_CACHE_TTL_SECONDS = Number(process.env.PAYMENT_CACHE_TTL_SECONDS) || 300;

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

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

    // 23505 = unique_violation. Since Phase 3 the Redis lock stops most
    // concurrent duplicates before they get here, but the lock is skipped
    // entirely when Redis is down -- this constraint is the guarantee that
    // holds no matter what, the lock is the optimisation on top of it.
    if (err.code === '23505') {
      throw httpError('idempotency_key already used for this merchant', 409);
    }
    throw err;
  } finally {
    client.release();
  }
}

// An idempotency key identifies ONE request. Reusing it with a different
// amount is a client bug (or two different checkouts sharing a key), and
// silently returning the original payment would hide that bug -- so it's
// rejected, the same way Stripe does.
function assertSameRequest(existing, amount) {
  if (Number(existing.amount) !== amount) {
    throw httpError(
      'idempotency_key was already used with different parameters',
      422
    );
  }
}

// POST /payments, Phase 3 version. Returns { payment, replayed }.
//
//   1. Cheap DB check: key already used -> replay (or 422 on mismatch).
//   2. Take a Redis lock on (merchant, key) so a concurrent duplicate gets
//      a clean "in progress" 409 instead of racing us into the INSERT.
//   3. Re-check the DB under the lock (the previous holder may have just
//      committed), then create.
//   4. Release the lock -- only if it's still ours.
//
// If Redis is unreachable, steps 2 and 4 are skipped and the UNIQUE
// constraint (see createPayment) is what keeps duplicates out.
async function createPaymentIdempotent({ merchantId, idempotencyKey, amount }) {
  const existing = await findPaymentByIdempotencyKey(merchantId, idempotencyKey);
  if (existing) {
    assertSameRequest(existing, amount);
    return { payment: existing, replayed: true };
  }

  let token = null;
  try {
    token = await idempotency.acquireLock(merchantId, idempotencyKey);
    if (!token) {
      const err = httpError('A request with this idempotency_key is already in progress', 409);
      err.retryAfterSeconds = 1;
      throw err;
    }
  } catch (err) {
    if (err.status) throw err;
    logger.warn('idempotency lock unavailable, falling back to DB constraint', { error: err.message });
  }

  try {
    const raced = await findPaymentByIdempotencyKey(merchantId, idempotencyKey);
    if (raced) {
      assertSameRequest(raced, amount);
      return { payment: raced, replayed: true };
    }
    const payment = await createPayment({ merchantId, idempotencyKey, amount });
    return { payment, replayed: false };
  } finally {
    if (token) await idempotency.releaseLock(merchantId, idempotencyKey, token);
  }
}

// Cache-aside for GET /payments/:id, with one rule that removes the need
// for invalidation entirely: only cache what can never change again.
//
// A SUCCESS/FAILED payment's row and its events are final -- no transition
// leaves a terminal state. Its webhook deliveries are NOT final (pending ->
// delivered can happen minutes later), so they are always read live.
// INITIATED/PROCESSING/PENDING payments are never cached at all.
//
// Returns { payment, cacheStatus: 'HIT' | 'MISS' }, or null.
async function readPayment(paymentId, merchantId) {
  const cacheKey = `payment:${paymentId}`;
  let core = await cache.getJSON(cacheKey);
  let cacheStatus = 'HIT';

  // ownership is re-checked on a cache hit too -- the cache key is the
  // payment id alone, so skipping this would leak other merchants' payments
  if (core && core.merchant_id !== merchantId) return null;

  if (!core) {
    cacheStatus = 'MISS';
    const { rows } = await pool.query(
      'SELECT * FROM payments WHERE id = $1 AND merchant_id = $2',
      [paymentId, merchantId]
    );
    if (!rows[0]) return null;

    const { rows: events } = await pool.query(
      `SELECT from_status, to_status, reason, created_at
       FROM payment_events WHERE payment_id = $1 ORDER BY created_at ASC`,
      [paymentId]
    );
    // round-trip through JSON so a MISS returns exactly what a HIT would
    core = JSON.parse(JSON.stringify({ ...rows[0], events }));

    if (TERMINAL_STATUSES.includes(core.payment_status)) {
      await cache.setJSON(cacheKey, core, PAYMENT_CACHE_TTL_SECONDS);
    }
  }

  const { rows: webhooks } = await pool.query(
    `SELECT id, payment_status, delivery_status, attempts, last_error, delivered_at
     FROM webhook_deliveries WHERE payment_id = $1 ORDER BY created_at ASC`,
    [paymentId]
  );

  return { payment: { ...core, webhooks }, cacheStatus };
}

async function getPaymentById(paymentId, merchantId) {
  const result = await readPayment(paymentId, merchantId);
  return result ? result.payment : null;
}

// the only function allowed to change payment_status — locks the row,
// checks it's actually in the state the caller thinks it's in (so two
// racing transitions can't both apply), then writes the new status and
// its audit event together.
async function transitionStatus(client, paymentId, fromStatus, toStatus, reason = null) {
  const { rows } = await client.query(
    'SELECT payment_status FROM payments WHERE id = $1 FOR UPDATE',
    [paymentId]
  );

  if (!rows[0] || rows[0].payment_status !== fromStatus) {
    const err = httpError(
      `Invalid transition: expected ${fromStatus}, got ${rows[0] ? rows[0].payment_status : 'no such payment'}`,
      409
    );
    err.code = 'INVALID_TRANSITION';
    throw err;
  }

  await client.query(
    'UPDATE payments SET payment_status = $1, updated_at = NOW() WHERE id = $2',
    [toStatus, paymentId]
  );
  await client.query(
    'INSERT INTO payment_events (payment_id, from_status, to_status, reason) VALUES ($1, $2, $3, $4)',
    [paymentId, fromStatus, toStatus, reason]
  );
}

// Transactional outbox insert. Runs inside the SAME transaction as the
// transition to SUCCESS/FAILED, so the payment reaching a terminal state
// and "the merchant must be told" commit or roll back together. Skipped
// (returns null) when the merchant has no webhook_url.
async function insertWebhookOutbox(client, paymentId, status) {
  const { rows } = await client.query(
    `INSERT INTO webhook_deliveries (payment_id, merchant_id, payment_status, payload)
     SELECT p.id, p.merchant_id, $2,
            jsonb_build_object(
              'event', 'payment.updated',
              'payment_id', p.id,
              'status', $2::text,
              'amount', p.amount::text,
              'currency', 'INR',
              'bank_reference', p.bank_reference,
              'failure_reason', p.failure_reason,
              'occurred_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            )
     FROM payments p
     JOIN merchants m ON m.id = p.merchant_id
     WHERE p.id = $1 AND m.webhook_url IS NOT NULL
     ON CONFLICT (payment_id, payment_status) DO NOTHING
     RETURNING id`,
    [paymentId, status]
  );
  return rows[0] ? rows[0].id : null;
}

// Records what the bank said, from whichever state we were in (PROCESSING
// from the request path, PENDING from the resolution job). Caller owns the
// transaction. outcome is one of:
//   { status: 'success', bank_reference, eventReason }
//   { status: 'failed',  reason,         eventReason }
//   { status: 'unknown',                 eventReason }   -> PENDING
// Returns { toStatus, deliveryId }.
async function applyBankOutcome(client, paymentId, fromStatus, outcome) {
  let toStatus;

  if (outcome.status === 'success') {
    toStatus = 'SUCCESS';
    await client.query('UPDATE payments SET bank_reference = $1 WHERE id = $2', [outcome.bank_reference, paymentId]);
  } else if (outcome.status === 'failed') {
    toStatus = 'FAILED';
    await client.query('UPDATE payments SET failure_reason = $1 WHERE id = $2', [outcome.reason, paymentId]);
  } else {
    toStatus = 'PENDING';
  }

  await transitionStatus(client, paymentId, fromStatus, toStatus, outcome.eventReason || null);

  const deliveryId = TERMINAL_STATUSES.includes(toStatus)
    ? await insertWebhookOutbox(client, paymentId, toStatus)
    : null;

  return { toStatus, deliveryId };
}

// Runs fn(client) inside BEGIN/COMMIT on one pooled connection.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Phase 2's state machine: INITIATED -> PROCESSING -> SUCCESS/FAILED/PENDING.
//
// Critical ordering rule (see DECISIONS.md): PROCESSING is written and
// committed BEFORE the bank is ever called. If the process crashes during
// the bank call, the DB still truthfully says "this was in flight" instead
// of lying that it's still INITIATED (which would let a retry double-charge).
async function processPayment(paymentId, merchantId) {
  const payment = await withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM payments WHERE id = $1 AND merchant_id = $2 FOR UPDATE',
      [paymentId, merchantId]
    );
    const row = rows[0];

    if (!row) throw httpError('Payment not found', 404);
    if (row.payment_status !== 'INITIATED') {
      throw httpError(`Cannot process payment in status: ${row.payment_status}`, 409);
    }

    await transitionStatus(client, paymentId, 'INITIATED', 'PROCESSING');
    return row;
  });

  // The bank call happens with no pooled connection held — it can take
  // seconds (or, on a timeout, up to the full 10s), and holding a
  // connection from the pool of 20 that whole time would starve every
  // other request. This is also exactly the dual-write gap from
  // DECISIONS.md: whatever happens between here and the next write is
  // where our record and the bank's can end up disagreeing.
  let outcome;
  const bankStart = Date.now();
  try {
    const bankResult = await bankClient.chargeBank({
      paymentId: payment.id,
      amount: Number(payment.amount),
      currency: 'INR',
    });
    outcome = { ...bankResult, eventReason: 'bank_response' };
  } catch (err) {
    // Timeout and "couldn't reach the bank" both mean the same thing to
    // us: no definitive answer. Neither is evidence the charge failed, so
    // neither becomes FAILED. The resolution job asks the bank later.
    if (err.code === 'BANK_TIMEOUT') {
      outcome = { status: 'unknown', eventReason: 'bank_timeout' };
    } else if (err.code === 'BANK_UNREACHABLE') {
      outcome = { status: 'unknown', eventReason: 'bank_unreachable' };
    } else {
      // A bug on our side. The payment stays PROCESSING, and the
      // resolution job's stale-PROCESSING sweep will pick it up.
      throw err;
    }
  } finally {
    // timeouts included on purpose: a p95 that ignored them would hide
    // exactly the slow calls that hurt
    recordLatency('bank.charge', Date.now() - bankStart);
  }

  const { toStatus, deliveryId } = await withTransaction(
    (client) => applyBankOutcome(client, paymentId, 'PROCESSING', outcome)
  );
  logger.info('payment processed', {
    payment_id: paymentId,
    status: toStatus,
    reason: outcome.eventReason,
    bank_ms: Date.now() - bankStart,
  });

  // Fast path only -- the outbox row is already committed, so if this
  // enqueue fails the sweeper delivers it anyway.
  await tryEnqueueDelivery(deliveryId);

  return getPaymentById(paymentId, merchantId);
}

async function listPayments(merchantId, { limit, offset, status }) {
  const params = [merchantId];
  let where = 'WHERE merchant_id = $1';
  if (status) {
    params.push(status);
    where += ` AND payment_status = $${params.length}`;
  }

  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query(
      `SELECT * FROM payments ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM payments ${where}`, params),
  ]);

  return { payments: rows, total: countRows[0].total };
}

module.exports = {
  TERMINAL_STATUSES,
  findPaymentByIdempotencyKey,
  createPayment,
  createPaymentIdempotent,
  readPayment,
  getPaymentById,
  listPayments,
  processPayment,
  transitionStatus,
  applyBankOutcome,
  withTransaction,
};
