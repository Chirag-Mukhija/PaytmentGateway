const FAKE_BANK_URL = process.env.FAKE_BANK_URL || 'http://localhost:5000';

// AbortController is what actually enforces the timeout -- fetch alone
// will happily hang forever waiting on a bank that never responds (that's
// the whole point of the fake bank's "timeout" behavior).
async function chargeBank({ paymentId, amount, currency }, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${FAKE_BANK_URL}/charge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment_id: paymentId, amount, currency }),
      signal: controller.signal,
    });
    return response.json();
  } catch (err) {
    // AbortError is what fetch throws when the signal fires -- that's our
    // timeout, not a real network failure, so it gets its own error code
    // the caller can branch on (see processPayment's PENDING handling).
    if (err.name === 'AbortError') {
      const timeoutErr = new Error('Bank did not respond within timeout');
      timeoutErr.code = 'BANK_TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chargeBank };
