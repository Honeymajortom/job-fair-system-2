require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const { attach } = require('./lib/io');
const { corsOptions } = require('./lib/corsConfig');

const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const fairRoutes = require('./routes/fair');
const companiesRoutes = require('./routes/companies');
const candidatesRoutes = require('./routes/candidates');
const queueRoutes = require('./routes/queue');
const batchesRoutes = require('./routes/batches');
const publicRoutes = require('./routes/public');
const reportsRoutes = require('./routes/reports');
const centersRoutes = require('./routes/centers');

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

// Red-team M3: `origin: true` reflected *any* Origin header back with
// credentials: true, which is a CSRF-adjacent misconfiguration (sameSite:lax
// on the session cookie already blocks most of the practical exploit, but
// the CORS layer shouldn't rely on that alone). Allow-list instead, shared
// with lib/io.js's Socket.IO server so the two can't drift.
app.use(cors(corsOptions));
// gzip/brotli for JSON/CSV responses (reports.js's ?format=csv exports and
// every route's JSON payload) — negotiated automatically off the client's own
// Accept-Encoding header, nothing to configure client-side. Only kicks in
// above ~1KB (compression's own default threshold — not worth the CPU below
// that) and skips anything the response already marks as compressed (a
// pre-set Content-Encoding header, or a mime type mime-db lists as
// non-compressible, e.g. the resume PDFs candidates.js streams — those are
// already internally deflate-encoded, so re-gzipping them would just burn
// CPU for no size win).
app.use(compression());
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
app.use('/api', centersRoutes);

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
