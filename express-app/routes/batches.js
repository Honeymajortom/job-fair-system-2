const express = require('express');
const pool = require('../db');
const asyncHandler = require('../asyncHandler');
const { authenticateJWT } = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const { verifyQr } = require('../lib/checkinSig');
const { emit } = require('../lib/events');

const router = express.Router();

const BATCH_STATUSES = ['upcoming', 'active', 'closed'];

// Admin / Registration Staff: batch lifecycle — upcoming → active → closed (flow E).
// Listing lives in fair.js (GET /api/batches); generation in POST /api/batches/generate.
router.put('/batch/:id/status', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!BATCH_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${BATCH_STATUSES.join(', ')}` });
  }
  const result = await pool.query(
    'UPDATE fair_batches SET status = $1 WHERE id = $2 RETURNING *',
    [status, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Batch not found' });
  emit('batch_status_changed', { batch_id: result.rows[0].id, status: result.rows[0].status });
  res.json(result.rows[0]);
}));

// Registration Staff (+ Admin): gate check-in — flow E′.
// Primary path: { qr: "A-42.f3ab91…" } from the schedule-card scan, HMAC
// verified server-side. Fallback: { candidate_token: "A-42" } for dead
// batteries — same endpoint, no signature (staff already authenticated).
router.post('/batch/:id/check-in', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (req, res) => {
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
  try {
    await client.query('BEGIN');

    // Lock the batch row so concurrent scans can't double-count checked_in.
    const batchRes = await client.query('SELECT * FROM fair_batches WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!batchRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Batch not found' });
    }
    const batch = batchRes.rows[0];
    if (batch.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Batch ${batch.batch_number} is ${batch.status}, not active` });
    }

    const candRes = await client.query(
      'SELECT id, token_no, name, batch_id, checked_in_at FROM candidates WHERE token_no = $1 AND deleted_at IS NULL',
      [tokenNo]
    );
    if (!candRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Candidate not found' });
    }
    const candidate = candRes.rows[0];
    // NULL batch_id means they registered before any batch existed yet
    // (e.g. via the gate's own "Generate batch" button, run after
    // registrations were already taken) — assign them into whichever batch
    // they're checked in at, rather than rejecting them as a mismatch.
    if (candidate.batch_id !== null && candidate.batch_id !== batch.id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Candidate ${candidate.token_no} belongs to a different batch` });
    }
    if (candidate.checked_in_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Candidate ${candidate.token_no} is already checked in` });
    }

    await client.query('UPDATE candidates SET checked_in_at = now(), batch_id = $2 WHERE id = $1', [candidate.id, batch.id]);
    const updated = await client.query(
      'UPDATE fair_batches SET checked_in = checked_in + 1 WHERE id = $1 RETURNING checked_in, capacity',
      [batch.id]
    );

    await client.query('COMMIT');
    emit('batch_checked_in', {
      batch_id: batch.id,
      checked_in: updated.rows[0].checked_in,
      capacity: updated.rows[0].capacity,
    });
    res.json({
      ok: true,
      token: candidate.token_no,
      name: candidate.name,
      batch_id: batch.id,
      checked_in: updated.rows[0].checked_in,
      capacity: updated.rows[0].capacity,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
