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
const { assignCompanies } = require('../lib/companyAssignment');
const { normalizeMobile, isValidMobile } = require('../lib/mobile');
const store = require('../lib/queueStore');
const { resolveRung } = require('../lib/pingLadder');
const { computeGateStatus } = require('../lib/gateStatus');
const { RESUME_DIR } = require('../lib/resumeStorage');
const { verifyQr } = require('../lib/checkinSig');
const { emit, emitToRoom } = require('../lib/events');
const redis = require('../lib/redisClient');

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

// Feedback: same 5/10min-per-verified-token budget as resume upload — a
// couple of resubmits (fixed a misclick) is normal, more than that is noise.
const feedbackLimit = rateLimit({ prefix: 'feedback', windowSec: 600, max: 5, key: (req) => verifyQr(req.params.qr) });

// Company selection: same 5/10min-per-verified-token budget as feedback/resume
// — one real submission plus a couple of retries (flaky connection) is
// normal; the route itself is one-shot anyway (see below), so this is really
// just a backstop against hammering.
const selectCompaniesLimit = rateLimit({ prefix: 'select-companies', windowSec: 600, max: 5, key: (req) => verifyQr(req.params.qr) });

// Candidate "I'm on my way" acknowledgment: same 5/10min-per-verified-token
// budget as feedback/resume/select-companies above — a couple of taps (retry
// after a flaky connection) is normal, this is just a backstop against
// hammering.
const acknowledgeLimit = rateLimit({ prefix: 'acknowledge', windowSec: 600, max: 5, key: (req) => verifyQr(req.params.qr) });

// candidate_and_desk_improvements_plan.md §C: PDF or image (jpg/jpeg/png) —
// mimetype + extension check, no magic-byte sniffing, same minimal-dependency
// style as the PDF-only check this replaces. 5MB cap unchanged. Filename is
// `${req.verifiedToken}.{ext}` — set by the route handler below only *after*
// verifyQr() has confirmed the signature, never taken from the URL directly
// (red-team finding, 2026-07-15: token_no is sequential/guessable, so trusting
// it bare here would let anyone overwrite any candidate's resume by just
// enumerating A-1, A-2, A-3…, same class of bug the check-in QR's HMAC
// already exists to prevent — this route just hadn't reused that precedent).
// resolveExt() decides the on-disk extension from the upload's own mimetype/
// name — used by both fileFilter (to accept/reject) and diskStorage.filename
// (multer's filename callback only gets `file`, not whatever fileFilter
// computed, so this is a plain function shared by both rather than a value
// stashed on req).
function resolveResumeExt(file) {
  if (file.mimetype === 'application/pdf' && file.originalname.toLowerCase().endsWith('.pdf')) return 'pdf';
  if (file.mimetype === 'image/png' && file.originalname.toLowerCase().endsWith('.png')) return 'png';
  if (file.mimetype === 'image/jpeg' && /\.(jpg|jpeg)$/i.test(file.originalname)) return 'jpg';
  return null;
}

const resumeUpload = multer({
  storage: multer.diskStorage({
    destination: RESUME_DIR,
    filename: (req, file, cb) => cb(null, `${req.verifiedToken}.${resolveResumeExt(file)}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = resolveResumeExt(file);
    cb(ext ? null : new Error('Only PDF or image (JPG/PNG) files are allowed'), Boolean(ext));
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

// GET /qr/schedule/:token below is redisCache(15)'d — a plain TTL, no
// write-side invalidation. Any route here that changes what that response
// contains has to bust it explicitly, or a poll landing inside the same 15s
// window as the write serves the stale pre-write body: a candidate submits
// feedback, the screen should move on to the exit QR, but the next ~5s poll
// can hand back a cached response that still says feedback_submitted: false
// — the screen visibly reverts mid-flow before flipping forward again once
// the cache entry actually expires. Same reasoning applies to select-
// companies (stale response would keep showing the picker after it was
// already submitted). Best-effort, same fail-open convention as every other
// cache write in this app — a missed invalidation just means the existing
// 15s staleness window applies once more, not a broken request.
async function invalidateSchedule(tokenNo) {
  try { await redis.del(`cache:/api/qr/schedule/${tokenNo}`); } catch (_err) { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Routes — mounted under /api, so these serve /api/qr/*
// ---------------------------------------------------------------------------

// Admin / Registration Staff: mint the fair QR (flow A) — a signed 24h JWT
// embedded in the QR URL printed at the entrance. Registration is only
// accepted with a valid one (integrity fix #6: fake QR registrations).
// centerId (fair_cycle_isolation_plan.md Phase 5 follow-up): this is the one
// place a candidate-facing registration ever gets a Center assigned — the QR
// is printed at one physical entrance, so the mint step is exactly where
// "which Center" has a real, unambiguous answer, not something to re-derive
// later at each individual registration. registration_staff is pinned to
// their own Center; admin may pass one explicitly, and must when more than
// one Center currently has an active fair (otherwise this QR would silently
// register everyone who scans it into an arbitrary one of them).
router.get('/qr/token', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (req, res) => {
  let centerId = req.user.role === 'admin' ? (req.query.center_id ? Number(req.query.center_id) : null) : req.user.center_id;
  if (centerId == null) {
    const activeCount = await pool.query('SELECT COUNT(*)::int AS n FROM fair_settings WHERE is_active = true');
    if (activeCount.rows[0].n > 1) {
      return res.status(400).json({ error: 'Multiple centers have an active fair — center_id is required' });
    }
  }
  const fair = await pool.query(
    'SELECT fair_name, fair_date, fair_hours FROM fair_settings WHERE is_active = true AND ($1::int IS NULL OR center_id = $1) ORDER BY fair_date DESC LIMIT 1',
    [centerId]
  );
  if (!fair.rows.length) return res.status(404).json({ error: 'No active fair configured' });

  // Red-team M4: a flat 24h TTL meant a photographed entrance QR stayed a
  // live registration bearer token for a full extra day past the event.
  // Bound it to the fair's own duration instead (+1h grace for late walk-ins
  // and the lag between minting and actually printing the poster).
  const fairHours = Number(fair.rows[0].fair_hours) || 8;
  const ttlHours = Math.min(fairHours + 1, 16);

  const qrToken = jwt.sign(
    { purpose: 'qr_registration', fair_date: fair.rows[0].fair_date, center_id: centerId },
    JWT_SECRET,
    { expiresIn: `${ttlHours}h` }
  );
  res.json({ fair_name: fair.rows[0].fair_name, qr_token: qrToken, register_url: `/qr?token=${qrToken}` });
}));

// Public: company tiles — cache TTL 60s (v3.0 §7). Also mints the L2 device
// cookie, since this is the first request the registration page makes.
// is_open filters out companies nobody's actually staffing yet/today — a
// candidate shouldn't be able to book a desk that isn't running (see
// schema.sql's is_open comment). Companies a candidate already booked keep
// showing on their own schedule page (GET /qr/schedule/:token) regardless —
// this filter only applies to the initial pick-a-company step.
router.get('/qr/companies', readIpLimit, ensureDeviceCookie, redisCache(60), asyncHandler(async (req, res) => {
  // Center scoping (fair_cycle_isolation_plan.md): companies are 1:1 with a
  // Center, but this query had no center filter at all until this fix — any
  // is_open company anywhere in the system showed to every candidate,
  // regardless of which Center's fair they actually checked in at (found via
  // a stale company from a different, unrelated Center bleeding into a live
  // fair's candidate picker). ?qr= is the candidate's own signed check-in QR
  // (same as /qr/select-companies/:qr) — resolves their fair_settings_id ->
  // center_id. No qr (or an invalid one) falls back to the old unscoped
  // behavior rather than an empty list, since this is a read-only, low-
  // sensitivity endpoint and a single-Center deployment has no wrong answer
  // to scope against anyway.
  // company_roster_plan.md (item 4): a candidate should only ever be offered
  // companies actually on their own fair cycle's roster, not the full
  // historical per-Center directory — this is the roster-aware sequel to the
  // Center-scoping fix below (found the same session a stale Center-1
  // company was bleeding into Center 2's live fair; this closes the same
  // class of leak across fair *cycles* at the same Center, not just Centers).
  let centerId = null;
  let fairSettingsId = null;
  if (req.query.qr) {
    const tokenNo = verifyQr(String(req.query.qr));
    if (tokenNo) {
      const centerRes = await pool.query(
        `SELECT fs.center_id, cd.fair_settings_id FROM candidates cd
          JOIN fair_settings fs ON fs.id = cd.fair_settings_id
         WHERE cd.token_no = $1 AND cd.deleted_at IS NULL`,
        [tokenNo]
      );
      centerId = centerRes.rows[0]?.center_id ?? null;
      fairSettingsId = centerRes.rows[0]?.fair_settings_id ?? null;
    }
  }

  const result = await pool.query(
    `SELECT c.id, c.company_name, c.description, c.location, r.floor_number, c.field, c.job_type,
            c.min_qualification, c.max_qualification,
            COALESCE(SUM(GREATEST(s.capacity - t.taken, 0)), 0)::int AS open_slots
     FROM companies c
     JOIN fair_company_roster r ON r.company_id = c.id AND ($2::int IS NULL OR r.fair_settings_id = $2)
     LEFT JOIN interview_slots s ON s.company_id = c.id AND s.slot_start >= now()
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS taken FROM candidate_company_status ccs
       WHERE ccs.slot_id = s.id AND ccs.deleted_at IS NULL
     ) t ON true
     WHERE r.is_open = true AND ($1::int IS NULL OR c.center_id = $1)
     GROUP BY c.id, r.floor_number
     ORDER BY c.company_name`,
    [centerId, fairSettingsId]
  );
  // Queue-system Phase 4: open_slots above is stale for the new capacity-gate
  // model (it only ever counted interview_slots rows) — left untouched per
  // handoff.md, but queue_depth gives the tile screen a live, correct "N
  // people ahead" number to show instead/alongside it.
  const rows = await Promise.all(result.rows.map(async (row) => ({
    ...row,
    queue_depth: await store.queueSize(row.id),
  })));

  // candidate_and_desk_improvements_plan.md §A: SelectCompanies.jsx's "pick up
  // to N" cap is admin-configurable per fair cycle now, not a hardcoded
  // frontend constant — rides alongside the company list this endpoint
  // already returns rather than a second round trip. Falls back to the schema
  // default (3) when fairSettingsId couldn't be resolved (no/invalid ?qr=),
  // same as this route's other unscoped fallbacks above.
  const capRes = fairSettingsId
    ? await pool.query('SELECT max_companies_per_candidate FROM fair_settings WHERE id = $1', [fairSettingsId])
    : { rows: [] };
  const maxCompanies = capRes.rows.length ? capRes.rows[0].max_companies_per_candidate : 3;

  res.json({ companies: rows, max_companies_per_candidate: maxCompanies });
}));

// Public: self-registration — the morning-spike path. Limiters run first so
// spam never burns a DB transaction; then the fair QR JWT is verified; then
// the same shared transaction as the staff path.
router.post('/qr/register', l1Mobile, l2Device, l3Ip, asyncHandler(async (req, res) => {
  const { qr_token, mobile } = req.body;
  let payload;

  try {
    payload = jwt.verify(qr_token, JWT_SECRET);
    if (payload.purpose !== 'qr_registration') throw new Error('wrong purpose');
  } catch (_err) {
    return res.status(401).json({ error: 'Invalid or expired fair QR — please rescan the code at the entrance' });
  }

  // The public path requires a mobile number: it's the dedup key and the L1
  // rate-limit anchor. (Staff manual registration may omit it — flow D.)
  // isValidMobile, not just normalizeMobile — see lib/mobile.js: a bare
  // normalize-and-check-non-empty let any digit string through, making the
  // mobile-uniqueness re-registration guard trivial to defeat.
  if (!mobile || !isValidMobile(mobile)) {
    return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
  }

  // centerId (fair_cycle_isolation_plan.md Phase 5 follow-up) rides in the
  // fair-QR JWT itself, set once at GET /qr/token mint time — the candidate
  // never supplies or sees it, so there's no way to spoof registering into a
  // different Center than whichever entrance's QR was actually scanned.
  const result = await registerCandidate({ ...req.body, centerId: payload.center_id });
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

  // candidate_and_desk_improvements_plan.md §C: the serving route (routes/
  // candidates.js) and the Desk UI (<iframe> vs <img>) both need to know
  // which kind was actually stored — resolveResumeExt(req.file) here is the
  // same function fileFilter/diskStorage.filename already used to decide it.
  await pool.query('UPDATE candidates SET resume_uploaded_at = now(), resume_ext = $2 WHERE token_no = $1', [tokenNo, resolveResumeExt(req.file)]);
  res.json({ ok: true });
}));

const FEEDBACK_RATING_FIELDS = ['venue_rating', 'process_rating', 'staff_rating', 'overall_rating'];

// Public: post-fair feedback (star ratings + SDC interest) — LivePosition
// shows this once every one of a candidate's bookings has settled. Required
// before a repeat mobile can register again (registerCandidate.js's
// duplicate check looks for a matching row here). Same signed-qr write
// pattern as /qr/resume/:qr above and for the same reason — bare token_no is
// guessable, so this can't be a "the token IS the capability" route.
// Idempotent (ON CONFLICT upsert): resubmitting corrects a misclick without
// needing staff help.
router.post('/qr/feedback/:qr', feedbackLimit, asyncHandler(async (req, res) => {
  const tokenNo = verifyQr(req.params.qr);
  if (!tokenNo) return res.status(401).json({ error: 'Invalid or forged feedback link' });

  const ratings = FEEDBACK_RATING_FIELDS.map((f) => Number(req.body[f]));
  if (ratings.some((r) => !Number.isInteger(r) || r < 1 || r > 5)) {
    return res.status(400).json({ error: 'All four ratings are required (1-5 stars)' });
  }
  if (typeof req.body.interested_in_sdc !== 'boolean') {
    return res.status(400).json({ error: 'Please answer the SDC interest question' });
  }

  const candRes = await pool.query('SELECT id, mobile FROM candidates WHERE token_no = $1 AND deleted_at IS NULL', [tokenNo]);
  if (!candRes.rows.length) return res.status(404).json({ error: 'Candidate not found' });
  const cand = candRes.rows[0];

  await pool.query(
    `INSERT INTO candidate_feedback (candidate_id, mobile, venue_rating, process_rating, staff_rating, overall_rating, interested_in_sdc)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (candidate_id) DO UPDATE SET
       venue_rating = EXCLUDED.venue_rating, process_rating = EXCLUDED.process_rating,
       staff_rating = EXCLUDED.staff_rating, overall_rating = EXCLUDED.overall_rating,
       interested_in_sdc = EXCLUDED.interested_in_sdc, submitted_at = now()`,
    [cand.id, cand.mobile, ...ratings, req.body.interested_in_sdc]
  );

  await invalidateSchedule(tokenNo);
  res.json({ ok: true });
}));

// Public: pick companies after checking in at the Gate — the new candidate
// journey (Registration -> Details -> Gate check-in -> *here* -> live
// position), replacing the old registration-time company_ids requirement.
// Same signed-qr write pattern as /qr/resume/:qr and /qr/feedback/:qr above:
// bare token_no is guessable, so this can't be a "the token IS the
// capability" route. One-shot (like registration's own company pick) — a
// candidate who wants to add more companies later isn't supported here.
router.post('/qr/select-companies/:qr', selectCompaniesLimit, asyncHandler(async (req, res) => {
  const tokenNo = verifyQr(req.params.qr);
  if (!tokenNo) return res.status(401).json({ error: 'Invalid or forged link' });

  const candRes = await pool.query(
    'SELECT id, checked_in_at, fair_settings_id FROM candidates WHERE token_no = $1 AND deleted_at IS NULL',
    [tokenNo]
  );
  if (!candRes.rows.length) return res.status(404).json({ error: 'Candidate not found' });
  const candidate = candRes.rows[0];

  if (!candidate.checked_in_at) {
    return res.status(403).json({ error: 'Check in at the Gate before choosing companies' });
  }

  const existingRes = await pool.query(
    'SELECT 1 FROM candidate_company_status WHERE candidate_id = $1 AND deleted_at IS NULL LIMIT 1',
    [candidate.id]
  );
  if (existingRes.rows.length) {
    return res.status(409).json({ error: 'You have already selected your companies' });
  }

  const companyIds = req.body.company_ids;
  if (!Array.isArray(companyIds) || companyIds.length === 0) {
    return res.status(400).json({ error: 'Select at least one company' });
  }

  // company_roster_plan.md: read the candidate's own fair cycle (set at
  // registration) instead of a fresh "whichever fair is active" lookup —
  // arbitrary once 2+ Centers each have a live fair.
  // candidate_and_desk_improvements_plan.md §A: max_companies_per_candidate is
  // per-fair-cycle (admin-configurable) now, fetched alongside fair_hours off
  // the same row instead of the old hardcoded MAX_COMPANIES constant.
  const fairRes = candidate.fair_settings_id
    ? await pool.query('SELECT fair_hours, max_companies_per_candidate FROM fair_settings WHERE id = $1', [candidate.fair_settings_id])
    : { rows: [] };
  const fairHours = fairRes.rows.length ? Number(fairRes.rows[0].fair_hours) : 8;
  const maxCompanies = fairRes.rows.length ? fairRes.rows[0].max_companies_per_candidate : 3;

  if (companyIds.length > maxCompanies) {
    return res.status(400).json({ error: `Select at most ${maxCompanies} companies` });
  }

  const client = await pool.connect();
  let assigned, waitlisted;
  try {
    await client.query('BEGIN');
    ({ assigned, waitlisted } = await assignCompanies(client, { candidateId: candidate.id, company_ids: companyIds, fairHours, fairSettingsId: candidate.fair_settings_id }));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Same post-commit ordering as registerCandidate.js — a Redis outage must
  // never undo an already-committed booking.
  await invalidateSchedule(tokenNo);
  for (const a of assigned) {
    try {
      await store.enqueue(a.company_id, candidate.id, a.serial);
    } catch (err) {
      console.error(`[select-companies] queue enqueue failed for candidate ${candidate.id} company ${a.company_id}:`, err.message);
    }
  }

  if (assigned.length) {
    emit('queue_joined', {
      token: tokenNo,
      companies: assigned.map((a) => ({ company_id: a.company_id, company_name: a.company_name, serial: a.serial })),
      statsDelta: { queued: assigned.length },
    });
  }
  if (waitlisted.length) {
    emit('candidate_waitlisted', {
      token: tokenNo,
      companies: waitlisted.map((a) => ({ company_id: a.company_id, company_name: a.company_name })),
      statsDelta: { waitlisted: waitlisted.length },
    });
  }

  res.status(201).json({
    assigned: assigned.map(({ ccs_id, ...rest }) => rest),
    waitlisted: waitlisted.map(({ ccs_id, ...rest }) => rest),
  });
}));

// Public: candidate confirms they're on their way once called to a desk —
// notifies Company HR's tablet ahead of the candidate actually arriving/being
// scanned in. Pure notification, no DB write: the state that actually governs
// dispatch (Dispatched status, the no-show timer, misses) is untouched here,
// so a candidate tapping this (or not) can never desync the queue itself —
// it's purely informational for the desk. Same signed-qr pattern as the other
// post-registration public writes above.
router.post('/qr/acknowledge/:qr', acknowledgeLimit, asyncHandler(async (req, res) => {
  const tokenNo = verifyQr(req.params.qr);
  if (!tokenNo) return res.status(401).json({ error: 'Invalid or forged link' });

  const candRes = await pool.query(
    'SELECT id FROM candidates WHERE token_no = $1 AND deleted_at IS NULL',
    [tokenNo]
  );
  if (!candRes.rows.length) return res.status(404).json({ error: 'Candidate not found' });
  const candidateId = candRes.rows[0].id;

  const dispatchedRes = await pool.query(
    `SELECT company_id FROM candidate_company_status
     WHERE candidate_id = $1 AND status = 'Dispatched' AND deleted_at IS NULL
     LIMIT 1`,
    [candidateId]
  );
  if (!dispatchedRes.rows.length) {
    return res.status(409).json({ error: 'You have not been called to a desk yet' });
  }
  const companyId = dispatchedRes.rows[0].company_id;

  const deskId = await store.getLockDesk(candidateId);
  if (deskId) {
    emitToRoom(`desk:${companyId}:${deskId}`, 'candidate_acknowledged', { candidateId, companyId });
  }

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
  let payload;

  try {
    payload = jwt.verify(qr_token, JWT_SECRET);
    if (payload.purpose !== 'qr_registration') throw new Error('wrong purpose');
  } catch (_err) {
    return res.status(401).json({ error: 'Invalid or expired fair QR — please rescan the code at the entrance' });
  }

  const normMobile = normalizeMobile(mobile);
  if (!normMobile) return res.status(400).json({ error: 'A valid mobile number is required' });

  // fair_cycle_isolation_plan.md Phase 2 made the same mobile number valid
  // across multiple fair cycles (and, since Phase 5's fixture confirmed it,
  // across Centers too) — a bare `WHERE mobile = $1` can now match more than
  // one candidate, and picking .rows[0] arbitrarily could hand back the
  // wrong Center's token entirely. Scoped by this QR's own center_id (same
  // token this route already verifies above, no extra trust required);
  // falls back to "most recent registration" only for a token minted before
  // this fix that has no center_id yet, still valid within its own TTL.
  const result = await pool.query(
    `SELECT cd.token_no, cd.name FROM candidates cd
     LEFT JOIN fair_settings fs ON fs.id = cd.fair_settings_id
     WHERE cd.mobile = $1 AND cd.deleted_at IS NULL
       AND ($2::int IS NULL OR fs.center_id = $2)
     ORDER BY cd.registered_at DESC LIMIT 1`,
    [normMobile, payload.center_id || null]
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
    `SELECT cd.id, cd.name, cd.token_no, cd.checked_in_at, cd.travel_time_minutes, cd.fair_settings_id,
            b.batch_number, b.arrival_time, b.status AS batch_status
     FROM candidates cd
     LEFT JOIN fair_batches b ON b.id = cd.batch_id
     WHERE cd.token_no = $1 AND cd.deleted_at IS NULL`,
    [req.params.token]
  );
  if (!candRes.rows.length) return res.status(404).json({ error: 'Schedule not found' });
  const cand = candRes.rows[0];

  // company_roster_plan.md: seats/interview_minutes/floor_number/is_open now
  // come from this candidate's own fair cycle's roster row, not the
  // company's (now-legacy) columns — the candidate's own fair_settings_id
  // (set at registration) is the right key here, not "whichever fair is
  // active now": this page still has to render correctly for a candidate
  // whose own fair has since ended (e.g. the post-fair exit-QR screen).
  const slotsRes = await pool.query(
    `SELECT s.slot_start AS time, c.company_name AS company, c.location, r.floor_number, ccs.status,
            ccs.company_id, ccs.serial, r.seats, r.interview_minutes, ccs.interview_started_at, r.is_open
     FROM candidate_company_status ccs
     JOIN companies c ON c.id = ccs.company_id
     LEFT JOIN fair_company_roster r ON r.company_id = c.id AND r.fair_settings_id = $2
     LEFT JOIN interview_slots s ON s.id = ccs.slot_id
     WHERE ccs.candidate_id = $1 AND ccs.deleted_at IS NULL
     ORDER BY s.slot_start ASC NULLS LAST`,
    [cand.id, cand.fair_settings_id]
  );

  // Queue-system Phase 4: position/eta_minutes/rung only apply to serial-based
  // (new-model) bookings — waitlisted entries (serial IS NULL) are left as-is
  // so the frontend can render a distinct waitlisted card.
  const slots = await Promise.all(slotsRes.rows.map(async (row) => {
    const base = { time: row.time, company: row.company, company_id: row.company_id, location: row.location, floor_number: row.floor_number, status: row.status, is_open: row.is_open };
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

  const feedbackRes = await pool.query('SELECT 1 FROM candidate_feedback WHERE candidate_id = $1', [cand.id]);
  const roomsRes = await pool.query('SELECT floor_number, location FROM waiting_rooms ORDER BY floor_number');

  res.json({
    name: cand.name,
    token: cand.token_no,
    // Every configured waiting room, not just one — the client picks whichever
    // floor matches its most-urgent booking's company (each `slot.floor_number`
    // above is that company's floor), since "the" waiting room isn't a single
    // fair-wide place anymore (see db/schema.sql's waiting_rooms comment).
    waiting_rooms: roomsRes.rows,
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
    feedback_submitted: feedbackRes.rows.length > 0,
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
