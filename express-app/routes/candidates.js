const express = require('express');
const path = require('path');
const pool = require('../db');
const asyncHandler = require('../asyncHandler');
const { authenticateJWT } = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const requireCompanyScope = require('../middleware/requireCompanyScope');
const registerCandidate = require('../lib/registerCandidate');
const { verifyQr } = require('../lib/checkinSig');
const queueStore = require('../lib/queueStore');
const { emit } = require('../lib/events');
const { RESUME_DIR } = require('../lib/resumeStorage');

const router = express.Router();

// Manual registration (Admin / Registration Staff, per permission matrix) —
// exception path for QR failures (flow D). Same transaction as the public
// path: lib/registerCandidate.js.
router.post('/register', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (req, res) => {
  const result = await registerCandidate(req.body);
  res.status(result.status).json(result.body);
}));

// Staff (any role): candidate directory — feeds the Candidate tab's list
// (filtered client-side by name/token) and FloorMonitor's batch roster
// (grouped client-side by batch_id).
router.get('/candidates', authenticateJWT, asyncHandler(async (_req, res) => {
  const result = await pool.query(
    `SELECT id, token_no, name, qualification, checked_in_at, batch_id, registered_at
     FROM candidates
     WHERE deleted_at IS NULL
     ORDER BY registered_at DESC`
  );
  res.json(result.rows);
}));

// Staff (any role): candidate lookup by token — Company Desk search, volunteer
// directions. The public candidate view is GET /qr/schedule/:token (public.js).
router.get('/candidates/:token', authenticateJWT, asyncHandler(async (req, res) => {
  const candidateRes = await pool.query(
    'SELECT * FROM candidates WHERE token_no = $1 AND deleted_at IS NULL',
    [req.params.token]
  );
  if (!candidateRes.rows.length) return res.status(404).json({ error: 'Candidate not found' });
  const candidate = candidateRes.rows[0];

  const statusRes = await pool.query(
    `SELECT ccs.id, ccs.status, ccs.ratings, ccs.feedback_text, ccs.processed_at, ccs.misses,
            c.id AS company_id, c.company_name, c.location,
            s.slot_start
     FROM candidate_company_status ccs
     JOIN companies c ON c.id = ccs.company_id
     LEFT JOIN interview_slots s ON s.id = ccs.slot_id
     WHERE ccs.candidate_id = $1 AND ccs.deleted_at IS NULL
     ORDER BY s.slot_start ASC NULLS LAST`,
    [candidate.id]
  );

  res.json({ ...candidate, companies: statusRes.rows });
}));

// Admin / Floor Manager / Company HR: serve an uploaded resume — inline, not
// as a forced download, since HR needs to read it during the interview.
// Gated server-side, not just hidden in the UI: everyone (admin and
// floor_manager included, no fair-wide bypass) only sees it once this
// candidate's interview at this specific company has actually started, so
// nobody can pre-judge a candidate before meeting them. requireCompanyScope
// additionally confines a company_hr account to its own company_id.
router.get('/candidates/:token/resume', authenticateJWT, requireRole('admin', 'floor_manager', 'company_hr'), requireCompanyScope((req) => req.query.company_id), asyncHandler(async (req, res) => {
  const companyId = Number(req.query.company_id);
  if (!companyId) return res.status(400).json({ error: 'company_id is required' });

  const candRes = await pool.query(
    'SELECT id, resume_uploaded_at FROM candidates WHERE token_no = $1 AND deleted_at IS NULL',
    [req.params.token]
  );
  if (!candRes.rows.length) return res.status(404).json({ error: 'Candidate not found' });
  const candidate = candRes.rows[0];
  if (!candidate.resume_uploaded_at) return res.status(404).json({ error: 'No resume on file' });

  const ccsRes = await pool.query(
    `SELECT status, interview_started_at FROM candidate_company_status
      WHERE candidate_id = $1 AND company_id = $2 AND deleted_at IS NULL`,
    [candidate.id, companyId]
  );
  const ccs = ccsRes.rows[0];
  if (!ccs || ccs.status !== 'Dispatched' || !ccs.interview_started_at) {
    return res.status(403).json({ error: 'Resume is only viewable after the interview has started' });
  }

  res.sendFile(path.join(RESUME_DIR, `${req.params.token}.pdf`));
}));

// Admin / Floor Manager: emergency batch reschedule (Waiting Room drag-and-drop)
// — moves which arrival wave a candidate belongs to. Queue-system Phase 6
// cutover: this used to also re-pick an interview_slots row per company and
// enqueue a v1 dispatch job (PUT /slots/:id/reassign's sibling) — that logic
// silently did nothing for anyone booked under the new count-based queue
// model, since a candidate's queue position (serial) is fixed at registration
// and has never depended on batch_id; removed rather than fixed forward, per
// handoff.md's own flag that this needed resolving before it was relied on.
// A checked-in candidate can't move (would desync fair_batches.checked_in
// from the dispatcher's checked-in guard).
router.put('/candidates/:id/batch', authenticateJWT, requireRole('admin', 'floor_manager'), asyncHandler(async (req, res) => {
  const { batch_id } = req.body;
  if (!batch_id) return res.status(400).json({ error: 'batch_id is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const candRes = await client.query(
      'SELECT id, token_no, batch_id, checked_in_at FROM candidates WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [req.params.id]
    );
    if (!candRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Candidate not found' });
    }
    const candidate = candRes.rows[0];
    if (candidate.checked_in_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `${candidate.token_no} is already checked in and can't be rescheduled` });
    }

    const batchRes = await client.query('SELECT * FROM fair_batches WHERE id = $1 FOR UPDATE', [batch_id]);
    if (!batchRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Target batch not found' });
    }
    const batch = batchRes.rows[0];
    if (batch.status === 'closed') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Batch ${batch.batch_number} is closed` });
    }

    if (candidate.batch_id === batch.id) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, candidate_id: candidate.id, token_no: candidate.token_no, batch_id: batch.id });
    }

    const occRes = await client.query(
      'SELECT COUNT(*)::int AS n FROM candidates WHERE batch_id = $1 AND deleted_at IS NULL',
      [batch.id]
    );
    if (occRes.rows[0].n >= batch.capacity) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Batch ${batch.batch_number} is full` });
    }

    await client.query('UPDATE candidates SET batch_id = $1 WHERE id = $2', [batch.id, candidate.id]);
    await client.query('COMMIT');

    res.json({ ok: true, candidate_id: candidate.id, token_no: candidate.token_no, batch_id: batch.id });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Admin / Registration Staff: gate exit-scan — candidate hands back their
// token on the way out (done with all interviews, or leaving early/voluntarily).
// Same QR the schedule page shows for entrance check-in (checkinSig.verifyQr),
// scanned in "Exit" mode on the same GateCheckIn screen. Unlike check-in this
// isn't batch-scoped — it ends the candidate's whole session: soft-deleted
// (same convention as DELETE /candidates/:id, so every deleted_at IS NULL read —
// GET /qr/schedule/:token, check-in, candidate lookup — treats the token as
// dead from this point on) and pulled off any company queues they were still
// waiting in, so a photographed/reused QR can't jump a queue after the
// candidate has physically left.
router.post('/candidates/exit', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (req, res) => {
  const { qr, candidate_token } = req.body;

  let tokenNo;
  if (qr !== undefined) {
    tokenNo = verifyQr(qr);
    if (!tokenNo) return res.status(400).json({ error: 'Invalid or forged check-in QR' });
  } else if (candidate_token) {
    tokenNo = candidate_token;
  } else {
    return res.status(400).json({ error: 'qr or candidate_token is required' });
  }

  const client = await pool.connect();
  let candidate;
  let companyIds;
  try {
    await client.query('BEGIN');

    const candRes = await client.query(
      'SELECT id, token_no, name FROM candidates WHERE token_no = $1 AND deleted_at IS NULL FOR UPDATE',
      [tokenNo]
    );
    if (!candRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Candidate not found or already exited' });
    }
    candidate = candRes.rows[0];

    const ccsRes = await client.query(
      'SELECT company_id FROM candidate_company_status WHERE candidate_id = $1 AND deleted_at IS NULL',
      [candidate.id]
    );
    companyIds = ccsRes.rows.map((r) => r.company_id);

    await client.query('UPDATE candidates SET deleted_at = now() WHERE id = $1', [candidate.id]);
    await client.query(
      'UPDATE candidate_company_status SET deleted_at = now() WHERE candidate_id = $1 AND deleted_at IS NULL',
      [candidate.id]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Redis cleanup after commit — same reasoning as registerCandidate.js's
  // post-commit enqueue: a Redis outage must never undo an already-committed
  // exit. Release the desk lock too, in case they're mid-interview and
  // choose to leave early.
  for (const companyId of companyIds) {
    try {
      await queueStore.remove(companyId, candidate.id);
    } catch (err) {
      console.error(`[candidates/exit] queue remove failed for candidate ${candidate.id} company ${companyId}:`, err.message);
    }
  }
  try {
    await queueStore.releaseLock(candidate.id);
  } catch (err) {
    console.error(`[candidates/exit] lock release failed for candidate ${candidate.id}:`, err.message);
  }

  emit('candidate_exited', { token: candidate.token_no, name: candidate.name, statsDelta: { exited: 1 } });

  res.json({ ok: true, token: candidate.token_no, name: candidate.name });
}));

// Admin / Reg Staff: delete a candidate — integrity fix #10: while a fair is
// live (fair_settings.is_active) only soft-delete; hard delete is post-fair cleanup.
router.delete('/candidates/:id', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (req, res) => {
  const fairActive = await pool.query('SELECT 1 FROM fair_settings WHERE is_active = true LIMIT 1');

  if (fairActive.rows.length) {
    const result = await pool.query(
      'UPDATE candidates SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Candidate not found' });
    await pool.query(
      'UPDATE candidate_company_status SET deleted_at = now() WHERE candidate_id = $1 AND deleted_at IS NULL',
      [req.params.id]
    );
    return res.json({ deleted: 'soft', id: result.rows[0].id });
  }

  // No live fair — hard delete permitted (FKs are RESTRICT, so clear ccs rows first)
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM candidate_company_status WHERE candidate_id = $1', [req.params.id]);
    const result = await client.query('DELETE FROM candidates WHERE id = $1 RETURNING id', [req.params.id]);
    await client.query('COMMIT');
    if (!result.rows.length) return res.status(404).json({ error: 'Candidate not found' });
    res.json({ deleted: 'hard', id: result.rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
