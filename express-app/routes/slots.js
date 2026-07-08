const express = require('express');
const pool = require('../db');
const asyncHandler = require('../asyncHandler');
const { authenticateJWT } = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const { enqueueDispatch } = require('../lib/dispatchQueue');

const router = express.Router();

// Any staff: slot grid for a company with live occupancy (floor board data).
// Single-slot creation stays in companies.js (POST /companies/:id/slots).
router.get('/slots', authenticateJWT, asyncHandler(async (req, res) => {
  const { company_id } = req.query;
  if (!company_id) return res.status(400).json({ error: 'company_id query param is required' });

  const result = await pool.query(
    `SELECT s.id, s.company_id, s.slot_start, s.duration_minutes, s.capacity,
            COUNT(ccs.id) FILTER (WHERE ccs.deleted_at IS NULL)::int AS taken
     FROM interview_slots s
     LEFT JOIN candidate_company_status ccs ON ccs.slot_id = s.id
     WHERE s.company_id = $1
     GROUP BY s.id
     ORDER BY s.slot_start ASC`,
    [company_id]
  );
  res.json(result.rows);
}));

// Any staff: only the slots with seats left — the "[+ assign]" picker.
router.get('/slots/available', authenticateJWT, asyncHandler(async (req, res) => {
  const { company_id } = req.query;
  if (!company_id) return res.status(400).json({ error: 'company_id query param is required' });

  const result = await pool.query(
    `SELECT s.id, s.company_id, s.slot_start, s.duration_minutes, s.capacity,
            COUNT(ccs.id) FILTER (WHERE ccs.deleted_at IS NULL)::int AS taken
     FROM interview_slots s
     LEFT JOIN candidate_company_status ccs ON ccs.slot_id = s.id
     WHERE s.company_id = $1
     GROUP BY s.id
     HAVING COUNT(ccs.id) FILTER (WHERE ccs.deleted_at IS NULL) < s.capacity
     ORDER BY s.slot_start ASC`,
    [company_id]
  );
  res.json(result.rows);
}));

// Admin: generate a slot grid for a company — slot_count slots from first_start,
// spaced by the active fair's slot_duration_minutes (Phase 1 setup).
router.post('/slots/generate', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { company_id, first_start, slot_count, capacity } = req.body;
  if (!company_id || !first_start) {
    return res.status(400).json({ error: 'company_id and first_start are required' });
  }
  if (!Number.isInteger(slot_count) || slot_count < 1 || slot_count > 200) {
    return res.status(400).json({ error: 'slot_count must be an integer between 1 and 200' });
  }

  const companyRes = await pool.query('SELECT id FROM companies WHERE id = $1', [company_id]);
  if (!companyRes.rows.length) return res.status(404).json({ error: 'Company not found' });

  const settingsRes = await pool.query(
    'SELECT slot_duration_minutes FROM fair_settings WHERE is_active = true ORDER BY fair_date DESC LIMIT 1'
  );
  const duration = settingsRes.rows.length ? settingsRes.rows[0].slot_duration_minutes : 15;

  const result = await pool.query(
    `INSERT INTO interview_slots (company_id, slot_start, duration_minutes, capacity)
     SELECT $1, $2::timestamptz + (gs.n - 1) * ($3 * interval '1 minute'), $3, COALESCE($4, 1)
     FROM generate_series(1, $5) AS gs(n)
     RETURNING *`,
    [company_id, first_start, duration, capacity || null, slot_count]
  );
  res.status(201).json(result.rows);
}));

// Admin / Floor Manager: emergency reassignment (flow D, integrity fix #9).
// Moves the candidate's assignment for this slot's company onto slot :id,
// occupancy-checked under FOR UPDATE. Per v3.0, reassign also enqueues a fresh
// delayed job — the stale job no-ops because its slot_id no longer matches.
router.put('/slots/:id/reassign', authenticateJWT, requireRole('admin', 'floor_manager'), asyncHandler(async (req, res) => {
  const { candidate_id } = req.body;
  if (!candidate_id) return res.status(400).json({ error: 'candidate_id is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const slotRes = await client.query(
      'SELECT id, company_id, slot_start, capacity FROM interview_slots WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!slotRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Slot not found' });
    }
    const slot = slotRes.rows[0];

    const takenRes = await client.query(
      'SELECT COUNT(*)::int AS taken FROM candidate_company_status WHERE slot_id = $1 AND deleted_at IS NULL',
      [slot.id]
    );
    if (takenRes.rows[0].taken >= slot.capacity) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Slot is already full' });
    }

    // Only unfinished assignments can move; a recorded result stays put.
    const ccsRes = await client.query(
      `UPDATE candidate_company_status
       SET slot_id = $1, status = 'Pending', processed_at = NULL
       WHERE candidate_id = $2 AND company_id = $3 AND deleted_at IS NULL
         AND status IN ('Pending', 'Dispatched', 'No_Show')
       RETURNING id`,
      [slot.id, candidate_id, slot.company_id]
    );
    if (!ccsRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No reassignable assignment for this candidate at this company' });
    }

    await client.query('COMMIT');

    await enqueueDispatch({
      ccsId: ccsRes.rows[0].id,
      candidateId: candidate_id,
      companyId: slot.company_id,
      slotId: slot.id,
      slotStart: slot.slot_start,
    });
    // candidate_dispatched re-fires from the worker when the fresh job lands —
    // no emit here (the row is back to Pending until then).
    res.json({ ok: true, ccs_id: ccsRes.rows[0].id, slot_id: slot.id, slot_start: slot.slot_start });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
