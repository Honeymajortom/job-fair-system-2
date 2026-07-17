const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const pool = require('../db');
const asyncHandler = require('../asyncHandler');
const { authenticateJWT, JWT_SECRET } = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const rateLimit = require('../middleware/rateLimit');
const redisCache = require('../middleware/redisCache');
const registerCandidate = require('../lib/registerCandidate');
const { normalizeMobile } = require('../lib/mobile');
const store = require('../lib/queueStore');
const { resolveRung } = require('../lib/pingLadder');
const { computeGateStatus } = require('../lib/gateStatus');
const { RESUME_DIR } = require('../lib/resumeStorage');
const { verifyQr } = require('../lib/checkinSig');

const router = express.Router();

// ---------------------------------------------------------------------------
// Rate limiters — v3.0 §5, venue-NAT-proof. L1 (mobile) is the anchor; L3 (IP)
// is only a bot backstop because the whole hall shares one public IP.
// ---------------------------------------------------------------------------

// Device key: the qr_device cookie set on first GET /qr/companies; before the
// cookie exists (or with cookies blocked) fall back to a UA+IP hash.
function deviceKey(req) {
  if (req.cookies && req.cookies.qr_device) return req.cookies.qr_device;
  return crypto.createHash('sha256')
    .update(`${req.headers['user-agent'] || ''}|${req.ip}`)
    .digest('hex').slice(0, 16);
}

const l1Mobile = rateLimit({ prefix: 'mobile', windowSec: 600, max: 3, key: (req) => normalizeMobile(req.body && req.body.mobile) });
const l2Device = rateLimit({ prefix: 'device', windowSec: 600, max: 10, key: deviceKey });
const l3Ip = rateLimit({ prefix: 'ip', windowSec: 60, max: 300, key: (req) => req.ip });
const readIpLimit = rateLimit({ prefix: 'read-ip', windowSec: 60, max: 600, key: (req) => req.ip });

// Recovery-specific limiters, separate budgets from l1Mobile/l3Ip above: this
// endpoint returns a candidate's name + live token given only a mobile
// number, so the mobile-keyed limit is the real gate against someone
// enumerating numbers to fish for who's registered — kept tight (5/10min).
// The IP backstop is generous for the same NAT-sharing reason l3Ip is (a
// whole venue behind one public IP), it only catches a bot hammering many
// numbers from one connection.
const recoverMobile = rateLimit({ prefix: 'recover-mobile', windowSec: 600, max: 5, key: (req) => normalizeMobile(req.body && req.body.mobile) });
const recoverIp = rateLimit({ prefix: 'recover-ip', windowSec: 600, max: 30, key: (req) => req.ip });

// Schedule-specific limiters: LivePosition.jsx polls its own token every 5s
// (~12/min), and a venue full of candidates shares one NAT IP — readIpLimit's
// 600/min budget would 429 real candidates within seconds of the fair
// opening. Per-token is the real gate (isolates one candidate's polling from
// everyone else's); the IP limit stays underneath it as a coarser bot
// backstop, sized for the whole hall's aggregate legitimate polling rather
// than a single client's.
const readTokenLimit = rateLimit({ prefix: 'read-token', windowSec: 60, max: 20, key: (req) => req.params.token });
const scheduleIpLimit = rateLimit({ prefix: 'schedule-ip', windowSec: 60, max: 15000, key: (req) => req.ip });

// Resume upload: 5 attempts / 10min per token — a candidate re-uploading a
// couple of times (wrong file, retry after a flaky connection) is normal;
// anything past that is someone hammering one token's slot. Keyed on the
// *verified* token_no (post-signature-check), not the raw :qr param, so the
// counter is meaningful even across the rare legitimate case of a client
// somehow sending a stale-but-still-valid qr string in a slightly different
// form.
const resumeUploadLimit = rateLimit({ prefix: 'resume-upload', windowSec: 600, max: 5, key: (req) => verifyQr(req.params.qr) });

// PDF-only (mimetype + extension check, no magic-byte sniffing — matches
// this project's minimal-dependency style), 5MB cap. Filename is always
// `${req.verifiedToken}.pdf` — set by the route handler below only *after*
// verifyQr() has confirmed the signature, never taken from the URL directly
// (red-team finding, 2026-07-15: token_no is sequential/guessable, so trusting
// it bare here would let anyone overwrite any candidate's resume by just
// enumerating A-1, A-2, A-3…, same class of bug the check-in QR's HMAC
// already exists to prevent — this route just hadn't reused that precedent).
const resumeUpload = multer({
  storage: multer.diskStorage({
    destination: RESUME_DIR,
    filename: (req, _file, cb) => cb(null, `${req.verifiedToken}.pdf`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isPdf = file.mimetype === 'application/pdf' && file.originalname.toLowerCase().endsWith('.pdf');
    cb(isPdf ? null : new Error('Only PDF files are allowed'), isPdf);
  },
});

function runResumeUpload(req, res) {
  return new Promise((resolve, reject) => {
    resumeUpload.single('resume')(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

// L2's cookie is minted on the first public read (v3.0 §5: "set as httpOnly
// cookie on first GET /qr").
function ensureDeviceCookie(req, res, next) {
  if (!req.cookies || !req.cookies.qr_device) {
    res.cookie('qr_device', crypto.randomBytes(8).toString('hex'), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production', // red-team M3
      maxAge: 24 * 60 * 60 * 1000,
    });
  }
  next();
}

// ---------------------------------------------------------------------------
// Routes — mounted under /api, so these serve /api/qr/*
// ---------------------------------------------------------------------------

// Admin: mint the fair QR (flow A) — a signed 24h JWT embedded in the QR URL
// printed at the entrance. Registration is only accepted with a valid one
// (integrity fix #6: fake QR registrations).
router.get('/qr/token', authenticateJWT, requireRole('admin'), asyncHandler(async (_req, res) => {
  const fair = await pool.query(
    'SELECT fair_name, fair_date, fair_hours FROM fair_settings WHERE is_active = true ORDER BY fair_date DESC LIMIT 1'
  );
  if (!fair.rows.length) return res.status(404).json({ error: 'No active fair configured' });

  // Red-team M4: a flat 24h TTL meant a photographed entrance QR stayed a
  // live registration bearer token for a full extra day past the event.
  // Bound it to the fair's own duration instead (+1h grace for late walk-ins
  // and the lag between minting and actually printing the poster).
  const fairHours = Number(fair.rows[0].fair_hours) || 8;
  const ttlHours = Math.min(fairHours + 1, 16);

  const qrToken = jwt.sign(
    { purpose: 'qr_registration', fair_date: fair.rows[0].fair_date },
    JWT_SECRET,
    { expiresIn: `${ttlHours}h` }
  );
  res.json({ fair_name: fair.rows[0].fair_name, qr_token: qrToken, register_url: `/qr?token=${qrToken}` });
}));

// Public: company tiles — cache TTL 60s (v3.0 §7). Also mints the L2 device
// cookie, since this is the first request the registration page makes.
router.get('/qr/companies', readIpLimit, ensureDeviceCookie, redisCache(60), asyncHandler(async (_req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.company_name, c.description, c.location, c.field, c.job_type,
            c.min_qualification, c.max_qualification,
            COALESCE(SUM(GREATEST(s.capacity - t.taken, 0)), 0)::int AS open_slots
     FROM companies c
     LEFT JOIN interview_slots s ON s.company_id = c.id AND s.slot_start >= now()
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS taken FROM candidate_company_status ccs
       WHERE ccs.slot_id = s.id AND ccs.deleted_at IS NULL
     ) t ON true
     GROUP BY c.id
     ORDER BY c.company_name`
  );
  // Queue-system Phase 4: open_slots above is stale for the new capacity-gate
  // model (it only ever counted interview_slots rows) — left untouched per
  // handoff.md, but queue_depth gives the tile screen a live, correct "N
  // people ahead" number to show instead/alongside it.
  const rows = await Promise.all(result.rows.map(async (row) => ({
    ...row,
    queue_depth: await store.queueSize(row.id),
  })));
  res.json(rows);
}));

// Public: self-registration — the morning-spike path. Limiters run first so
// spam never burns a DB transaction; then the fair QR JWT is verified; then
// the same shared transaction as the staff path.
router.post('/qr/register', l1Mobile, l2Device, l3Ip, asyncHandler(async (req, res) => {
  const { qr_token, mobile } = req.body;

  try {
    const payload = jwt.verify(qr_token, JWT_SECRET);
    if (payload.purpose !== 'qr_registration') throw new Error('wrong purpose');
  } catch (_err) {
    return res.status(401).json({ error: 'Invalid or expired fair QR — please rescan the code at the entrance' });
  }

  // The public path requires a mobile number: it's the dedup key and the L1
  // rate-limit anchor. (Staff manual registration may omit it — flow D.)
  if (!mobile || !normalizeMobile(mobile)) {
    return res.status(400).json({ error: 'A valid mobile number is required' });
  }

  const result = await registerCandidate(req.body);
  res.status(result.status).json(result.body);
}));

// Public: optional resume attach, called right after POST /qr/register
// succeeds. Deliberately a separate endpoint rather than making /qr/register
// multipart: registerCandidate() is a single shared, heavily-tested
// transaction consumed by both the staff and public paths; touching it risks
// that whole path for an optional, orthogonal feature.
//
// :qr is the same signed "{token_no}.{HMAC}" string the check-in QR uses
// (lib/checkinSig.js) — NOT the bare token_no. token_no is sequential and
// trivially guessable (A-1, A-2, A-3…), so this is a write endpoint; unlike
// the read-only /qr/schedule/:token, "the token IS the capability" is the
// wrong model here — bare token_no would let anyone overwrite any
// candidate's resume by enumeration. Reuses the exact scheme check-in
// already relies on for the same reason, rather than inventing a new one.
router.post('/qr/resume/:qr', resumeUploadLimit, asyncHandler(async (req, res) => {
  const tokenNo = verifyQr(req.params.qr);
  if (!tokenNo) return res.status(401).json({ error: 'Invalid or forged resume-upload link' });

  const candRes = await pool.query('SELECT id FROM candidates WHERE token_no = $1 AND deleted_at IS NULL', [tokenNo]);
  if (!candRes.rows.length) return res.status(404).json({ error: 'Candidate not found' });

  req.verifiedToken = tokenNo; // consumed by resumeUpload's diskStorage filename callback above
  try {
    await runResumeUpload(req, res);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Upload failed' });
  }
  if (!req.file) return res.status(400).json({ error: 'resume file is required' });

  await pool.query('UPDATE candidates SET resume_uploaded_at = now() WHERE token_no = $1', [tokenNo]);
  res.json({ ok: true });
}));

// Public: recover a lost token page by mobile number (candidate closed the
// tab / lost the device and has no bookmark). Requires the same fair-QR JWT
// registration requires — proves the requester actually rescanned the
// entrance code, not just guessed a number cold — plus a mobile match.
// Deliberately returns only token_no + name, never checkin_sig: same reason
// GET /qr/schedule/:token withholds it (red-team finding C1) — a mobile
// number is far easier to guess/target than a signed token, so handing back
// the gate check-in bypass here would be strictly worse.
router.post('/qr/recover', recoverMobile, recoverIp, asyncHandler(async (req, res) => {
  const { qr_token, mobile } = req.body;

  try {
    const payload = jwt.verify(qr_token, JWT_SECRET);
    if (payload.purpose !== 'qr_registration') throw new Error('wrong purpose');
  } catch (_err) {
    return res.status(401).json({ error: 'Invalid or expired fair QR — please rescan the code at the entrance' });
  }

  const normMobile = normalizeMobile(mobile);
  if (!normMobile) return res.status(400).json({ error: 'A valid mobile number is required' });

  const result = await pool.query(
    'SELECT token_no, name FROM candidates WHERE mobile = $1 AND deleted_at IS NULL',
    [normMobile]
  );
  if (!result.rows.length) {
    return res.status(404).json({ error: "We couldn't find a registration for that number" });
  }

  res.json({ token: result.rows[0].token_no, name: result.rows[0].name });
}));

// Public: live schedule page data (v3.0 flow F) — bookmarkable, no auth, the
// token IS the capability. Cache TTL 15s; LivePosition.jsx polls every 5s, so
// per-token limiting (not just per-IP) is what actually needs to hold here —
// see readTokenLimit/scheduleIpLimit above.
router.get('/qr/schedule/:token', readTokenLimit, scheduleIpLimit, redisCache(15), asyncHandler(async (req, res) => {
  const candRes = await pool.query(
    `SELECT cd.id, cd.name, cd.token_no, cd.checked_in_at, cd.travel_time_minutes,
            b.batch_number, b.arrival_time, b.status AS batch_status
     FROM candidates cd
     LEFT JOIN fair_batches b ON b.id = cd.batch_id
     WHERE cd.token_no = $1 AND cd.deleted_at IS NULL`,
    [req.params.token]
  );
  if (!candRes.rows.length) return res.status(404).json({ error: 'Schedule not found' });
  const cand = candRes.rows[0];

  const slotsRes = await pool.query(
    `SELECT s.slot_start AS time, c.company_name AS company, c.location, ccs.status,
            ccs.company_id, ccs.serial, c.seats, c.interview_minutes, ccs.interview_started_at
     FROM candidate_company_status ccs
     JOIN companies c ON c.id = ccs.company_id
     LEFT JOIN interview_slots s ON s.id = ccs.slot_id
     WHERE ccs.candidate_id = $1 AND ccs.deleted_at IS NULL
     ORDER BY s.slot_start ASC NULLS LAST`,
    [cand.id]
  );

  // Queue-system Phase 4: position/eta_minutes/rung only apply to serial-based
  // (new-model) bookings — waitlisted entries (serial IS NULL) are left as-is
  // so the frontend can render a distinct waitlisted card.
  const slots = await Promise.all(slotsRes.rows.map(async (row) => {
    const base = { time: row.time, company: row.company, location: row.location, status: row.status };
    if (row.serial === null) return base;
    const ladder = await resolveRung({
      status: row.status,
      companyId: row.company_id,
      candidateId: cand.id,
      travelTimeMinutes: cand.travel_time_minutes,
      seats: row.seats,
      interviewMinutes: row.interview_minutes,
      interviewStartedAt: row.interview_started_at,
    });
    return { ...base, ...ladder };
  }));

  res.json({
    name: cand.name,
    token: cand.token_no,
    // Top-level, not nested under batch: checked_in_at lives on candidates
    // directly and can be set (routes/batches.js check-in) before any batch
    // is ever assigned (batch_id starts NULL "before any batch existed
    // yet" — see registerCandidate.js), so gating this behind `batch` being
    // non-null would hide checked-in status for exactly those candidates.
    checked_in: !!cand.checked_in_at,
    // checkin_sig is deliberately NOT returned here (red-team finding C1):
    // token_no is a guessable/enumerable sequential id, so echoing the HMAC
    // on every poll would hand an attacker the gate check-in bypass for any
    // candidate they can guess. The QR is captured once client-side at
    // registration (DetailsForm.jsx -> localStorage) and rendered from there
    // by LivePosition.jsx; staff have a manual candidate_token fallback for
    // the lost-device case (routes/batches.js check-in).
    batch: cand.batch_number === null ? null : {
      number: cand.batch_number,
      arrival_time: cand.arrival_time,
      status: cand.batch_status,
      checked_in: !!cand.checked_in_at,
    },
    slots,
  });
}));

// Public: Entrance Gate + Staging board (new_architecture_uiux_spec.html §03)
// — a monitor at the venue entrance, not a candidate's own device. Short
// cache TTL (unlike qr/companies' 60s) since the whole point is that it
// visibly moves; readIpLimit is generous enough for one screen polling
// continuously plus normal candidate traffic sharing the venue's NAT.
router.get('/gate-status', readIpLimit, redisCache(10), asyncHandler(async (_req, res) => {
  res.json(await computeGateStatus());
}));

module.exports = router;
