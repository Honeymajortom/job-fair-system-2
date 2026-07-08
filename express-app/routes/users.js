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
  const result = await pool.query('SELECT id, username, role, created_at FROM users ORDER BY id');
  res.json(result.rows);
}));

router.post('/users', asyncHandler(async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !username.trim()) return res.status(400).json({ error: 'username is required' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });

  try {
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, role)
       VALUES ($1,$2,$3) RETURNING id, username, role, created_at`,
      [username.trim(), bcrypt.hashSync(password, 10), role]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A user with that username already exists' });
    throw err;
  }
}));

// Update role and/or reset password
router.put('/users/:id', asyncHandler(async (req, res) => {
  const { password, role } = req.body;
  if (role !== undefined && !ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });
  }
  if (password !== undefined && password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }
  if (role === undefined && password === undefined) {
    return res.status(400).json({ error: 'Nothing to update — provide role and/or password' });
  }

  const result = await pool.query(
    `UPDATE users
     SET role = COALESCE($1, role), password_hash = COALESCE($2, password_hash)
     WHERE id = $3
     RETURNING id, username, role, created_at`,
    [role || null, password ? bcrypt.hashSync(password, 10) : null, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
  res.json(result.rows[0]);
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
