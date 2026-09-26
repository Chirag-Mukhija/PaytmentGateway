const pool = require('../config/db');
const logger = require('../lib/logger');

const FAKE_BANK_URL = process.env.FAKE_BANK_URL || 'http://localhost:5000';
const DAY_MS = 24 * 60 * 60 * 1000;

// Reconciliation: compare what WE say happened with what the BANK says
// happened, for one UTC day. Everything before this phase tried to keep the
// two in agreement as it went; this is the backstop that assumes they will
// sometimes disagree anyway (the dual-write problem guarantees it) and
// finds every place they do.
//
// Two differences from the plan's sample code, both bugs there:
//   1. It matched on bank_reference. A payment we recorded as FAILED or
//      PENDING has no bank_reference, so "the bank charged the customer but
//      we said it failed" -- the worst discrepancy there is -- could never
//      be found. We match on payment_id, which both sides always have.
//   2. It compared amounts with !==. The bank has a JSON number (999.5),
//      Postgres returns a DECIMAL as a string ("999.50"), so every single
//      payment would have been reported as an amount mismatch. We compare
//      integer paise instead.

// "999.50" or 999.5 -> 99950. Parsed from the string form so no binary
// float ever touches the comparison.
function toPaise(amount) {
  const [whole, frac = ''] = String(amount).split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0').slice(0, 2));
}

function paiseToString(paise) {
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
}

function dayBounds(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error(`invalid date: ${dateStr}`);
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw new Error(`invalid date: ${dateStr}`);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

function yesterdayUTC() {
  return new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
}

async function fetchBankLedger(from, to) {
  const url = `${FAKE_BANK_URL}/transactions?from=${from.toISOString()}&to=${to.toISOString()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`bank ledger request failed: HTTP ${res.status}`);
  return (await res.json()).transactions;
}

async function runReconciliation(dateStr = yesterdayUTC()) {
  const { start, end } = dayBounds(dateStr);

  // The bank ledger is fetched for the day on either side as well. A
  // payment created at 23:59:59 can be decided by the bank at 00:00:01:
  // that's the same payment on two different "days", not a discrepancy.
  const ledger = await fetchBankLedger(new Date(start.getTime() - DAY_MS), new Date(end.getTime() + DAY_MS));
  const bankById = new Map(ledger.map((t) => [t.payment_id, t]));
  const bankSuccessesToday = ledger.filter((t) => {
    const at = Date.parse(t.decided_at);
    return t.status === 'success' && at >= start.getTime() && at < end.getTime();
  });

  // Our side: everything that reached SUCCESS during the day.
  const { rows: gatewaySuccesses } = await pool.query(
    `SELECT p.id, p.amount::text AS amount, p.bank_reference, p.payment_status
     FROM payment_events e
     JOIN payments p ON p.id = e.payment_id
     WHERE e.to_status = 'SUCCESS' AND e.created_at >= $1 AND e.created_at < $2`,
    [start, end]
  );

  // ...and our current view of every payment the bank charged that day.
  const { rows: chargedPayments } = await pool.query(
    `SELECT id, amount::text AS amount, payment_status
     FROM payments WHERE id = ANY($1::uuid[])`,
    [bankSuccessesToday.map((t) => t.payment_id)]
  );
  const gatewayById = new Map(chargedPayments.map((p) => [p.id, p]));

  const discrepancies = [];
  const flagged = new Set();
  let matched = 0;

  // 1. Every payment WE say succeeded must be a success at the bank, for
  //    the same amount, with the same reference.
  for (const g of gatewaySuccesses) {
    // Reached SUCCESS today but isn't SUCCESS now. transitionStatus can
    // never do that (nothing leaves a terminal state), so something changed
    // the row outside the state machine -- a manual UPDATE, a bad script.
    if (g.payment_status !== 'SUCCESS') {
      discrepancies.push({
        type: 'status_regression', severity: 'critical', payment_id: g.id,
        detail: `reached SUCCESS earlier but is now ${g.payment_status} -- a terminal state was changed outside the state machine`,
        gateway_status: g.payment_status,
      });
      flagged.add(g.id);
      continue;
    }

    const b = bankById.get(g.id);
    if (!b || b.status !== 'success') {
      discrepancies.push({
        type: 'gateway_only', severity: 'critical', payment_id: g.id,
        detail: 'we recorded SUCCESS, the bank has no successful charge -- the merchant was told they were paid',
        gateway_amount: g.amount, bank_status: b ? b.status : 'no_record',
      });
    } else if (toPaise(b.amount) !== toPaise(g.amount)) {
      discrepancies.push({
        type: 'amount_mismatch', severity: 'critical', payment_id: g.id,
        gateway_amount: g.amount, bank_amount: paiseToString(toPaise(b.amount)),
      });
    } else if (b.bank_reference !== g.bank_reference) {
      discrepancies.push({
        type: 'reference_mismatch', severity: 'warning', payment_id: g.id,
        gateway_reference: g.bank_reference, bank_reference: b.bank_reference,
      });
    } else {
      matched += 1;
    }
  }

  // 2. Every charge the BANK made that day must be a SUCCESS on our side.
  //    (Ones that are already SUCCESS were compared in step 1, on whichever
  //    day they succeeded.)
  for (const b of bankSuccessesToday) {
    const g = gatewayById.get(b.payment_id);
    if ((g && g.payment_status === 'SUCCESS') || flagged.has(b.payment_id)) continue;

    const status = g ? g.payment_status : 'MISSING';
    const unresolved = status === 'PENDING' || status === 'PROCESSING';
    discrepancies.push({
      type: 'bank_only',
      // PENDING/PROCESSING: the resolution job should still fix this one.
      // FAILED/MISSING: the customer was charged and nothing will ever fix
      // it automatically -- it needs a refund or a correction.
      severity: unresolved ? 'warning' : 'critical',
      payment_id: b.payment_id,
      detail: unresolved
        ? 'bank charged, we are still waiting on resolution'
        : 'bank charged the customer, we recorded it as not paid',
      gateway_status: status,
      bank_amount: paiseToString(toPaise(b.amount)),
      bank_reference: b.bank_reference,
    });
  }

  const sumPaise = (rows) => rows.reduce((acc, r) => acc + toPaise(r.amount), 0);
  const count = (type) => discrepancies.filter((d) => d.type === type).length;
  const summary = {
    date: dateStr,
    gateway_successes: gatewaySuccesses.length,
    bank_successes: bankSuccessesToday.length,
    gateway_success_amount: paiseToString(sumPaise(gatewaySuccesses)),
    bank_success_amount: paiseToString(sumPaise(bankSuccessesToday)),
    matched,
    gateway_only: count('gateway_only'),
    bank_only: count('bank_only'),
    amount_mismatch: count('amount_mismatch'),
    reference_mismatch: count('reference_mismatch'),
    status_regression: count('status_regression'),
    critical: discrepancies.filter((d) => d.severity === 'critical').length,
  };

  // one report per day: re-running replaces it, so the job is safe to
  // retry or run by hand
  await pool.query(
    `INSERT INTO reconciliation_reports (report_date, summary, discrepancies)
     VALUES ($1, $2, $3)
     ON CONFLICT (report_date)
     DO UPDATE SET summary = EXCLUDED.summary, discrepancies = EXCLUDED.discrepancies, created_at = NOW()`,
    [dateStr, summary, JSON.stringify(discrepancies)]
  );

  logger[summary.critical ? 'error' : 'info']('reconciliation complete', summary);
  return { summary, discrepancies };
}

async function getReport(dateStr) {
  dayBounds(dateStr); // validates
  const { rows } = await pool.query(
    // ::text -- node-pg turns a DATE into a JS Date at LOCAL midnight, which
    // prints as the previous day anywhere east of UTC
    'SELECT report_date::text AS report_date, summary, discrepancies, created_at FROM reconciliation_reports WHERE report_date = $1',
    [dateStr]
  );
  return rows[0] || null;
}

module.exports = { runReconciliation, getReport, yesterdayUTC, toPaise };
