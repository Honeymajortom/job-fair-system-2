const express = require('express');
const pool = require('../db');
const asyncHandler = require('../asyncHandler');
const { authenticateJWT } = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const registerCandidate = require('../lib/registerCandidate');
const { enqueueDispatch } = require('../lib/dispatchQueue');

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

// Admin / Floor Manager: emergency batch reschedule (Waiting Room drag-and-drop).
// Re-runs the same per-company slot pick as registerCandidate.js (earliest slot
// at/after the new batch's arrival time) — nobody already booked gets bumped,
// the moved candidate just lands on whatever's next open. A checked-in
// candidate can't move (would desync fair_batches.checked_in from the
// dispatcher's checked-in guard). Finished results (Selected/Rejected/
// Shortlisted/Hold) are left alone, same exclusion PUT /slots/:id/reassign uses.
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
      return res.json({ ok: true, candidate_id: candidate.id, token_no: candidate.token_no, batch_id: batch.id, moved: [], unassigned: [] });
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

    const ccsRes = await client.query(
      `SELECT ccs.id, ccs.company_id, c.company_name
       FROM candidate_company_status ccs
       JOIN companies c ON c.id = ccs.company_id
       WHERE ccs.candidate_id = $1 AND ccs.deleted_at IS NULL
         AND ccs.status IN ('Pending', 'Dispatched', 'No_Show')`,
      [candidate.id]
    );

    const moved = [];
    const unassigned = [];
    for (const row of ccsRes.rows) {
      const slotsRes = await client.query(
        `SELECT id, slot_start, capacity FROM interview_slots
         WHERE company_id = $1 AND slot_start >= $2
         ORDER BY slot_start ASC FOR UPDATE`,
        [row.company_id, batch.arrival_time]
      );

      let chosenSlot = null;
      for (const slot of slotsRes.rows) {
        const takenRes = await client.query(
          'SELECT COUNT(*)::int AS taken FROM candidate_company_status WHERE slot_id = $1 AND deleted_at IS NULL',
          [slot.id]
        );
        if (takenRes.rows[0].taken < slot.capacity) {
          chosenSlot = slot;
          break;
        }
      }

      if (chosenSlot) {
        await client.query(
          `UPDATE candidate_company_status SET slot_id = $1, status = 'Pending', processed_at = NULL WHERE id = $2`,
          [chosenSlot.id, row.id]
        );
        moved.push({ ccs_id: row.id, company_id: row.company_id, company_name: row.company_name, slot_id: chosenSlot.id, slot_start: chosenSlot.slot_start });
      } else {
        await client.query(
          `UPDATE candidate_company_status SET slot_id = NULL, status = 'Pending', processed_at = NULL WHERE id = $1`,
          [row.id]
        );
        unassigned.push({ company_id: row.company_id, company_name: row.company_name });
      }
    }

    await client.query('COMMIT');

    for (const m of moved) {
      await enqueueDispatch({ ccsId: m.ccs_id, candidateId: candidate.id, companyId: m.company_id, slotId: m.slot_id, slotStart: m.slot_start });
    }

    res.json({
      ok: true,
      candidate_id: candidate.id,
      token_no: candidate.token_no,
      batch_id: batch.id,
      moved: moved.map(({ ccs_id, ...rest }) => rest),
      unassigned,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
