const { recordLatency } = require('../services/metricsService');

// Records how long each request took, grouped by ROUTE, not URL:
// "GET /payments/:id", never "GET /payments/2c84b146-...". Keying by the
// raw URL would create one bucket per payment id -- unbounded keys, and
// no bucket with enough samples to compute a percentile from.
function requestMetrics(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    // req.route is only set when a route actually matched
    if (!req.route) return;
    const base = req.metricsBase ?? req.baseUrl;
    const path = req.route.path === '/' ? '' : req.route.path;
    recordLatency(`${req.method} ${base}${path}`, Number(process.hrtime.bigint() - start) / 1e6);
  });

  next();
}

// Mount first inside each router. req.baseUrl is only correct WHILE the
// router is handling the request: when a handler throws, Express leaves
// the router (resetting baseUrl to '') before the error handler sends the
// response -- so by 'finish', a 409 on POST /payments would otherwise be
// recorded as "POST ". Capture it while it's still right.
function captureRouteBase(req, res, next) {
  req.metricsBase = req.baseUrl;
  next();
}

module.exports = requestMetrics;
module.exports.captureRouteBase = captureRouteBase;
