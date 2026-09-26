const pool = require('../config/db');
const bankClient = require('../services/bankClient');
const { withTransaction, transitionStatus, applyBankOutcome } = require('../services/paymentService');
const { tryEnqueueDelivery } = require('../queues/webhookQueue');

const config = {
  // only look at PENDING payments at least this old -- gives the bank time
  // to finish deciding on the charge that timed out on our side
  pendingMinAgeSeconds: Number(process.env.PENDING_MIN_AGE_SECONDS) || 30,
  // a payment in PROCESSING longer than this was abandoned mid-flight
  // (process crash, deploy, bug). Must be comfortably longer than the
  // 10s bank timeout, or we'd grab payments that are still legitimately
  // waiting on the bank.
  staleProcessingSeconds: Number(process.env.STALE_PROCESSING_SECONDS) || 120,
  // if the bank still has no record of a charge this long after it went
  // PENDING, the charge never reached it -- safe to call it FAILED
  pendingGiveUpSeconds: Number(process.env.PENDING_GIVE_UP_SECONDS) || 900,
  batchSize: Number(process.env.RESOLUTION_BATCH_SIZE) || 50,
};

// A transition can lose a race (another worker or request already moved
// the payment). That's success from our point of view, not an error.
function isLostRace(err) {
  return err.code === 'INVALID_TRANSITION';
}

// Step 1: crash recovery. Nothing in the request path can rescue a payment
// whose process died between "PROCESSING committed" and "outcome recorded".
// Moving it to PENDING hands it to step 2, which asks the bank.
async function rescueStaleProcessing(summary) {
  const { rows } = await pool.query(
    `SELECT id FROM payments
     WHERE payment_status = 'PROCESSING'
       AND updated_at < NOW() - make_interval(secs => $1)
     ORDER BY updated_at
     LIMIT $2`,
    [config.staleProcessingSeconds, config.batchSize]
  );

  for (const { id } of rows) {
    try {
      await withTransaction((client) => transitionStatus(client, id, 'PROCESSING', 'PENDING', 'stale_processing'));
      summary.rescued += 1;
    } catch (err) {
      if (!isLostRace(err)) throw err;
    }
  }
}

// Step 2: ask the bank what actually happened to each PENDING payment.
// Note what this never does: re-send the charge. Retrying a charge whose
// outcome is unknown is exactly how double charges happen. We only ever
// LOOK UP what the bank decided.
async function resolvePending(summary) {
  const { rows } = await pool.query(
    `SELECT id, EXTRACT(EPOCH FROM (NOW() - updated_at))::int AS age_seconds
     FROM payments
     WHERE payment_status = 'PENDING'
       AND updated_at < NOW() - make_interval(secs => $1)
     ORDER BY updated_at
     LIMIT $2`,
    [config.pendingMinAgeSeconds, config.batchSize]
  );

  for (const payment of rows) {
    let bankRecord;
    try {
      bankRecord = await bankClient.getBankTransaction(payment.id);
    } catch (err) {
      summary.bankUnreachable += 1; // try again next run
      continue;
    }

    let outcome;
    if (bankRecord && bankRecord.status === 'success') {
      outcome = { status: 'success', bank_reference: bankRecord.bank_reference, eventReason: 'resolved_by_bank_lookup' };
    } else if (bankRecord && bankRecord.status === 'failed') {
      outcome = { status: 'failed', reason: bankRecord.reason, eventReason: 'resolved_by_bank_lookup' };
    } else if (payment.age_seconds >= config.pendingGiveUpSeconds) {
      outcome = { status: 'failed', reason: 'bank_has_no_record', eventReason: 'gave_up_no_bank_record' };
    } else {
      summary.stillPending += 1; // bank hasn't heard of it (yet)
      continue;
    }

    try {
      const { toStatus, deliveryId } = await withTransaction(
        (client) => applyBankOutcome(client, payment.id, 'PENDING', outcome)
      );
      await tryEnqueueDelivery(deliveryId);
      summary[toStatus === 'SUCCESS' ? 'resolvedSuccess' : 'resolvedFailed'] += 1;
    } catch (err) {
      if (!isLostRace(err)) throw err;
    }
  }
}

async function runPendingResolution() {
  const summary = {
    rescued: 0,
    resolvedSuccess: 0,
    resolvedFailed: 0,
    stillPending: 0,
    bankUnreachable: 0,
  };
  await rescueStaleProcessing(summary);
  await resolvePending(summary);
  return summary;
}

module.exports = { runPendingResolution, config };
