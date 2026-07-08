require('dotenv').config();
const jwt = require('jsonwebtoken');

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is not set — copy .env.example to .env and fill it in');
}

const JWT_SECRET = process.env.JWT_SECRET;

// The JWT lives in an HttpOnly cookie set by POST /login (per v2.5: 8h cookie
// + GET /me revalidation). An Authorization: Bearer header is accepted as a
// fallback so curl/scripts can exercise gated endpoints without a cookie jar.
function authenticateJWT(req, res, next) {
  let token = req.cookies && req.cookies.token;
  if (!token) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) token = header.slice('Bearer '.length);
  }
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    req.user = jwt.verify(token, JWT_SECRET); // { id, username, role }
  } catch (_err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  next();
}

module.exports = { authenticateJWT, JWT_SECRET };
