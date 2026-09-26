const crypto = require('crypto');

// Operator endpoints (/metrics, /admin/*) see every merchant's data, so a
// merchant API key must NOT open them. They're guarded by a separate admin
// token -- and if no token is configured they don't exist at all (secure
// default), rather than being open.
function adminAuth(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return res.status(404).json({ error: 'Not found' });

  const given = Buffer.from(req.header('x-admin-token') || '');
  const wanted = Buffer.from(expected);
  // timingSafeEqual needs equal lengths; comparing lengths first leaks only
  // the length, not how many leading characters were right
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
    return res.status(401).json({ error: 'Invalid admin token' });
  }
  next();
}

module.exports = adminAuth;
