const redis = require('../lib/redisClient');

// Fixed-window Redis counter (v3.0 §5) — one INCR + EXPIRE per request,
// counters shared across processes. Fails OPEN: a Redis outage must never
// block fair-day registrations (the DB constraints still hold either way).
// key(req) returning null/undefined skips the limiter for that request.
module.exports = function rateLimit({ prefix, windowSec, max, key }) {
  return async (req, res, next) => {
    let k = null;
    try {
      k = key(req);
    } catch (_err) { /* malformed input — let route validation reject it */ }
    if (!k) return next();

    try {
      const redisKey = `rl:${prefix}:${k}`;
      const n = await redis.incr(redisKey);
      if (n === 1) await redis.expire(redisKey, windowSec);
      if (n > max) {
        return res.status(429).json({ error: 'Too many requests — please try again in a few minutes' });
      }
    } catch (err) {
      console.warn(`[rateLimit:${prefix}] Redis unavailable, failing open:`, err.message);
    }
    next();
  };
};
