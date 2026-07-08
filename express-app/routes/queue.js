const express = require('express');
const pool = require('../db');
const asyncHandler = require('../asyncHandler');
const { authenticateJWT } = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const redisCache = require('../middleware/redisCache');
const { emit } = require('../lib/events');

const router = express.Router();

const VALID_STATUSES = ['Selected', 'Rejected', 'Shortlisted', 'Hold', 'No_Show'];

// Company HR (+ Admin / Floor Manager oversight): pending queue for a desk, earliest slot first
router.get('/queue/:companyId', authenticateJWT, requireRole('admin', 'floor_manager', 'company_hr'), asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT ccs.id AS ccs_id, ccs.status, s.slot_start,
            cd.id AS candidate_id, cd.token_no, cd.name, cd.qualification, cd.field, cd.employment_status
     FROM candidate_company_status ccs
     JOIN candidates cd ON cd.id = ccs.candidate_id
     LEFT JOIN interview_slots s ON s.id = ccs.slot_id
     WHERE ccs.company_id = $1 AND ccs.status = 'Pending'
       AND ccs.deleted_at IS NULL AND cd.deleted_at IS NULL
     ORDER BY s.slot_start ASC NULLS LAST`,
    [req.params.companyId]
  );
  res.json(result.rows);
}));

// Admin / Floor Manager: quick fair-wide stats — the dashboards' 30s reconcile
// poll. Cached 20s (v3.0 §0 #4): deltas keep screens live, this corrects drift.
router.get('/stats', authenticateJWT, requireRole('admin', 'floor_manager'), redisCache(20), asyncHandler(async (_req, res) => {
  const [registered, completed, pending, companies] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS n FROM candidates WHERE deleted_at IS NULL'),
    pool.query("SELECT COUNT(*)::int AS n FROM candidate_company_status WHERE status != 'Pending' AND deleted_at IS NULL"),
    pool.query("SELECT COUNT(*)::int AS n FROM candidate_company_status WHERE status = 'Pending' AND deleted_at IS NULL"),
    pool.query('SELECT COUNT(*)::int AS n FROM companies'),
  ]);
  res.json({
    registered: registered.rows[0].n,
    completed: completed.rows[0].n,
    pending: pending.rows[0].n,
    companies: companies.rows[0].n,
  });
}));

// Company HR (+ Admin): record interview result + ratings + feedback
router.put('/interview-result', authenticateJWT, requireRole('admin', 'company_hr'), asyncHandler(async (req, res) => {
  const { token, company_id, status, ratings, feedback_text } = req.body;

  if (!token || !company_id || !status) {
    return res.status(400).json({ error: 'token, company_id and status are required' });
  }
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${VALID_STATUSES.join(', ')}` });
  }

  const candidateRes = await pool.query('SELECT id FROM candidates WHERE token_no = $1 AND deleted_at IS NULL', [token]);
  if (!candidateRes.rows.length) return res.status(404).json({ error: 'Candidate not found' });
  const candidateId = candidateRes.rows[0].id;

  // Validate ratings JSONB against this company's configured parameters before writing anything —
  // garbage data from a bad client should never reach the DB.
  if (ratings && Object.keys(ratings).length) {
    const paramsRes = await pool.query(
      'SELECT parameter_name FROM rating_parameters WHERE company_id = $1',
      [company_id]
    );
    const allowed = new Set(paramsRes.rows.map((r) => r.parameter_name));
    for (const [key, value] of Object.entries(ratings)) {
      if (!allowed.has(key)) return res.status(400).json({ error: `Unknown rating parameter: ${key}` });
      if (!Number.isInteger(value) || value < 1 || value > 5) {
        return res.status(400).json({ error: `Rating for ${key} must be an integer between 1 and 5` });
      }
    }
  }

  // CTE captures the pre-update status so the statsDelta knows whether the
  // candidate was at the desk (Dispatched) or still pending (v3.0 §8).
  const result = await pool.query(
    `WITH old AS (
       SELECT id, status FROM candidate_company_status
       WHERE candidate_id = $5 AND company_id = $6 AND deleted_at IS NULL
     )
     UPDATE candidate_company_status ccs
     SET status = $1, ratings = $2, feedback_text = $3, feedback_by = $4, processed_at = now()
     FROM old WHERE ccs.id = old.id
     RETURNING ccs.*, old.status AS old_status`,
    [status, ratings ? JSON.stringify(ratings) : null, feedback_text || null, req.user.id, candidateId, company_id]
  );

  if (!result.rows.length) return res.status(404).json({ error: 'No matching assignment for this candidate and company' });
  const { old_status, ...row } = result.rows[0];

  const statsDelta = { completed: 1 };
  if (old_status === 'Dispatched') statsDelta.atDesk = -1;
  else if (old_status === 'Pending') statsDelta.pending = -1;
  emit('interview_processed', {
    token,
    company_id: Number(company_id),
    result: status,
    slot_id: row.slot_id,
    statsDelta,
  });

  res.json(row);
}));

// Admin / Floor Manager: mark a no-show (flow D) — frees the desk; the slot
// can then be given to someone else via PUT /slots/:id/reassign.
router.post('/no-show', authenticateJWT, requireRole('admin', 'floor_manager'), asyncHandler(async (req, res) => {
  const { token, company_id } = req.body;
  if (!token || !company_id) return res.status(400).json({ error: 'token and company_id are required' });

  const result = await pool.query(
    `WITH old AS (
       SELECT ccs.id, ccs.status, ccs.slot_id FROM candidate_company_status ccs
       JOIN candidates cd ON cd.id = ccs.candidate_id AND cd.deleted_at IS NULL
       WHERE cd.token_no = $1 AND ccs.company_id = $2 AND ccs.deleted_at IS NULL
         AND ccs.status IN ('Pending', 'Dispatched')
     )
     UPDATE candidate_company_status ccs
     SET status = 'No_Show', processed_at = now()
     FROM old WHERE ccs.id = old.id
     RETURNING ccs.id, ccs.slot_id, old.status AS old_status`,
    [token, company_id]
  );
  if (!result.rows.length) {
    return res.status(404).json({ error: 'No pending or dispatched assignment for this candidate and company' });
  }
  const row = result.rows[0];

  const statsDelta = { noShows: 1 };
  if (row.old_status === 'Dispatched') statsDelta.atDesk = -1;
  else statsDelta.pending = -1;
  emit('no_show_marked', { token, company_id: Number(company_id), slot_id: row.slot_id, statsDelta });

  res.json({ ok: true, ccs_id: row.id, slot_id: row.slot_id });
}));

module.exports = router;
