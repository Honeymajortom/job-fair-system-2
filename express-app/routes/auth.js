const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const asyncHandler = require('../asyncHandler');
const { authenticateJWT, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

const SESSION_HOURS = 8; // v2.5: JWT HttpOnly cookie, 8h

// Staff login — sets the session cookie. The token is also returned in the
// body as a prototype convenience (Bearer fallback for curl); the HttpOnly
// cookie is the canonical mechanism.
router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = result.rows[0];
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: `${SESSION_HOURS}h` }
  );
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
  });
  res.json({ id: user.id, username: user.username, role: user.role, token });
}));

// Session revalidation — re-reads the DB so a deleted/re-roled user is caught
// even while their cookie is still cryptographically valid.
router.get('/me', authenticateJWT, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT id, username, role FROM users WHERE id = $1', [req.user.id]);
  if (!result.rows.length) return res.status(401).json({ error: 'Session user no longer exists' });
  res.json(result.rows[0]);
}));

router.post('/logout', (_req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

module.exports = router;
