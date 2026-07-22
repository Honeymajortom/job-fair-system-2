const express = require('express');
const pool = require('../db');
const asyncHandler = require('../asyncHandler');
const { authenticateJWT } = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');

const router = express.Router();

// Standard Company HR evaluation rubric — seeded onto every new company at
// creation time so HR always has a rating form to score against instead of
// an empty one; admin can still add/remove parameters afterward via the
// rating-parameters endpoints below.
const DEFAULT_RATING_PARAMETERS = [
  'Communication',
  'Technical Skills',
  'Adaptability',
  'Confidence Level',
  'Behavior & Personality',
];

// Staff (any role): list companies with open-slot counts, for tiles and admin
// list. The public tile view arrives in stage 4 as GET /qr/companies.
router.get('/companies', authenticateJWT, asyncHandler(async (_req, res) => {
  const result = await pool.query(`
    SELECT
      c.id, c.company_name, c.description, c.location, c.floor_number, c.field, c.job_type,
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
  const postsRes = await pool.query(
    'SELECT * FROM company_posts WHERE company_id = $1 ORDER BY id',
    [req.params.id]
  );

  res.json({ ...companyRes.rows[0], rating_parameters: paramsRes.rows, slots: slotsRes.rows, posts: postsRes.rows });
}));

// Admin: create a company. seats/interview_minutes feed the queue-system
// booking-cap gate (new_architecture.md §4: capacity_j = seats *
// (60/interview_minutes) * fair_hours) — default to 1 seat / 6-min
// interviews (sim's baseline) so an unconfigured company still gets a
// sane, non-zero cap instead of silently waitlisting everyone.
router.post('/companies', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { company_name, description, location, floor_number, field, job_type, min_qualification, max_qualification, max_queue_limit, seats, interview_minutes } = req.body;
  if (!company_name) return res.status(400).json({ error: 'company_name is required' });
  // Red-team L3: interview_minutes feeds `60 / interview_minutes` in the
  // booking-cap math (registerCandidate.js) — 0 or negative breaks that
  // divisor (Infinity/NaN, or a negative cap that silently waitlists
  // everyone). The DB CHECK constraint is the hard backstop; this just gives
  // a clean 400 instead of a raw constraint-violation error.
  if (interview_minutes != null && !(Number.isInteger(interview_minutes) && interview_minutes > 0)) {
    return res.status(400).json({ error: 'interview_minutes must be a positive integer' });
  }
  // Ground floor is 0, not 1 — reject negatives before they hit the DB
  // CHECK constraint. `floor_number || null` below would silently turn a
  // valid 0 into null (0 is falsy), so this uses an explicit null check.
  if (floor_number != null && !(Number.isInteger(floor_number) && floor_number >= 0)) {
    return res.status(400).json({ error: 'floor_number must be a non-negative integer' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO companies (company_name, description, location, floor_number, field, job_type, min_qualification, max_qualification, max_queue_limit, seats, interview_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9, 7), COALESCE($10, 1), COALESCE($11, 6)) RETURNING *`,
      [company_name, description || null, location || null, floor_number != null ? floor_number : null, field || null, job_type || null, min_qualification || null, max_qualification || null, max_queue_limit || null, seats || null, interview_minutes || null]
    );
    const company = result.rows[0];

    for (let i = 0; i < DEFAULT_RATING_PARAMETERS.length; i++) {
      await pool.query(
        'INSERT INTO rating_parameters (company_id, parameter_name, display_order) VALUES ($1,$2,$3)',
        [company.id, DEFAULT_RATING_PARAMETERS[i], i]
      );
    }

    res.status(201).json(company);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A company with that name already exists' });
    if (err.code === '23514' && err.constraint === 'companies_floor_number_nonnegative') {
      return res.status(400).json({ error: 'floor_number must be a non-negative integer' });
    }
    if (err.code === '23514') return res.status(400).json({ error: 'interview_minutes must be a positive integer' });
    throw err;
  }
}));

// Admin: delete a company — hard delete (companies aren't fair-scoped or
// soft-deleted like candidates are). FK RESTRICT on interview_slots,
// candidate_company_status, and users.company_id is the real guard here: a
// company with any booked candidates, slots, or an assigned company_hr
// account can't be deleted out from under live data — this just turns that
// constraint violation into a clean 409 instead of a raw DB error. rating_
// parameters/company_posts are ON DELETE CASCADE, so those go with it.
router.delete('/companies/:id', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM companies WHERE id = $1 RETURNING id, company_name', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Company not found' });
    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ error: 'Cannot delete a company with existing candidates, interview slots, or assigned staff — remove those first' });
    }
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

// Admin: remove a rating parameter
router.delete('/companies/:id/rating-parameters/:paramId', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await pool.query(
    'DELETE FROM rating_parameters WHERE id = $1 AND company_id = $2 RETURNING id',
    [req.params.paramId, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Rating parameter not found' });
  res.json({ ok: true, id: result.rows[0].id });
}));

// Admin: add a posting (vacancy tracking — v2.5's company_posts, see schema.sql)
router.post('/companies/:id/posts', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { post_title, vacancies, qualification, gender, age_min, age_max } = req.body;
  if (!post_title) return res.status(400).json({ error: 'post_title is required' });

  const result = await pool.query(
    `INSERT INTO company_posts (company_id, post_title, vacancies, qualification, gender, age_min, age_max)
     VALUES ($1,$2, COALESCE($3,1), $4,$5,$6,$7) RETURNING *`,
    [req.params.id, post_title, vacancies || null, qualification || null, gender || null, age_min || null, age_max || null]
  );
  res.status(201).json(result.rows[0]);
}));

// Admin: edit a posting
router.put('/companies/:id/posts/:postId', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { post_title, vacancies, qualification, gender, age_min, age_max } = req.body;

  const result = await pool.query(
    `UPDATE company_posts
     SET post_title = COALESCE($1, post_title),
         vacancies = COALESCE($2, vacancies),
         qualification = COALESCE($3, qualification),
         gender = COALESCE($4, gender),
         age_min = COALESCE($5, age_min),
         age_max = COALESCE($6, age_max)
     WHERE id = $7 AND company_id = $8
     RETURNING *`,
    [post_title || null, vacancies || null, qualification || null, gender || null, age_min || null, age_max || null, req.params.postId, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Posting not found' });
  res.json(result.rows[0]);
}));

// Admin: remove a posting
router.delete('/companies/:id/posts/:postId', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await pool.query(
    'DELETE FROM company_posts WHERE id = $1 AND company_id = $2 RETURNING id',
    [req.params.postId, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Posting not found' });
  res.json({ ok: true, id: result.rows[0].id });
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
