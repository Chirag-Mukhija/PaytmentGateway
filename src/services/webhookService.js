// Phase 2 version: a direct HTTP call, made and forgotten. Phase 3 replaces
// this with a BullMQ queue + retry/backoff -- this function's signature is
// deliberately kept simple so that swap doesn't touch its callers.
async function sendWebhook(merchant, payload) {
  if (!merchant.webhook_url) return;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    await fetch(merchant.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timer);
  } catch (err) {
    // Logged, not thrown -- a merchant's webhook endpoint being down must
    // never take down the payment flow that already succeeded/failed for
    // real. Undelivered webhooks are silently lost until Phase 3's retry
    // queue exists -- that gap is intentional for now, not an oversight.
    console.error('Webhook delivery failed:', err.message);
  }
}

module.exports = { sendWebhook };
