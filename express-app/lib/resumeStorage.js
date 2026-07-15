// Resume PDF upload (handoff.md's build-ready design, picked up 2026-07-15).
// Shared by routes/public.js (upload) and routes/candidates.js (serve) so the
// disk path is defined once. token_no is server-generated, never user input,
// so `${token}.pdf` is a safe filename with no path-traversal risk, and
// naturally idempotent on re-upload (just overwrites).
const fs = require('fs');
const path = require('path');

const RESUME_DIR = path.join(__dirname, '..', 'uploads', 'resumes');
fs.mkdirSync(RESUME_DIR, { recursive: true });

module.exports = { RESUME_DIR };
