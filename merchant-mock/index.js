// Stand-in for a merchant's own backend: the thing on the other end of
// payments' webhook_url. Built on Node's http module so it needs no
// npm install of its own.
//
//   POST /webhook   receive a delivery (optionally fail on purpose)
//   GET  /webhooks  list what has been received, newest first
//
// MERCHANT_FAIL_RATE (0..1) makes a fraction of deliveries return 500,
// which is how the gateway's webhook retry queue gets exercised.
const http = require('http');

const PORT = Number(process.env.MERCHANT_PORT) || 4000;
const FAIL_RATE = Number(process.env.MERCHANT_FAIL_RATE) || 0;
const MAX_KEPT = 500;

const received = [];

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (Math.random() < FAIL_RATE) {
        console.log('merchant-mock: simulating failure');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'simulated merchant outage' }));
      }

      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid JSON' }));
      }

      received.unshift({ received_at: new Date().toISOString(), payload });
      if (received.length > MAX_KEPT) received.pop();
      console.log(`merchant-mock: ${payload.status} for ${payload.payment_id}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/webhooks') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ count: received.length, webhooks: received }));
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`merchant-mock listening on port ${PORT} (MERCHANT_FAIL_RATE=${FAIL_RATE})`);
});
