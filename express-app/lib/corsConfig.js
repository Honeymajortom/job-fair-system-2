// Red-team M3: both the HTTP server (server.js) and the Socket.IO server
// (lib/io.js) used to reflect *any* Origin with credentials: true — shared
// here so the two can't drift. CORS_ORIGIN in .env overrides the default
// (comma-separated), which covers only the Vite dev server.
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',').map((s) => s.trim()).filter(Boolean);

function origin(o, callback) {
  // No Origin header (curl, server-to-server, same-origin) — allow.
  // A disallowed origin gets `false`, not a thrown error: the `cors`
  // package then just omits Access-Control-Allow-Origin (browser blocks the
  // read client-side) instead of surfacing as a noisy 500.
  callback(null, !o || allowedOrigins.includes(o));
}

module.exports = { allowedOrigins, corsOptions: { origin, credentials: true } };
