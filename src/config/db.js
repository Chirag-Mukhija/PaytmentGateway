const { Pool } = require('pg');
require('dotenv').config({ quiet: true });
const logger = require('../lib/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // hard cap on concurrent DB connections, the number you already had in mind
});

// without this listener, an error on an idle client (e.g. DB connection
// drops) is an unhandled error that crashes the whole Node process, not
// just the one request using it
pool.on('error', (err) => {
  logger.error('unexpected error on idle postgres client', { err });
});

module.exports = pool;


// we wrote this error handeler because if say database restarts then the pool connections can become stale, which will only be known 
// to backend when they try to ues it later onn . 