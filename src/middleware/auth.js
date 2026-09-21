const pool = require('../config/db');

// every /payments request must carry x-api-key. looks up the merchant,
// attaches it to req.merchant so downstream handlers never touch the
// key itself again.
async function auth(req, res, next) {
  const apiKey = req.header('x-api-key'); // this key is for merchant . 

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing x-api-key header' });
  }

  // parameterized ($1), not string-concatenated — same SQL injection
  // reasoning as everywhere else we touch the DB
  const { rows } = await pool.query(
    'SELECT id, name, webhook_url FROM merchants WHERE api_key = $1',
    [apiKey]
  );

  if (rows.length === 0) { // no merchant exsists with this api key
    return res.status(401).json({ error: 'Invalid API key' });
  }

  req.merchant = rows[0]; // save this info in request object 
  next();
}

module.exports = auth;

// ok in the request header itself there is a x-api-key ,which is basically an alternate to what we 
// are used to in CRUD app , where we have a session key , which gets verified . here we have this 
// api key which is known to merchant only . so this verifies that the request is from this merchant.
