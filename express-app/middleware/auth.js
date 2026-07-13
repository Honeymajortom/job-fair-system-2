require('dotenv').config();
const jwt = require('jsonwebtoken');
const pool = require('../db');

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is not set — copy .env.example to .env and fill it in');
}

const JWT_SECRET = process.env.JWT_SECRET;

// The JWT lives in an HttpOnly cookie set by POST /login (8h TTL). An
// Authorization: Bearer header is accepted as a fallback so curl/scripts can
// exercise gated endpoints without a cookie jar.
function extractToken(req) {
  if (req.cookies && req.cookies.token) return req.cookies.token;
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice('Bearer '.length);
  return null;
}

// Red-team finding H2: a cryptographically-valid JWT used to stay accepted
// for its full 8h life even after logout, a password reset, or a role/company
// change — there was no way to kill a session mid-event. The JWT payload now
// only carries {id, tv}; role/username/company_id are re-read from the DB on
// every request (also closes the "role change takes up to 8h to apply"
// gap) and the token is rejected outright if `tv` no longer matches the
// user's current token_version (bumped by logout / routes/users.js resets).
async function authenticateJWT(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET); // { id, tv }
  } catch (_err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  try {
    const result = await pool.query(
      'SELECT id, username, role, company_id, token_version FROM users WHERE id = $1',
      [payload.id]
    );
    const user = result.rows[0];
    if (!user || user.token_version !== payload.tv) {
      return res.status(401).json({ error: 'Session revoked — please log in again' });
    }
    req.user = { id: user.id, username: user.username, role: user.role, company_id: user.company_id };
  } catch (err) {
    return next(err);
  }
  next();
}

module.exports = { authenticateJWT, extractToken, JWT_SECRET };
