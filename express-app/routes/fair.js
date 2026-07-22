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

// Partial update — also how the is_active soft-delete guard is toggled, and
// (per new_architecture.md) the one place the fair-wide waiting room's
// physical location/floor gets set — Gate tab, admin only.
router.put('/fair-settings/:id', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { fair_name, max_companies_per_candidate, slot_duration_minutes, batch_size, batch_interval_minutes, is_active, waiting_room_location, waiting_room_floor_number } = req.body;

  if (waiting_room_floor_number != null && !(Number.isInteger(waiting_room_floor_number) && waiting_room_floor_number >= 0)) {
    return res.status(400).json({ error: 'waiting_room_floor_number must be a non-negative integer' });
  }

  try {
    const result = await pool.query(
      `UPDATE fair_settings SET
         fair_name = COALESCE($1, fair_name),
         max_companies_per_candidate = COALESCE($2, max_companies_per_candidate),
         slot_duration_minutes = COALESCE($3, slot_duration_minutes),
         batch_size = COALESCE($4, batch_size),
         batch_interval_minutes = COALESCE($5, batch_interval_minutes),
         is_active = COALESCE($6, is_active),
         waiting_room_location = COALESCE($7, waiting_room_location),
         waiting_room_floor_number = COALESCE($8, waiting_room_floor_number)
       WHERE id = $9
       RETURNING *`,
      [fair_name || null, max_companies_per_candidate || null, slot_duration_minutes || null, batch_size || null, batch_interval_minutes || null, is_active === undefined ? null : is_active, waiting_room_location || null, waiting_room_floor_number != null ? waiting_room_floor_number : null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Fair settings not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23514' && err.constraint === 'fair_settings_waiting_room_floor_nonnegative') {
      return res.status(400).json({ error: 'waiting_room_floor_number must be a non-negative integer' });
    }
    throw err;
  }
}));

// Admin / Registration Staff: auto-generate arrival waves from fair_settings (batch_size × batch_interval_minutes)
router.post('/batches/generate', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (req, res) => {
  const { fair_date, first_arrival, batch_count } = req.body;
  if (!fair_date) return res.status(400).json({ error: 'fair_date is required' });
  if (!Number.isInteger(batch_count) || batch_count < 1 || batch_count > 100) {
    return res.status(400).json({ error: 'batch_count must be an integer between 1 and 100' });
  }

  const settingsRes = await pool.query('SELECT * FROM fair_settings WHERE fair_date = $1', [fair_date]);
  if (!settingsRes.rows.length) return res.status(404).json({ error: 'No fair configured for that date' });
  const settings = settingsRes.rows[0];

  const existing = await pool.query('SELECT 1 FROM fair_batches WHERE fair_date = $1 LIMIT 1', [fair_date]);
  if (existing.rows.length) return res.status(409).json({ error: 'Batches already generated for that date' });

  const firstArrival = first_arrival || `${fair_date} 09:00`;
  const result = await pool.query(
    `INSERT INTO fair_batches (fair_date, batch_number, arrival_time, capacity)
     SELECT $1, gs.n, $2::timestamptz + (gs.n - 1) * ($3 * interval '1 minute'), $4
     FROM generate_series(1, $5) AS gs(n)
     RETURNING *`,
    [fair_date, firstArrival, settings.batch_interval_minutes, settings.batch_size, batch_count]
  );
  res.status(201).json(result.rows);
}));

// All staff roles: batch list with live check-in counts
router.get('/batches', authenticateJWT, asyncHandler(async (_req, res) => {
  const result = await pool.query('SELECT * FROM fair_batches ORDER BY fair_date, batch_number');
  res.json(result.rows);
}));

module.exports = router;
