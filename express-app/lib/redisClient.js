require('dotenv').config();
const IORedis = require('ioredis');
const { CircuitBreaker } = require('./circuitBreaker');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Shared client for rate-limit counters and the report/tile cache.
// maxRetriesPerRequest: 1 + no offline queue → commands fail fast, so the
// middlewares that use this can fail OPEN instead of hanging requests when
// Redis is down. (BullMQ keeps its own connection in lib/dispatchQueue.js —
// it needs maxRetriesPerRequest: null, which is the opposite trade-off.)
// connectTimeout/commandTimeout bound the *worst case* of a single call —
// without these, a hung (not merely refused) connection falls back to
// ioredis's own 10s default, which every one of this client's many
// concurrent callers would separately pay during a Redis brownout.
const client = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: 2000,
  commandTimeout: 1500,
});
client.on('error', (err) => console.error('[redis] error:', err.message));

// Every caller of this module already treats a thrown/rejected command as
// "Redis is unavailable, fall back" — rateLimit.js's in-process counter,
// redisCache.js's "skip the cache", queueStore.js's callers wrapping enqueue
// in try/catch, etc. Without a breaker, each of those callers still pays a
// real (bounded, but non-zero) connect/command timeout on *every* request
// while Redis is degraded, and a flood of concurrent requests all retrying
// the same dying connection is exactly the "slowness cascades into everyone
// waiting" scenario a breaker exists to prevent. Once GUARDED_METHODS below
// have failed 5 times, the breaker trips open for 15s — real Redis calls
// simply aren't attempted during that window, every caller's existing
// fallback kicks in immediately — then allows one trial call through to test
// recovery before fully closing again.
const breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 15000, halfOpenMaxConcurrent: 1 });

// The exact command surface every call site in this app actually uses (see
// queueStore.js, middleware/rateLimit.js, middleware/redisCache.js,
// lib/noShowTimer.js, lib/bufferController.js, lib/travelBuffer.js) — kept as
// an explicit list rather than guarding every property so lifecycle methods
// (disconnect/quit/on/duplicate/status/...) always pass straight through to
// the real client, unaffected by breaker state; those aren't "a dependency
// call that should fast-fail", they're connection-management calls the
// fixtures' cleanup and process shutdown need to always reach.
const GUARDED_METHODS = new Set([
  'get', 'set', 'incr', 'expire', 'mget', 'del', 'exists',
  'sadd', 'spop', 'srem', 'zadd', 'zcard', 'zincrby', 'zrange', 'zrank', 'zrem',
]);

const guardedClient = new Proxy(client, {
  get(target, prop, receiver) {
    if (GUARDED_METHODS.has(prop)) {
      return (...args) => breaker.exec(() => target[prop](...args));
    }
    const value = Reflect.get(target, prop, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

module.exports = guardedClient;
