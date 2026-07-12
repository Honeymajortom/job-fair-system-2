const express = require('express');
const pool = require('../db');
const asyncHandler = require('../asyncHandler');
const { authenticateJWT } = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const redisCache = require('../middleware/redisCache');
const { toCsv } = require('../lib/csv');

const router = express.Router();

// Reports are Admin-only (permission matrix) and every GET is served through
// the 20s Redis cache — v3.0 §0 #4: the read replica is deleted; at 1000 rows
// the primary + cache covers reporting load with room to spare.
router.use(['/company-stats', '/qual-distribution', '/field-distribution', '/master-report', '/candidate-summary', '/rating-report'],
  authenticateJWT, requireRole('admin'), redisCache(20));

// Per-company funnel — also feeds the FloorMonitor grid header counts.
router.get('/company-stats', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.company_name, c.location,
            COUNT(ccs.id) FILTER (WHERE ccs.deleted_at IS NULL)::int AS assigned,
            COUNT(*) FILTER (WHERE ccs.status = 'Pending' AND ccs.deleted_at IS NULL)::int AS pending,
            COUNT(*) FILTER (WHERE ccs.status = 'Dispatched' AND ccs.deleted_at IS NULL)::int AS at_desk,
            COUNT(*) FILTER (WHERE ccs.status IN ('Selected','Rejected','Shortlisted','Hold') AND ccs.deleted_at IS NULL)::int AS completed,
            COUNT(*) FILTER (WHERE ccs.status = 'Selected' AND ccs.deleted_at IS NULL)::int AS selected,
            COUNT(*) FILTER (WHERE ccs.status = 'No_Show' AND ccs.deleted_at IS NULL)::int AS no_shows
     FROM companies c
     LEFT JOIN candidate_company_status ccs ON ccs.company_id = c.id
     GROUP BY c.id
     ORDER BY c.company_name`
  );
  if (req.query.format === 'csv') {
    return res.type('text/csv').attachment('company-stats.csv').send(toCsv(result.rows));
  }
  res.json(result.rows);
}));

router.get('/qual-distribution', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(qualification), ''), 'Unknown') AS qualification, COUNT(*)::int AS count
     FROM candidates WHERE deleted_at IS NULL
     GROUP BY 1 ORDER BY count DESC, qualification`
  );
  if (req.query.format === 'csv') {
    return res.type('text/csv').attachment('qual-distribution.csv').send(toCsv(result.rows));
  }
  res.json(result.rows);
}));

router.get('/field-distribution', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(field), ''), 'Unknown') AS field, COUNT(*)::int AS count
     FROM candidates WHERE deleted_at IS NULL
     GROUP BY 1 ORDER BY count DESC, field`
  );
  if (req.query.format === 'csv') {
    return res.type('text/csv').attachment('field-distribution.csv').send(toCsv(result.rows));
  }
  res.json(result.rows);
}));

// One row per (candidate, company) assignment — the full export.
router.get('/master-report', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT cd.token_no, cd.name, cd.mobile, cd.qualification, cd.field, cd.employment_status,
            b.batch_number, cd.checked_in_at IS NOT NULL AS checked_in,
            c.company_name, s.slot_start, ccs.status, ccs.ratings, ccs.feedback_text,
            u.username AS feedback_by, ccs.processed_at
     FROM candidate_company_status ccs
     JOIN candidates cd ON cd.id = ccs.candidate_id AND cd.deleted_at IS NULL
     JOIN companies c ON c.id = ccs.company_id
     LEFT JOIN interview_slots s ON s.id = ccs.slot_id
     LEFT JOIN fair_batches b ON b.id = cd.batch_id
     LEFT JOIN users u ON u.id = ccs.feedback_by
     WHERE ccs.deleted_at IS NULL
     ORDER BY cd.token_no, s.slot_start ASC NULLS LAST`
  );
  if (req.query.format === 'csv') {
    return res.type('text/csv').attachment('master-report.csv').send(toCsv(result.rows));
  }
  res.json(result.rows);
}));

// One row per candidate — assignment/outcome rollup.
router.get('/candidate-summary', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT cd.token_no, cd.name, cd.qualification, cd.field,
            b.batch_number, cd.checked_in_at IS NOT NULL AS checked_in,
            COUNT(ccs.id) FILTER (WHERE ccs.deleted_at IS NULL)::int AS companies_assigned,
            COUNT(*) FILTER (WHERE ccs.status IN ('Selected','Rejected','Shortlisted','Hold') AND ccs.deleted_at IS NULL)::int AS interviews_done,
            COUNT(*) FILTER (WHERE ccs.status = 'Selected' AND ccs.deleted_at IS NULL)::int AS selections,
            COUNT(*) FILTER (WHERE ccs.status = 'No_Show' AND ccs.deleted_at IS NULL)::int AS no_shows
     FROM candidates cd
     LEFT JOIN candidate_company_status ccs ON ccs.candidate_id = cd.id
     LEFT JOIN fair_batches b ON b.id = cd.batch_id
     WHERE cd.deleted_at IS NULL
     GROUP BY cd.id, b.batch_number
     ORDER BY cd.token_no`
  );
  if (req.query.format === 'csv') {
    return res.type('text/csv').attachment('candidate-summary.csv').send(toCsv(result.rows));
  }
  res.json(result.rows);
}));

// Average rating per (company, parameter) from the ratings JSONB.
router.get('/rating-report', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT c.company_name, r.key AS parameter,
            ROUND(AVG(r.value::numeric), 2)::float AS avg_rating,
            COUNT(*)::int AS ratings_count
     FROM candidate_company_status ccs
     JOIN companies c ON c.id = ccs.company_id
     CROSS JOIN LATERAL jsonb_each_text(ccs.ratings) AS r(key, value)
     WHERE ccs.ratings IS NOT NULL AND ccs.deleted_at IS NULL
     GROUP BY c.company_name, r.key
     ORDER BY c.company_name, r.key`
  );
  if (req.query.format === 'csv') {
    return res.type('text/csv').attachment('rating-report.csv').send(toCsv(result.rows));
  }
  res.json(result.rows);
}));

module.exports = router;
