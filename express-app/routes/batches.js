const express = require('express');
const pool = require('../db');
const asyncHandler = require('../asyncHandler');
const { authenticateJWT } = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const { verifyQr } = require('../lib/checkinSig');
const { emit } = require('../lib/events');
const { getOrCreateAvailableBatch } = require('../lib/batchAssignment');

const router = express.Router();

const BATCH_STATUSES = ['upcoming', 'active', 'closed'];

// Admin / Registration Staff: batch lifecycle — upcoming → active → closed.
// 'active'/'upcoming' no longer gate check-in (see /batch/check-in below) —
// 'closed' is the one that still does real work: it tells
// getOrCreateAvailableBatch to stop assigning new arrivals to that wave.
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

// Registration Staff (+ Admin): gate check-in.
// Primary path: { qr: "A-42.f3ab91…" } from the schedule-card scan, HMAC
// verified server-side. Fallback: { candidate_token: "A-42" } for dead
// batteries — same endpoint, no signature (staff already authenticated).
//
// No batch_id in the request and no "pick a batch first" step — the batch is
// whichever one the candidate was already auto-assigned to at registration
// (lib/batchAssignment.js). A NULL batch_id only happens for a candidate who
// registered before this existed; those get assigned here the same way,
// rather than being dumped uncapped into whatever batch staff had selected
// (the old dropdown-driven design's actual bug — see handoff.md).
router.post('/batch/check-in', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (req, res) => {
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

    const candRes = await client.query(
      'SELECT id, token_no, name, batch_id, checked_in_at FROM candidates WHERE token_no = $1 AND deleted_at IS NULL FOR UPDATE',
      [tokenNo]
    );
    if (!candRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Candidate not found' });
    }
    const candidate = candRes.rows[0];
    if (candidate.checked_in_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Candidate ${candidate.token_no} is already checked in` });
    }

    let batchId = candidate.batch_id;
    if (!batchId) {
      // STAFF_INCONSISTENCY_REPORT.md S6: this used to grab "whichever active
      // fair sorts first by fair_date" with no Center filter at all — in a
      // multi-Center install with two concurrent active fairs, a legacy
      // (pre-2026-07-24) candidate could get silently assigned into another
      // Center's batch. registration_staff is always pinned to one Center
      // (req.user.center_id), so scope by that directly; admin has no fixed
      // center, so only guess when there's nothing to disambiguate —
      // otherwise fail clearly instead of picking one arbitrarily, same
      // pattern POST /register already uses for the identical ambiguity.
      const centerId = req.user.role === 'admin' ? null : req.user.center_id;
      let fairQuery = `SELECT id, to_char(fair_date, 'YYYY-MM-DD') AS fair_date, batch_size, batch_interval_minutes
         FROM fair_settings WHERE is_active = true`;
      const fairParams = [];
      if (centerId != null) {
        fairQuery += ' AND center_id = $1';
        fairParams.push(centerId);
      } else {
        const activeCount = await client.query('SELECT COUNT(*)::int AS n FROM fair_settings WHERE is_active = true');
        if (activeCount.rows[0].n > 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Multiple centers have an active fair — this legacy candidate has no batch_id and no Center on file. Check in via a registration_staff account pinned to the right Center.' });
        }
      }
      fairQuery += ' ORDER BY fair_date DESC LIMIT 1';
      const fairRes = await client.query(fairQuery, fairParams);
      if (fairRes.rows.length) {
        const batch = await getOrCreateAvailableBatch(client, fairRes.rows[0]);
        batchId = batch.id;
      }
    }

    await client.query('UPDATE candidates SET checked_in_at = now(), batch_id = $2 WHERE id = $1', [candidate.id, batchId]);
    let checkedIn = null;
    let capacity = null;
    let batchNumber = null;
    if (batchId) {
      const updated = await client.query(
        'UPDATE fair_batches SET checked_in = checked_in + 1 WHERE id = $1 RETURNING checked_in, capacity, batch_number',
        [batchId]
      );
      ({ checked_in: checkedIn, capacity, batch_number: batchNumber } = updated.rows[0]);
    }

    await client.query('COMMIT');
    emit('batch_checked_in', { batch_id: batchId, checked_in: checkedIn, capacity });
    res.json({
      ok: true,
      token: candidate.token_no,
      name: candidate.name,
      batch_id: batchId,
      batch_number: batchNumber,
      checked_in: checkedIn,
      capacity,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
