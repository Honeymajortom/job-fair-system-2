// routes/reports.js caches all 8 admin report/insights endpoints for 20s
// (redisCache(20)) with no write-side invalidation anywhere in the codebase
// (STAFF_INCONSISTENCY_REPORT.md S9) — same TTL-only gap already found and
// fixed for the candidate schedule page and the Floor dashboard. Unlike
// those two, there's no single shared URL prefix across all 8 report paths,
// so this loops a pattern-scan per path instead of one combined pattern.
const redis = require('./redisClient');

const REPORT_PATHS = [
  'company-stats', 'qual-distribution', 'field-distribution', 'master-report',
  'candidate-summary', 'rating-report', 'company-hr-feedback-report', 'insights',
];

async function invalidateReportsCache() {
  try {
    const keyLists = await Promise.all(REPORT_PATHS.map((p) => redis.keys(`cache:/api/${p}*`)));
    const keys = keyLists.flat();
    if (keys.length) await redis.del(...keys);
  } catch (_err) { /* best-effort, same convention as every other cache write in this app */ }
}

module.exports = { invalidateReportsCache };
