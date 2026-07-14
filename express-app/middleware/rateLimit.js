const redis = require('../lib/redisClient');

// Red-team M2: a Redis outage used to mean *no* limiting at all — every
// registration/login limiter in the app is built on this factory, so a
// down/pressured Redis was a free pass to flood /qr/register or /login.
// This in-process fixed-window map is the last-resort backstop for exactly
// that window: it only ever runs when the Redis call itself throws, and it
// only bounds this one process's view (fine — ecosystem.config.js runs the
// API in fork mode, a single process). Swept periodically so a sustained
// outage with many distinct keys (mobiles/IPs) can't grow this unbounded.
const fallbackStore = new Map(); // `${prefix}:${key}` -> { count, resetAt }
const SWEEP_INTERVAL_MS = 60 * 1000;
let lastSweep = Date.now();

function fallbackExceeded(fallbackKey, windowSec, max) {
  const now = Date.now();
  if (now - lastSweep > SWEEP_INTERVAL_MS) {
    lastSweep = now;
    for (const [k, v] of fallbackStore) {
      if (v.resetAt <= now) fallbackStore.delete(k);
    }
  }

  let entry = fallbackStore.get(fallbackKey);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowSec * 1000 };
    fallbackStore.set(fallbackKey, entry);
  }
  entry.count += 1;
  return entry.count > max;
}

// Fixed-window Redis counter (v3.0 §5) — one INCR + EXPIRE per request,
// counters shared across processes. key(req) returning null/undefined skips
// the limiter for that request.
module.exports = function rateLimit({ prefix, windowSec, max, key }) {
  return async (req, res, next) => {
    let k = null;
    try {
      k = key(req);
    } catch (_err) { /* malformed input — let route validation reject it */ }
    if (!k) return next();

    const redisKey = `rl:${prefix}:${k}`;
    try {
      const n = await redis.incr(redisKey);
      if (n === 1) await redis.expire(redisKey, windowSec);
      if (n > max) {
        return res.status(429).json({ error: 'Too many requests — please try again in a few minutes' });
      }
    } catch (err) {
      console.warn(`[rateLimit:${prefix}] Redis unavailable, using in-process fallback limiter:`, err.message);
      if (fallbackExceeded(redisKey, windowSec, max)) {
        return res.status(429).json({ error: 'Too many requests — please try again in a few minutes' });
      }
    }
    next();
  };
};
