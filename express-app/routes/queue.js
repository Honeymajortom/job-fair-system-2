const express = require('express');
const pool = require('../db');
const asyncHandler = require('../asyncHandler');
const { authenticateJWT } = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const redisCache = require('../middleware/redisCache');
const { emit } = require('../lib/events');
const { verifyQr } = require('../lib/checkinSig');
const dispatcher = require('../lib/queueDispatcher');
const { clearNoShowTimer } = require('../lib/noShowTimer');
const redis = require('../lib/redisClient');

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

  // CTE captures the pre-update status (+ queue-system fields) so the
  // statsDelta knows whether the candidate was at the desk (Dispatched) or
  // still pending (v3.0 §8), and so we know whether this booking went
  // through the new dispatch model at all (serial IS NOT NULL) below.
  const result = await pool.query(
    `WITH old AS (
       SELECT id, status, serial, dispatched_at FROM candidate_company_status
       WHERE candidate_id = $5 AND company_id = $6 AND deleted_at IS NULL
     )
     UPDATE candidate_company_status ccs
     SET status = $1, ratings = $2, feedback_text = $3, feedback_by = $4, processed_at = now()
     FROM old WHERE ccs.id = old.id
     RETURNING ccs.*, old.status AS old_status, old.serial AS old_serial, old.dispatched_at AS old_dispatched_at`,
    [status, ratings ? JSON.stringify(ratings) : null, feedback_text || null, req.user.id, candidateId, company_id]
  );

  if (!result.rows.length) return res.status(404).json({ error: 'No matching assignment for this candidate and company' });
  const { old_status, old_serial, old_dispatched_at, ...row } = result.rows[0];

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

  // Queue-system Phase 3: this is the "done tap" — new_architecture_uiux_spec.html's
  // desk tablet combines recording a result with releasing the desk. Only
  // fires for bookings that went through the new model (serial IS NOT NULL);
  // v1-era rows (slot_id, no serial) are untouched. deskId comes from the
  // Redis lock itself rather than trusting a client-supplied value.
  if (old_serial != null && old_status === 'Dispatched') {
    const deskId = await redis.get(`lock:${candidateId}`);
    if (deskId) {
      const serviceMinutes = old_dispatched_at
        ? Math.max(0.5, (Date.now() - new Date(old_dispatched_at).getTime()) / 60000)
        : 6;
      await dispatcher.completeInterview({ candidateId, companyId: Number(company_id), deskId, serviceMinutes });
    }
  }

  res.json(row);
}));

// Admin / Floor Manager / Company HR: desk tablet asks for its first
// candidate, or nudges a desk that's sitting on the waiting list — exposes
// dispatch(companyId, deskId) over HTTP for the first time (Phase 1/2 only
// exercised it via fixtures). Normal backfill after a result doesn't need
// this — completeInterview() above already re-dispatches the same desk.
router.post('/queue/desk/next', authenticateJWT, requireRole('admin', 'floor_manager', 'company_hr'), asyncHandler(async (req, res) => {
  const { company_id, desk_id } = req.body;
  if (!company_id || !desk_id) return res.status(400).json({ error: 'company_id and desk_id are required' });
  const dispatched = await dispatcher.dispatch(Number(company_id), String(desk_id));
  res.json({ dispatched });
}));

// Admin / Floor Manager / Company HR: desk QR scan confirms the candidate
// physically arrived — clears the no-show timer armed at dispatch
// (new_architecture.md §3.4/§6.1). Reuses the same HMAC QR scheme as the
// entrance gate's checkin_sig, just verified here instead of at check-in.
router.post('/queue/confirm-arrival', authenticateJWT, requireRole('admin', 'floor_manager', 'company_hr'), asyncHandler(async (req, res) => {
  const { qr, token, company_id } = req.body;
  let tokenNo = token;
  if (qr) {
    tokenNo = verifyQr(qr);
    if (!tokenNo) return res.status(400).json({ error: 'Invalid or forged QR' });
  }
  if (!tokenNo || !company_id) return res.status(400).json({ error: 'qr (or token) and company_id are required' });

  const candRes = await pool.query('SELECT id FROM candidates WHERE token_no = $1 AND deleted_at IS NULL', [tokenNo]);
  if (!candRes.rows.length) return res.status(404).json({ error: 'Candidate not found' });
  const candidateId = candRes.rows[0].id;

  const ccsRes = await pool.query(
    `SELECT id FROM candidate_company_status WHERE candidate_id = $1 AND company_id = $2 AND status = 'Dispatched' AND deleted_at IS NULL`,
    [candidateId, company_id]
  );
  if (!ccsRes.rows.length) return res.status(404).json({ error: 'This candidate is not currently dispatched to this company' });

  const cleared = await clearNoShowTimer(candidateId, Number(company_id));
  res.json({ ok: true, timer_cleared: cleared });
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
