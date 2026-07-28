const express = require('express');
const pool = require('../db');
const asyncHandler = require('../asyncHandler');
const { authenticateJWT } = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');

const router = express.Router();

// fair_cycle_isolation_plan.md Phase 4 — the first real place Centers become
// visible to staff. Read is any authenticated role (same "harmless directory
// read" convention as GET /companies/GET /candidates): admin's switcher needs
// the full list, and every non-admin role needs it too, just to resolve their
// own pinned center_id into a display name.
router.get('/centers', authenticateJWT, asyncHandler(async (_req, res) => {
  const result = await pool.query('SELECT id, name, location, created_at FROM centers ORDER BY id');
  res.json(result.rows);
}));

// Admin-only: there's nothing to switch between until a second Center exists
// — this is what the Nav switcher's "+ Add center" inline form calls.
router.post('/centers', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { name, location } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  try {
    const result = await pool.query(
      'INSERT INTO centers (name, location) VALUES ($1,$2) RETURNING id, name, location, created_at',
      [name.trim(), location || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A center with that name already exists' });
    throw err;
  }
}));

module.exports = router;
