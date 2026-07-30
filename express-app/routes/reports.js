const express = require('express');
const pool = require('../db');
const asyncHandler = require('../asyncHandler');
const { authenticateJWT } = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const redisCache = require('../middleware/redisCache');
const { toCsv } = require('../lib/csv');
const { computeInsights } = require('../lib/insights');
const { resolveCenterFilter } = require('../lib/centerScope');

const router = express.Router();

// Reports are Admin-only (permission matrix) and every GET is served through
// the 20s Redis cache — v3.0 §0 #4: the read replica is deleted; at 1000 rows
// the primary + cache covers reporting load with room to spare.
router.use(['/company-stats', '/qual-distribution', '/field-distribution', '/master-report', '/candidate-summary', '/rating-report', '/company-hr-feedback-report', '/insights'],
  authenticateJWT, requireRole('admin'), redisCache(20));

// Shared ?date= validation for the six reports below — same YYYY-MM-DD
// shape /insights already enforces. Returns null (no filter) when omitted,
// the validated string when given, or sends the 400 itself and returns
// undefined as a "stop, response already sent" sentinel for the caller.
function parseDateFilter(req, res) {
  const { date } = req.query;
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    return undefined;
  }
  return date;
}

// Per-company funnel — also feeds the FloorMonitor grid header counts.
// centerId (fair_cycle_isolation_plan.md Phase 4, all six reports below):
// every route in this file is admin-only (see router.use above), so the only
// scoping source is the optional ?center_id= query param — no non-admin
// pinning to reconcile, unlike the staff-facing endpoints elsewhere.
router.get('/company-stats', asyncHandler(async (req, res) => {
  const centerId = resolveCenterFilter(req);
  const dateFilter = parseDateFilter(req, res);
  if (dateFilter === undefined) return;
  // Date-scoping happens in a CTE, not a bare WHERE after the LEFT JOIN —
  // same fan-out-avoidance shape as lib/floorStats.js's on_hand query and
  // lib/insights.js's cand CTE: filtering the join column directly in WHERE
  // would silently turn this into an INNER JOIN for date matching, making a
  // company with zero candidates *that day* vanish from the report instead
  // of correctly showing zeros.
  // Historical vs. live-state deleted_at filtering (same reasoning as
  // lib/floorStats.js/lib/insights.js): assigned/completed/selected/no_shows
  // are historical facts that stay true after a candidate exits or gets
  // soft-deleted — excluding them made these reports under-count anyone who'd
  // already left by the time the report was pulled. pending/at_desk describe
  // the moment, not history, so those keep excluding exited/deleted rows.
  // company_roster_plan.md: this report groups per company across every
  // cycle by default (no single fair_settings_id to key a roster join off,
  // unlike master-report/candidate-summary's per-row candidates.fair_
  // settings_id) — floor_number dropped from the output entirely rather than
  // showing a potentially-stale/ambiguous value from whichever cycle happens
  // to be active right now; it was display-only here, never used in any of
  // this report's own funnel/capacity math.
  const result = await pool.query(
    `WITH ccs_scoped AS (
       SELECT ccs.*, cd.deleted_at AS cd_deleted_at FROM candidate_company_status ccs
       JOIN candidates cd ON cd.id = ccs.candidate_id
       WHERE ($2::date IS NULL OR cd.registered_at::date = $2::date)
     )
     SELECT c.id, c.company_name, c.location,
            COUNT(ccs.id)::int AS assigned,
            COUNT(*) FILTER (WHERE ccs.status = 'Pending' AND ccs.deleted_at IS NULL AND ccs.cd_deleted_at IS NULL)::int AS pending,
            COUNT(*) FILTER (WHERE ccs.status = 'Dispatched' AND ccs.deleted_at IS NULL AND ccs.cd_deleted_at IS NULL)::int AS at_desk,
            COUNT(*) FILTER (WHERE ccs.status IN ('Selected','Rejected','Shortlisted','Hold'))::int AS completed,
            COUNT(*) FILTER (WHERE ccs.status = 'Selected')::int AS selected,
            COUNT(*) FILTER (WHERE ccs.status = 'No_Show')::int AS no_shows
     FROM companies c
     LEFT JOIN ccs_scoped ccs ON ccs.company_id = c.id
     WHERE ($1::int IS NULL OR c.center_id = $1)
     GROUP BY c.id
     ORDER BY c.company_name`,
    [centerId || null, dateFilter]
  );
  if (req.query.format === 'csv') {
    const headers = ['id', 'company_name', 'location', 'assigned', 'pending', 'at_desk', 'completed', 'selected', 'no_shows'];
    return res.type('text/csv').attachment('company-stats.csv').send(toCsv(result.rows, headers));
  }
  res.json(result.rows);
}));

router.get('/qual-distribution', asyncHandler(async (req, res) => {
  const centerId = resolveCenterFilter(req);
  const dateFilter = parseDateFilter(req, res);
  if (dateFilter === undefined) return;
  // Historical: qualification is a fact about the candidate, unaffected by
  // whether they later exited or were soft-deleted — see reasoning above
  // company-stats.
  const result = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(cd.qualification), ''), 'Unknown') AS qualification, COUNT(*)::int AS count
     FROM candidates cd
     LEFT JOIN fair_settings fs ON fs.id = cd.fair_settings_id
     WHERE ($1::int IS NULL OR fs.center_id = $1)
       AND ($2::date IS NULL OR cd.registered_at::date = $2::date)
     GROUP BY 1 ORDER BY count DESC, qualification`,
    [centerId || null, dateFilter]
  );
  if (req.query.format === 'csv') {
    return res.type('text/csv').attachment('qual-distribution.csv').send(toCsv(result.rows, ['qualification', 'count']));
  }
  res.json(result.rows);
}));

router.get('/field-distribution', asyncHandler(async (req, res) => {
  const centerId = resolveCenterFilter(req);
  const dateFilter = parseDateFilter(req, res);
  if (dateFilter === undefined) return;
  // Historical: same reasoning as qual-distribution above.
  const result = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(cd.field), ''), 'Unknown') AS field, COUNT(*)::int AS count
     FROM candidates cd
     LEFT JOIN fair_settings fs ON fs.id = cd.fair_settings_id
     WHERE ($1::int IS NULL OR fs.center_id = $1)
       AND ($2::date IS NULL OR cd.registered_at::date = $2::date)
     GROUP BY 1 ORDER BY count DESC, field`,
    [centerId || null, dateFilter]
  );
  if (req.query.format === 'csv') {
    return res.type('text/csv').attachment('field-distribution.csv').send(toCsv(result.rows, ['field', 'count']));
  }
  res.json(result.rows);
}));

// One row per (candidate, company) assignment — the full export.
router.get('/master-report', asyncHandler(async (req, res) => {
  const centerId = resolveCenterFilter(req);
  const dateFilter = parseDateFilter(req, res);
  if (dateFilter === undefined) return;
  // Historical: the definitive per-candidate record — a booking's real
  // outcome stays true whether or not the candidate has since exited the
  // venue or been soft-deleted (see reasoning above company-stats). This is
  // the one report where under-counting would be most visible/damaging.
  const result = await pool.query(
    `SELECT cd.token_no, cd.name, cd.mobile, cd.qualification, cd.field, cd.employment_status,
            (SELECT string_agg(cwe.company_name || ' (' || cwe.years || 'y ' || cwe.months || 'm)', '; ' ORDER BY cwe.created_at)
               FROM candidate_work_experience cwe WHERE cwe.candidate_id = cd.id) AS work_experience,
            b.batch_number, cd.checked_in_at IS NOT NULL AS checked_in,
            c.company_name, s.slot_start, ccs.status, ccs.ratings, ccs.feedback_text,
            u.username AS feedback_by, ccs.processed_at
     FROM candidate_company_status ccs
     JOIN candidates cd ON cd.id = ccs.candidate_id
     JOIN companies c ON c.id = ccs.company_id
     LEFT JOIN interview_slots s ON s.id = ccs.slot_id
     LEFT JOIN fair_batches b ON b.id = cd.batch_id
     LEFT JOIN users u ON u.id = ccs.feedback_by
     WHERE ($1::int IS NULL OR c.center_id = $1)
       AND ($2::date IS NULL OR cd.registered_at::date = $2::date)
     ORDER BY cd.token_no, s.slot_start ASC NULLS LAST`,
    [centerId || null, dateFilter]
  );
  if (req.query.format === 'csv') {
    const headers = ['token_no', 'name', 'mobile', 'qualification', 'field', 'employment_status', 'work_experience', 'batch_number',
      'checked_in', 'company_name', 'slot_start', 'status', 'ratings', 'feedback_text', 'feedback_by', 'processed_at'];
    return res.type('text/csv').attachment('master-report.csv').send(toCsv(result.rows, headers));
  }
  res.json(result.rows);
}));

// One row per candidate — assignment/outcome rollup.
router.get('/candidate-summary', asyncHandler(async (req, res) => {
  const centerId = resolveCenterFilter(req);
  const dateFilter = parseDateFilter(req, res);
  if (dateFilter === undefined) return;
  // Historical: same reasoning as master-report above — this rollup should
  // still include a candidate (and their real outcomes) after they exit.
  const result = await pool.query(
    `SELECT cd.token_no, cd.name, cd.qualification, cd.field, cd.employment_status,
            (SELECT string_agg(cwe.company_name || ' (' || cwe.years || 'y ' || cwe.months || 'm)', '; ' ORDER BY cwe.created_at)
               FROM candidate_work_experience cwe WHERE cwe.candidate_id = cd.id) AS work_experience,
            b.batch_number, cd.checked_in_at IS NOT NULL AS checked_in,
            COUNT(ccs.id)::int AS companies_assigned,
            COUNT(*) FILTER (WHERE ccs.status IN ('Selected','Rejected','Shortlisted','Hold'))::int AS interviews_done,
            COUNT(*) FILTER (WHERE ccs.status = 'Selected')::int AS selections,
            COUNT(*) FILTER (WHERE ccs.status = 'No_Show')::int AS no_shows
     FROM candidates cd
     LEFT JOIN candidate_company_status ccs ON ccs.candidate_id = cd.id
     LEFT JOIN fair_batches b ON b.id = cd.batch_id
     LEFT JOIN fair_settings fs ON fs.id = cd.fair_settings_id
     WHERE ($1::int IS NULL OR fs.center_id = $1)
       AND ($2::date IS NULL OR cd.registered_at::date = $2::date)
     GROUP BY cd.id, b.batch_number
     ORDER BY cd.token_no`,
    [centerId || null, dateFilter]
  );
  if (req.query.format === 'csv') {
    const headers = ['token_no', 'name', 'qualification', 'field', 'employment_status', 'work_experience', 'batch_number', 'checked_in',
      'companies_assigned', 'interviews_done', 'selections', 'no_shows'];
    return res.type('text/csv').attachment('candidate-summary.csv').send(toCsv(result.rows, headers));
  }
  res.json(result.rows);
}));

// Average rating per (company, parameter) from the ratings JSONB.
router.get('/rating-report', asyncHandler(async (req, res) => {
  const centerId = resolveCenterFilter(req);
  const dateFilter = parseDateFilter(req, res);
  if (dateFilter === undefined) return;
  // Historical: a rating that was actually given stays valid regardless of
  // whether the candidate has since exited or been soft-deleted.
  const result = await pool.query(
    `SELECT c.company_name, r.key AS parameter,
            ROUND(AVG(r.value::numeric), 2)::float AS avg_rating,
            COUNT(*)::int AS ratings_count
     FROM candidate_company_status ccs
     JOIN companies c ON c.id = ccs.company_id
     JOIN candidates cd ON cd.id = ccs.candidate_id
     CROSS JOIN LATERAL jsonb_each_text(ccs.ratings) AS r(key, value)
     WHERE ccs.ratings IS NOT NULL AND ($1::int IS NULL OR c.center_id = $1)
       AND ($2::date IS NULL OR cd.registered_at::date = $2::date)
     GROUP BY c.company_name, r.key
     ORDER BY c.company_name, r.key`,
    [centerId || null, dateFilter]
  );
  if (req.query.format === 'csv') {
    const headers = ['company_name', 'parameter', 'avg_rating', 'ratings_count'];
    return res.type('text/csv').attachment('rating-report.csv').send(toCsv(result.rows, headers));
  }
  res.json(result.rows);
}));

// candidate_and_desk_improvements_plan.md §D: the seventh CSV export, seeded
// by DeskTablet.jsx's "Close Desk" feedback form (routes/companies.js's
// POST /companies/:id/close-desk). One row per company per fair cycle
// (company_hr_feedback's own UNIQUE(company_id, fair_settings_id)) — not
// day-scoped like the six reports above, since a desk closes once per cycle,
// not per registration day.
router.get('/company-hr-feedback-report', asyncHandler(async (req, res) => {
  const centerId = resolveCenterFilter(req);
  const result = await pool.query(
    `SELECT c.company_name, to_char(fs.fair_date, 'YYYY-MM-DD') AS fair_date,
            f.candidate_quality, f.venue_rating, f.app_performance_rating,
            f.volunteer_satisfaction, f.future_interest, f.submitted_at
     FROM company_hr_feedback f
     LEFT JOIN companies c ON c.id = f.company_id
     LEFT JOIN fair_settings fs ON fs.id = f.fair_settings_id
     WHERE ($1::int IS NULL OR c.center_id = $1)
     ORDER BY fs.fair_date DESC, c.company_name`,
    [centerId || null]
  );
  if (req.query.format === 'csv') {
    const headers = ['company_name', 'fair_date', 'candidate_quality', 'venue_rating',
      'app_performance_rating', 'volunteer_satisfaction', 'future_interest', 'submitted_at'];
    return res.type('text/csv').attachment('company-hr-feedback-report.csv').send(toCsv(result.rows, headers));
  }
  res.json(result.rows);
}));

// Insights tab (admin) — per-company vacancy/outcome/demographic breakdown,
// optionally scoped to one registration day (?date=YYYY-MM-DD) and/or one
// Center (?center_id=). Distinct from the reports above: those are flat
// CSV-shaped exports, this is a computed summary (totals + per-company rows)
// meant for the dashboard, not a download.
router.get('/insights', asyncHandler(async (req, res) => {
  const { date } = req.query;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  res.json(await computeInsights({ date, centerId: resolveCenterFilter(req) }));
}));

module.exports = router;
