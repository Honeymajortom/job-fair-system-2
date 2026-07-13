const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const asyncHandler = require('../asyncHandler');
const { authenticateJWT, extractToken, JWT_SECRET } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');

const router = express.Router();

const SESSION_HOURS = 8; // v2.5: JWT HttpOnly cookie, 8h

// Red-team finding H1: unthrottled login invites credential brute-force.
// Per-username and per-IP windows, same fixed-window-Redis-counter pattern as
// the public registration limiters (fails open on Redis outage — an outage
// must never lock staff out of the fair).
const loginUserLimit = rateLimit({ prefix: 'login-user', windowSec: 900, max: 8, key: (req) => (req.body && req.body.username || '').toLowerCase() });
const loginIpLimit = rateLimit({ prefix: 'login-ip', windowSec: 900, max: 30, key: (req) => req.ip });

// Staff login — sets the session cookie. The token is also returned in the
// body as a prototype convenience (Bearer fallback for curl); the HttpOnly
// cookie is the canonical mechanism.
router.post('/login', loginUserLimit, loginIpLimit, asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = result.rows[0];
  // async compare — sync bcrypt blocks the event loop for ~100ms per call,
  // which a login flood could use to stall the whole API (red-team H1).
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Payload is deliberately minimal — role/username/company_id are re-read
  // from the DB on every request by authenticateJWT (H2), so the JWT only
  // needs to carry an identity + the token_version it was issued against.
  const token = jwt.sign(
    { id: user.id, tv: user.token_version },
    JWT_SECRET,
    { expiresIn: `${SESSION_HOURS}h` }
  );
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
  });
  res.json({ id: user.id, username: user.username, role: user.role, company_id: user.company_id, token });
}));

// authenticateJWT already re-reads the live user row (and rejects a revoked
// token_version), so /me can just echo what it attached to req.user.
router.get('/me', authenticateJWT, asyncHandler(async (req, res) => {
  res.json(req.user);
}));

// Logout is deliberately lenient (never 401s just because the cookie is
// already gone/expired) but, when the token is still identifiable, bumps
// token_version so this and every other outstanding token for that user is
// revoked immediately instead of riding out its 8h TTL (red-team H2).
router.post('/logout', asyncHandler(async (req, res) => {
  const token = extractToken(req);
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [payload.id]);
    } catch (_err) { /* already invalid/expired — nothing to revoke */ }
  }
  res.clearCookie('token');
  res.json({ ok: true });
}));

module.exports = router;
