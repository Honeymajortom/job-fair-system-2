const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const asyncHandler = require('../asyncHandler');
const { authenticateJWT } = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');

const router = express.Router();

const ROLES = ['admin', 'registration_staff', 'floor_manager', 'company_hr', 'volunteer'];

// User management is Admin-only across the board (permission matrix).
router.use('/users', authenticateJWT, requireRole('admin'));

router.get('/users', asyncHandler(async (_req, res) => {
  const result = await pool.query('SELECT id, username, role, company_id, created_at FROM users ORDER BY id');
  res.json(result.rows);
}));

router.post('/users', asyncHandler(async (req, res) => {
  const { username, password, role, company_id } = req.body;
  if (!username || !username.trim()) return res.status(400).json({ error: 'username is required' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });
  // Red-team H3: a company_hr account is scoped to exactly one company —
  // without this it could act on every company's queue.
  if (role === 'company_hr' && !company_id) {
    return res.status(400).json({ error: 'company_id is required for the company_hr role' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, role, company_id)
       VALUES ($1,$2,$3,$4) RETURNING id, username, role, company_id, created_at`,
      [username.trim(), bcrypt.hashSync(password, 10), role, role === 'company_hr' ? company_id : null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A user with that username already exists' });
    if (err.code === '23503') return res.status(400).json({ error: 'No such company' });
    throw err;
  }
}));

// Update role, company_id and/or reset password
router.put('/users/:id', asyncHandler(async (req, res) => {
  const { password, role, company_id } = req.body;
  if (role !== undefined && !ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });
  }
  if (password !== undefined && password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }
  // Red-team H3: creating/re-rolling into company_hr must always come with a
  // company — this request can't tell whether a company_id already on file
  // from before is still meant to apply, so require it explicitly here too.
  if (role === 'company_hr' && !company_id) {
    return res.status(400).json({ error: 'company_id is required when setting role to company_hr' });
  }
  if (role === undefined && password === undefined && company_id === undefined) {
    return res.status(400).json({ error: 'Nothing to update — provide role, company_id and/or password' });
  }

  try {
    // Red-team H2: bumping token_version on a password reset kills that user's
    // existing session(s) immediately instead of leaving a possibly-compromised
    // JWT valid for the rest of its 8h life. A role change to/from company_hr
    // clears/sets company_id in the same statement so the two can't drift.
    const result = await pool.query(
      `UPDATE users
       SET role = COALESCE($1, role),
           password_hash = COALESCE($2, password_hash),
           token_version = token_version + $3,
           company_id = CASE
             WHEN $1::varchar = 'company_hr' THEN $4::int
             WHEN $1::varchar IS NOT NULL THEN NULL
             ELSE COALESCE($4::int, company_id)
           END
       WHERE id = $5
       RETURNING id, username, role, company_id, created_at`,
      [role || null, password ? bcrypt.hashSync(password, 10) : null, password ? 1 : 0, company_id || null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: 'No such company' });
    throw err;
  }
}));

router.delete('/users/:id', asyncHandler(async (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }
  const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true, id: result.rows[0].id });
}));

module.exports = router;
