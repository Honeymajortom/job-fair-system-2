require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { attach } = require('./lib/io');

const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const fairRoutes = require('./routes/fair');
const companiesRoutes = require('./routes/companies');
const candidatesRoutes = require('./routes/candidates');
const queueRoutes = require('./routes/queue');
const batchesRoutes = require('./routes/batches');
const publicRoutes = require('./routes/public');
const reportsRoutes = require('./routes/reports');

// @socket.io/redis-adapter fires an internal (p)subscribe on the sub client
// at construction/reconnect time without awaiting or catching it; if Redis is
// down at that moment the rejected promise is unhandled, and Node's default
// for unhandledRejection is to crash the process. Every Redis client in this
// app is already designed to fail open (see lib/redisClient.js's comments)
// — a stray unhandled rejection from a vendored dependency should
// not undo that by taking the whole API down.
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection (contained, not crashing):', reason);
});

const app = express();

// credentials: true so the HttpOnly session cookie survives cross-origin dev (Vite on :5173)
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());

app.use('/api', authRoutes);
app.use('/api', usersRoutes);
app.use('/api', fairRoutes);
app.use('/api', companiesRoutes);
app.use('/api', candidatesRoutes);
app.use('/api', queueRoutes);
app.use('/api', batchesRoutes);
app.use('/api', publicRoutes);
app.use('/api', reportsRoutes);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Centralized error handler — keeps route handlers free of try/catch boilerplate
// for the "let it bubble" cases (unexpected DB errors) while validation errors
// (explicit res.status(...) calls above) short-circuit before reaching here.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Socket.IO shares the HTTP server (nginx proxies /socket.io/* here in prod);
// the Redis adapter fans events out across PM2 cores and lets the worker emit.
const server = http.createServer(app);
attach(server);

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`API listening on http://localhost:${port}`));
