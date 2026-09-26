const FAKE_BANK_URL = process.env.FAKE_BANK_URL || 'http://localhost:5000';

function bankError(message, code, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

// AbortController is what actually enforces the timeout -- fetch alone
// will happily hang forever waiting on a bank that never responds (that's
// the whole point of the fake bank's "timeout" behavior).
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Every way this can fail is one of two codes, because the caller only
// needs to know one thing: did we get a definitive answer or not?
//   BANK_TIMEOUT      -- request sent, no answer in time
//   BANK_UNREACHABLE  -- connection refused/reset, DNS failure, 5xx, garbage
// Neither tells us whether the charge happened, so both end up as PENDING.
async function chargeBank({ paymentId, amount, currency }, timeoutMs = 10000) {
  let response;
  try {
    response = await fetchWithTimeout(`${FAKE_BANK_URL}/charge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment_id: paymentId, amount, currency }),
    }, timeoutMs);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw bankError('Bank did not respond within timeout', 'BANK_TIMEOUT', err);
    }
    throw bankError(`Bank unreachable: ${err.cause?.code || err.message}`, 'BANK_UNREACHABLE', err);
  }

  if (!response.ok) {
    throw bankError(`Bank returned HTTP ${response.status}`, 'BANK_UNREACHABLE');
  }

  const body = await response.json();
  if (body.status !== 'success' && body.status !== 'failed') {
    throw bankError(`Bank returned unrecognised status: ${body.status}`, 'BANK_UNREACHABLE');
  }
  return body;
}

// "What actually happened to this payment?" -- used by the PENDING
// resolution job. Returns null when the bank has no record of it at all.
async function getBankTransaction(paymentId, timeoutMs = 5000) {
  let response;
  try {
    response = await fetchWithTimeout(`${FAKE_BANK_URL}/transactions/${paymentId}`, {}, timeoutMs);
  } catch (err) {
    throw bankError(`Bank lookup failed: ${err.cause?.code || err.message}`, 'BANK_UNREACHABLE', err);
  }

  if (response.status === 404) return null;
  if (!response.ok) throw bankError(`Bank lookup returned HTTP ${response.status}`, 'BANK_UNREACHABLE');
  return response.json();
}

module.exports = { chargeBank, getBankTransaction };
