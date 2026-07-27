require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — copy .env.example to .env and fill it in');
}

// Registration-morning spikes hold one connection per in-flight request for
// the whole transaction (including advisory-lock waits) — the pg default
// (max: 10) meant request #11 queued on pool.connect() before it even
// started. Raised, plus explicit timeouts so saturation fails fast with a
// clear error instead of a silent hang.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

module.exports = pool;
