// Stand-in for a merchant's own backend: the thing on the other end of
// payments' webhook_url. Built on Node's http module so it needs no
// npm install of its own.
//
//   POST /webhook   receive a delivery (optionally fail on purpose)
//   GET  /webhooks  list what has been received, newest first
//
// Env:
//   MERCHANT_FAIL_RATE (0..1)   fraction of deliveries answered with 500,
//                               to exercise the gateway's retry queue
//   MERCHANT_WEBHOOK_SECRETS    comma-separated; if set, verify
//                               X-Webhook-Signature against them and reject
//                               deliveries that match none. (A list because
//                               this one mock stands in for several
//                               merchants' backends, each with its own secret.)
//
// It also shows what a real merchant must do with at-least-once delivery:
// dedupe on X-Webhook-Id, so a redelivered event is acknowledged but not
// acted on twice.
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.MERCHANT_PORT) || 4000;
const FAIL_RATE = Number(process.env.MERCHANT_FAIL_RATE) || 0;
const SECRETS = (process.env.MERCHANT_WEBHOOK_SECRETS || process.env.MERCHANT_WEBHOOK_SECRET || '')
  .split(',').map((x) => x.trim()).filter(Boolean);
const MAX_SIGNATURE_AGE_SECONDS = 300;
const MAX_KEPT = 5000;

const received = [];
const seenIds = new Set();
let duplicates = 0;

function verifySignature(header, rawBody) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=')));
  const timestamp = Number(parts.t);
  if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > MAX_SIGNATURE_AGE_SECONDS) return false;

  const given = Buffer.from(parts.v1 || '', 'hex');
  return SECRETS.some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    const wanted = Buffer.from(expected, 'hex');
    // constant-time compare: a normal === leaks, through timing, how many
    // leading characters of a forged signature were right
    return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (Math.random() < FAIL_RATE) {
        console.log('merchant-mock: simulating failure');
        return send(res, 500, { error: 'simulated merchant outage' });
      }

      if (SECRETS.length && !verifySignature(req.headers['x-webhook-signature'], raw)) {
        console.log('merchant-mock: rejected delivery with bad signature');
        return send(res, 401, { error: 'invalid signature' });
      }

      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: 'invalid JSON' });
      }

      const webhookId = req.headers['x-webhook-id'] || payload.id;
      if (webhookId && seenIds.has(webhookId)) {
        duplicates += 1;
        return send(res, 200, { ok: true, duplicate: true });
      }
      if (webhookId) seenIds.add(webhookId);

      received.unshift({ received_at: new Date().toISOString(), webhook_id: webhookId, payload });
      if (received.length > MAX_KEPT) received.pop();
      console.log(`merchant-mock: ${payload.status} for ${payload.payment_id}`);
      return send(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/webhooks') {
    return send(res, 200, { count: received.length, duplicates, webhooks: received });
  }

  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { status: 'ok' });
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`merchant-mock listening on port ${PORT} (MERCHANT_FAIL_RATE=${FAIL_RATE}, signature check ${SECRETS.length ? `ON (${SECRETS.length} secret(s))` : 'off'})`);
});
