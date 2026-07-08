require('dotenv').config();
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const IORedis = require('ioredis');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
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

  io.use((socket, next) => {
    let token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) {
      const cookies = socket.handshake.headers.cookie || '';
      const match = cookies.match(/(?:^|;\s*)token=([^;]+)/);
      if (match) token = decodeURIComponent(match[1]);
    }
    if (!token) return next(new Error('Not authenticated'));
    try {
      socket.user = jwt.verify(token, JWT_SECRET); // { id, username, role }
      next();
    } catch (_err) {
      next(new Error('Invalid or expired session'));
    }
  });

  events.setIo(io);
  return io;
}

module.exports = { attach };
