const express = require('express');
const pool = require('../db');
const asyncHandler = require('../asyncHandler');
const { authenticateJWT } = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');

const router = express.Router();

// Fair configuration + arrival-wave generation (Admin setup, Phase 1).
// Batch check-in and status transitions belong to stage 3's batches.js.

// Read-only: also needed by Registration Staff's "Generate batch" control on
// the Gate tab (reads the active fair's date/interval) — write endpoints
// below stay admin-only.
router.get('/fair-settings', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (_req, res) => {
  const result = await pool.query('SELECT * FROM fair_settings ORDER BY fair_date DESC');
  res.json(result.rows);
}));

router.post('/fair-settings', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { fair_name, fair_date, max_companies_per_candidate, slot_duration_minutes, batch_size, batch_interval_minutes, is_active } = req.body;
  if (!fair_name || !fair_date) return res.status(400).json({ error: 'fair_name and fair_date are required' });

  try {
    const result = await pool.query(
      `INSERT INTO fair_settings (fair_name, fair_date, max_companies_per_candidate, slot_duration_minutes, batch_size, batch_interval_minutes, is_active)
       VALUES ($1,$2, COALESCE($3,3), COALESCE($4,15), COALESCE($5,25), COALESCE($6,15), COALESCE($7,false)) RETURNING *`,
      [fair_name, fair_date, max_companies_per_candidate || null, slot_duration_minutes || null, batch_size || null, batch_interval_minutes || null, is_active === undefined ? null : is_active]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A fair already exists for that date' });
    throw err;
  }
}));

// Partial update — also how the is_active soft-delete guard is toggled
router.put('/fair-settings/:id', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { fair_name, max_companies_per_candidate, slot_duration_minutes, batch_size, batch_interval_minutes, is_active } = req.body;

  const result = await pool.query(
    `UPDATE fair_settings SET
       fair_name = COALESCE($1, fair_name),
       max_companies_per_candidate = COALESCE($2, max_companies_per_candidate),
       slot_duration_minutes = COALESCE($3, slot_duration_minutes),
       batch_size = COALESCE($4, batch_size),
       batch_interval_minutes = COALESCE($5, batch_interval_minutes),
       is_active = COALESCE($6, is_active)
     WHERE id = $7
     RETURNING *`,
    [fair_name || null, max_companies_per_candidate || null, slot_duration_minutes || null, batch_size || null, batch_interval_minutes || null, is_active === undefined ? null : is_active, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Fair settings not found' });
  res.json(result.rows[0]);
}));

// Waiting rooms, one per floor — matched against companies.floor_number so a
// candidate waiting for a Floor 2 company is told to sit in the Floor 2
// waiting room, not a fair-wide generic one (superseded fair_settings.
// waiting_room_location/floor_number the same day it shipped, see schema.sql).
// Read is public (GateBoard.jsx + every candidate's LivePosition.jsx need the
// full list to pick the right one); writes are admin-only, from the Gate tab.
router.get('/waiting-rooms', asyncHandler(async (_req, res) => {
  const result = await pool.query('SELECT floor_number, location FROM waiting_rooms ORDER BY floor_number');
  res.json(result.rows);
}));

// Upsert — floor_number is the natural key, so "set the Floor 2 waiting room
// to X" is always one call whether Floor 2 already had one or not.
router.post('/waiting-rooms', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { floor_number, location } = req.body;
  if (!(Number.isInteger(floor_number) && floor_number >= 0)) {
    return res.status(400).json({ error: 'floor_number must be a non-negative integer' });
  }
  if (!location || !location.trim()) return res.status(400).json({ error: 'location is required' });

  const result = await pool.query(
    `INSERT INTO waiting_rooms (floor_number, location) VALUES ($1, $2)
     ON CONFLICT (floor_number) DO UPDATE SET location = EXCLUDED.location
     RETURNING floor_number, location`,
    [floor_number, location.trim()]
  );
  res.status(201).json(result.rows[0]);
}));

router.delete('/waiting-rooms/:floorNumber', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await pool.query('DELETE FROM waiting_rooms WHERE floor_number = $1 RETURNING floor_number', [req.params.floorNumber]);
  if (!result.rows.length) return res.status(404).json({ error: 'No waiting room configured for that floor' });
  res.json({ ok: true, floor_number: result.rows[0].floor_number });
}));

// Admin / Registration Staff: auto-generate arrival waves from fair_settings
// (batch_size × batch_interval_minutes). Appends rather than rejecting when a
// date already has batches — batch_number picks up after the highest
// existing one, on the same evenly-spaced grid the original batches used
// (anchored on batch #1's arrival_time), so "Generate batch" can be used more
// than once per fair day as more arrival waves turn out to be needed.
router.post('/batches/generate', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (req, res) => {
  const { fair_date, first_arrival, batch_count } = req.body;
  if (!fair_date) return res.status(400).json({ error: 'fair_date is required' });
  if (!Number.isInteger(batch_count) || batch_count < 1 || batch_count > 100) {
    return res.status(400).json({ error: 'batch_count must be an integer between 1 and 100' });
  }

  const settingsRes = await pool.query('SELECT * FROM fair_settings WHERE fair_date = $1', [fair_date]);
  if (!settingsRes.rows.length) return res.status(404).json({ error: 'No fair configured for that date' });
  const settings = settingsRes.rows[0];

  const lastRes = await pool.query(
    'SELECT batch_number FROM fair_batches WHERE fair_date = $1 ORDER BY batch_number DESC LIMIT 1',
    [fair_date]
  );
  const startNumber = lastRes.rows.length ? lastRes.rows[0].batch_number + 1 : 1;

  // Re-derive the original firstArrival from batch #1 (rather than re-
  // anchoring at "now" or trusting a caller-supplied first_arrival) so
  // appended batches land on the exact same grid as the existing ones —
  // batch_number n's arrival_time is always firstArrival + (n-1)*interval,
  // whether n was inserted today or in an earlier call.
  let firstArrival = first_arrival || `${fair_date} 09:00`;
  if (lastRes.rows.length) {
    const anchorRes = await pool.query(
      'SELECT arrival_time FROM fair_batches WHERE fair_date = $1 AND batch_number = 1',
      [fair_date]
    );
    firstArrival = anchorRes.rows[0].arrival_time;
  }

  const result = await pool.query(
    `INSERT INTO fair_batches (fair_date, batch_number, arrival_time, capacity)
     SELECT $1, gs.n, $2::timestamptz + (gs.n - 1) * ($3 * interval '1 minute'), $4
     FROM generate_series($5::int, $5::int + $6::int - 1) AS gs(n)
     RETURNING *`,
    [fair_date, firstArrival, settings.batch_interval_minutes, settings.batch_size, startNumber, batch_count]
  );
  res.status(201).json(result.rows);
}));

// All staff roles: batch list with live check-in counts
router.get('/batches', authenticateJWT, asyncHandler(async (_req, res) => {
  const result = await pool.query('SELECT * FROM fair_batches ORDER BY fair_date, batch_number');
  res.json(result.rows);
}));

module.exports = router;
