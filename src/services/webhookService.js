const crypto = require('crypto');

const WEBHOOK_TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS) || 5000;

// Stripe-style signature: HMAC-SHA256 over "<timestamp>.<raw body>" with the
// merchant's own secret. The merchant recomputes it to prove the request
// came from us (only we and they know the secret), and rejects old
// timestamps so a captured delivery can't be replayed at them later.
function signPayload(secret, timestamp, body) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

// One delivery attempt. Throws on anything other than a 2xx so the queue's
// retry/backoff takes over -- this function never retries by itself.
async function sendSignedWebhook({ deliveryId, webhookUrl, secret, payload }) {
  const body = JSON.stringify({ id: deliveryId, ...payload });
  const timestamp = Math.floor(Date.now() / 1000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // stable across retries: the merchant dedupes on this, because
        // delivery is at-least-once (see DECISIONS.md)
        'X-Webhook-Id': deliveryId,
        'X-Webhook-Signature': `t=${timestamp},v1=${signPayload(secret, timestamp, body)}`,
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError'
      ? `timed out after ${WEBHOOK_TIMEOUT_MS}ms`
      : `request failed: ${err.cause?.code || err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`merchant responded HTTP ${response.status}`);
  }
}

module.exports = { sendSignedWebhook, signPayload };
