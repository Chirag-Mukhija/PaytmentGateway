// Express recognizes this as an error handler specifically because it
// takes 4 arguments (err first) — that arity is how it's detected, not
// the name. Must be registered last, after every route.
//
// Express 5 auto-forwards a thrown/rejected error from an async route
// handler straight here — no manual try/catch + next(err) needed in
// the routes themselves (that was an Express 4 requirement).
function errorHandler(err, req, res, next) {
  console.error(err);

  const status = err.status || 500;
  res.status(status).json({
    error: err.message || 'Internal server error',
  });
}

module.exports = errorHandler;
