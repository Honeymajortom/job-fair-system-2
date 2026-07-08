const express = require('express');
const pool = require('../db');
const asyncHandler = require('../asyncHandler');
const { authenticateJWT } = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');

const router = express.Router();

// Staff (any role): list companies with open-slot counts, for tiles and admin
// list. The public tile view arrives in stage 4 as GET /qr/companies.
router.get('/companies', authenticateJWT, asyncHandler(async (_req, res) => {
  const result = await pool.query(`
    SELECT
      c.id, c.company_name, c.description, c.location, c.field, c.job_type,
      c.min_qualification, c.max_qualification, c.max_queue_limit,
      COUNT(s.id) FILTER (WHERE s.id IS NOT NULL) AS total_slots,
      COUNT(s.id) FILTER (
        WHERE s.id IS NOT NULL
          AND (SELECT COUNT(*) FROM candidate_company_status ccs
               WHERE ccs.slot_id = s.id AND ccs.deleted_at IS NULL) < s.capacity
      ) AS open_slots
    FROM companies c
    LEFT JOIN interview_slots s ON s.company_id = c.id
    GROUP BY c.id
    ORDER BY c.company_name
  `);
  res.json(result.rows);
}));

router.get('/companies/:id', authenticateJWT, asyncHandler(async (req, res) => {
  const companyRes = await pool.query('SELECT * FROM companies WHERE id = $1', [req.params.id]);
  if (!companyRes.rows.length) return res.status(404).json({ error: 'Company not found' });

  const paramsRes = await pool.query(
    'SELECT id, parameter_name, display_order FROM rating_parameters WHERE company_id = $1 ORDER BY display_order',
    [req.params.id]
  );
  const slotsRes = await pool.query(
    `SELECT s.id, s.slot_start, s.duration_minutes, s.capacity,
            (SELECT COUNT(*) FROM candidate_company_status ccs
             WHERE ccs.slot_id = s.id AND ccs.deleted_at IS NULL)::int AS taken
     FROM interview_slots s WHERE s.company_id = $1 ORDER BY s.slot_start`,
    [req.params.id]
  );

  res.json({ ...companyRes.rows[0], rating_parameters: paramsRes.rows, slots: slotsRes.rows });
}));

// Admin: create a company
router.post('/companies', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { company_name, description, location, field, job_type, min_qualification, max_qualification, max_queue_limit } = req.body;
  if (!company_name) return res.status(400).json({ error: 'company_name is required' });

  try {
    const result = await pool.query(
      `INSERT INTO companies (company_name, description, location, field, job_type, min_qualification, max_qualification, max_queue_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, 7)) RETURNING *`,
      [company_name, description || null, location || null, field || null, job_type || null, min_qualification || null, max_qualification || null, max_queue_limit || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A company with that name already exists' });
    throw err;
  }
}));

// Admin: add a rating parameter
router.post('/companies/:id/rating-parameters', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { parameter_name, display_order } = req.body;
  if (!parameter_name) return res.status(400).json({ error: 'parameter_name is required' });

  const result = await pool.query(
    `INSERT INTO rating_parameters (company_id, parameter_name, display_order) VALUES ($1,$2,$3) RETURNING *`,
    [req.params.id, parameter_name, display_order || 0]
  );
  res.status(201).json(result.rows[0]);
}));

// Admin: add a slot
router.post('/companies/:id/slots', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { slot_start, duration_minutes, capacity } = req.body;
  if (!slot_start) return res.status(400).json({ error: 'slot_start is required' });

  const result = await pool.query(
    `INSERT INTO interview_slots (company_id, slot_start, duration_minutes, capacity) VALUES ($1,$2, COALESCE($3,15), COALESCE($4,1)) RETURNING *`,
    [req.params.id, slot_start, duration_minutes || null, capacity || null]
  );
  res.status(201).json(result.rows[0]);
}));

module.exports = router;
