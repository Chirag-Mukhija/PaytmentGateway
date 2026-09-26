const { AsyncLocalStorage } = require('async_hooks');

// Structured logging: one JSON object per line, so logs can be filtered
// and joined by field ("every line for payment X", "every 5xx for merchant
// Y") instead of grepped as prose.
//
// AsyncLocalStorage carries a per-request context (request_id, merchant_id,
// ...) through every await in that request, so a log line written deep in
// paymentService automatically says which request it belongs to -- without
// passing a logger or a request id through every function signature.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;
const storage = new AsyncLocalStorage();

function serializeError(err) {
  return { message: err.message, code: err.code, stack: err.stack };
}

function write(level, msg, fields = {}) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const entry = {
    time: new Date().toISOString(),
    level,
    service: process.env.SERVICE_NAME || 'gateway',
    msg,
    ...storage.getStore(),
    ...fields,
  };
  if (entry.err instanceof Error) entry.err = serializeError(entry.err);
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

// Run fn with a fresh context; everything it awaits inherits it.
function runWithContext(context, fn) {
  return storage.run({ ...context }, fn);
}

// Add fields to the current context (e.g. merchant_id once auth knows it).
function addContext(fields) {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}

module.exports = {
  debug: (msg, fields) => write('debug', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
  runWithContext,
  addContext,
};
