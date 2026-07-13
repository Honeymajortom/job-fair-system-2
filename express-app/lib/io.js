require('dotenv').config();
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const IORedis = require('ioredis');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const pool = require('../db');
const events = require('./events');

// Staff-only WebSocket (v3.0 §2: "WebSocket (staff only)" — candidates poll,
// they never get a socket). Auth accepts the session JWT either from the
// HttpOnly cookie (browser) or handshake.auth.token (scripts/tests).
function attach(httpServer) {
  const pub = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: 1 });
  const sub = pub.duplicate();
  pub.on('error', (err) => console.error('[io] Redis pub error:', err.message));
  sub.on('error', (err) => console.error('[io] Redis sub error:', err.message));

  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
  });
  io.adapter(createAdapter(pub, sub));

  io.use(async (socket, next) => {
    let token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) {
      const cookies = socket.handshake.headers.cookie || '';
      const match = cookies.match(/(?:^|;\s*)token=([^;]+)/);
      if (match) token = decodeURIComponent(match[1]);
    }
    if (!token) return next(new Error('Not authenticated'));
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET); // { id, tv }
    } catch (_err) {
      return next(new Error('Invalid or expired session'));
    }
    try {
      // Same live-lookup + token_version check as authenticateJWT (red-team
      // H2) — otherwise a logged-out/reset JWT stays usable over the socket
      // for the rest of its 8h life even after the HTTP API rejects it.
      const result = await pool.query(
        'SELECT id, username, role, company_id, token_version FROM users WHERE id = $1',
        [payload.id]
      );
      const user = result.rows[0];
      if (!user || user.token_version !== payload.tv) {
        return next(new Error('Session revoked'));
      }
      socket.user = { id: user.id, username: user.username, role: user.role, company_id: user.company_id };
      next();
    } catch (err) {
      next(err);
    }
  });

  // Queue-system Phase 3: a desk tablet joins its own room so dispatch
  // events for other companies/desks never reach it. Room name matches
  // events.emitToRoom's convention: desk:{companyId}:{deskId}.
  // Red-team L1/H3: a company_hr socket may only join its own company's desk
  // rooms — everyone else (admin/floor_manager/registration_staff/volunteer)
  // keeps the original any-desk access this surface always had.
  io.on('connection', (socket) => {
    socket.on('join-desk', ({ companyId, deskId }) => {
      if (companyId == null || deskId == null) return;
      if (socket.user.role === 'company_hr' && Number(socket.user.company_id) !== Number(companyId)) return;
      socket.join(`desk:${companyId}:${deskId}`);
    });
  });

  events.setIo(io);
  return io;
}

module.exports = { attach };
