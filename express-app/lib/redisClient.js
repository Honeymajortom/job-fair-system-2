require('dotenv').config();
const IORedis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Shared client for rate-limit counters and the report/tile cache.
// maxRetriesPerRequest: 1 + no offline queue → commands fail fast, so the
// middlewares that use this can fail OPEN instead of hanging requests when
// Redis is down. (BullMQ keeps its own connection in lib/dispatchQueue.js —
// it needs maxRetriesPerRequest: null, which is the opposite trade-off.)
const client = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});
client.on('error', (err) => console.error('[redis] error:', err.message));

module.exports = client;
