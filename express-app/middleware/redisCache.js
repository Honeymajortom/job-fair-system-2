const redis = require('../lib/redisClient');

// GET-response cache (v3.0 §7) — keyed by URL, JSON bodies only, fails open.
// Only 200s are cached; the X-Cache header makes hits observable in curl.
module.exports = (ttlSec) => async (req, res, next) => {
  const key = `cache:${req.originalUrl}`;
  try {
    const hit = await redis.get(key);
    if (hit) {
      res.set('X-Cache', 'HIT');
      return res.type('application/json').send(hit);
    }
  } catch (_err) { /* fall through to the route */ }

  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 200) {
      redis.set(key, JSON.stringify(body), 'EX', ttlSec).catch(() => {});
    }
    res.set('X-Cache', 'MISS');
    return json(body);
  };
  next();
};
