const redis = require('../lib/redisClient');

// GET-response cache (v3.0 §7) — keyed by URL, JSON bodies only, fails open.
// Only 200s are cached; the X-Cache header makes hits observable in curl.
// keySuffix (fair_cycle_isolation_plan.md Phase 4, optional): a
// non-admin-facing endpoint whose response varies by req.user (e.g.
// floor_manager forced to their own center_id server-side, never appearing in
// the query string itself) would otherwise let two different floor_managers
// collide on the same cache key and see each other's center's data — pass
// e.g. `(req) => req.user.center_id` to keep those responses apart. Endpoints
// whose scoping is entirely query-string-driven (admin's optional
// ?center_id=) don't need this — the URL itself already varies correctly.
module.exports = (ttlSec, keySuffix) => async (req, res, next) => {
  const suffix = keySuffix ? `:${keySuffix(req)}` : '';
  const key = `cache:${req.originalUrl}${suffix}`;
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
