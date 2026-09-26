const logger = require('../lib/logger');

// Express recognizes this as an error handler specifically because it
// takes 4 arguments (err first) — that arity is how it's detected, not
// the name. Must be registered last, after every route.
//
// Express 5 auto-forwards a thrown/rejected error from an async route
// handler straight here — no manual try/catch + next(err) needed in
// the routes themselves (that was an Express 4 requirement).
function errorHandler(err, req, res, next) {
  // body-parser's errors (malformed JSON, body too large) carry their own
  // 4xx status
  const status = err.status || err.statusCode || 500;

  if (status >= 500) {
    // Full detail goes to the log, never to the client: a raw message
    // like "connect ECONNREFUSED 10.0.3.7:5432" tells an attacker about
    // our internals. The client gets the request id to quote instead.
    logger.error('unhandled error', { err });
    return res.status(status).json({
      error: 'Internal server error',
      request_id: res.getHeader('X-Request-Id'),
    });
  }

  // 4xx: the request line (logged by requestLogger) already records the
  // status; the message is written for the client, so it's safe to return
  res.status(status).json({ error: err.expose === false ? 'Bad request' : err.message });
}

module.exports = errorHandler;
