const crypto = require('crypto');
const logger = require('../lib/logger');

// One structured line per request, plus a context that every other log
// line written during this request inherits (see lib/logger.js).
//
// The request id comes from Nginx's X-Request-Id when present, so the
// Nginx access log line and this line can be joined on it; it's generated
// here when the gateway is hit directly. It's echoed back to the client
// too -- a merchant quoting it in a support ticket points straight at the
// right log lines.
function requestLogger(req, res, next) {
  const incoming = req.get('x-request-id');
  const requestId = incoming && incoming.length <= 128 ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);

  const start = process.hrtime.bigint();

  logger.runWithContext({ request_id: requestId }, () => {
    // status code isn't known until the response is actually sent, so we
    // log on 'finish' rather than here — next() runs immediately either way
    res.on('finish', () => {
      const fields = {
        request_id: requestId,
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        duration_ms: Number((Number(process.hrtime.bigint() - start) / 1e6).toFixed(1)),
      };
      if (req.merchant) fields.merchant_id = req.merchant.id;
      if (res.locals.paymentId) fields.payment_id = res.locals.paymentId;
      if (res.locals.cacheStatus) fields.cache = res.locals.cacheStatus;

      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      logger[level]('request', fields);
    });

    next();
  });
}

module.exports = requestLogger;


// this is to log each and every process (state) to terminal and how much time it took . 
