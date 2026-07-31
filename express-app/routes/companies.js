const express = require('express');
const pool = require('../db');
const asyncHandler = require('../asyncHandler');
const { authenticateJWT } = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const requireCompanyScope = require('../middleware/requireCompanyScope');
const { resolveCenterFilter } = require('../lib/centerScope');
const { invalidateReportsCache } = require('../lib/reportsCache');

const router = express.Router();

// Standard Company HR evaluation rubric — seeded onto every new company at
// creation time so HR always has a rating form to score against instead of
// an empty one; admin can still add/remove parameters afterward via the
// rating-parameters endpoints below.
const DEFAULT_RATING_PARAMETERS = [
  'Communication',
  'Technical Skills',
  'Adaptability',
  'Confidence Level',
  'Behavior & Personality',
];

// Staff (any role): list companies with open-slot counts, for tiles and admin
// list. The public tile view arrives in stage 4 as GET /qr/companies.
// centerId (fair_cycle_isolation_plan.md Phase 4): admin optionally narrows
// via ?center_id=; every other role is pinned to its own center (a company
// belongs to exactly one center permanently, so this also naturally narrows
// the Desk tab's company picker for floor_manager/registration_staff/
// volunteer, and still includes company_hr's own company either way).
// company_roster_plan.md: seats/interview_minutes/floor_number/is_open now
// come from the roster row for a specific fair cycle, not the company's
// (now-legacy) own columns — an optional ?fair_settings_id= picks a specific
// cycle (Phase 3's roster UI, or a historical look-back), defaulting to
// "whichever fair is active for this company's own Center" otherwise. A
// company with no roster row for the resolved fair (not part of that cycle)
// reports null for those four fields — a real, distinct state from "1 seat."
router.get('/companies', authenticateJWT, asyncHandler(async (req, res) => {
  const centerId = resolveCenterFilter(req);
  const fairSettingsId = req.query.fair_settings_id ? Number(req.query.fair_settings_id) : null;
  const result = await pool.query(`
    SELECT
      c.id, c.company_name, c.description, c.location, c.field, c.job_type,
      c.min_qualification, c.max_qualification, c.max_queue_limit, c.center_id,
      r.seats, r.interview_minutes, r.floor_number, r.is_open, r.fair_settings_id AS roster_fair_settings_id,
      COUNT(s.id) FILTER (WHERE s.id IS NOT NULL) AS total_slots,
      COUNT(s.id) FILTER (
        WHERE s.id IS NOT NULL
          AND (SELECT COUNT(*) FROM candidate_company_status ccs
               WHERE ccs.slot_id = s.id AND ccs.deleted_at IS NULL) < s.capacity
      ) AS open_slots
    FROM companies c
    LEFT JOIN fair_settings fs ON fs.center_id = c.center_id
      AND (($2::int IS NULL AND fs.is_active = true) OR fs.id = $2::int)
    LEFT JOIN fair_company_roster r ON r.company_id = c.id AND r.fair_settings_id = fs.id
    LEFT JOIN interview_slots s ON s.company_id = c.id
    WHERE ($1::int IS NULL OR c.center_id = $1)
    GROUP BY c.id, r.seats, r.interview_minutes, r.floor_number, r.is_open, r.fair_settings_id
    ORDER BY c.company_name
  `, [centerId || null, fairSettingsId]);
  res.json(result.rows);
}));

router.get('/companies/:id', authenticateJWT, asyncHandler(async (req, res) => {
  const fairSettingsId = req.query.fair_settings_id ? Number(req.query.fair_settings_id) : null;
  const companyRes = await pool.query(`
    SELECT c.id, c.company_name, c.description, c.location, c.field, c.job_type,
           c.min_qualification, c.max_qualification, c.max_queue_limit, c.center_id, c.created_at,
           r.seats, r.interview_minutes, r.floor_number, r.is_open, r.fair_settings_id AS roster_fair_settings_id
    FROM companies c
    LEFT JOIN fair_settings fs ON fs.center_id = c.center_id
      AND (($2::int IS NULL AND fs.is_active = true) OR fs.id = $2::int)
    LEFT JOIN fair_company_roster r ON r.company_id = c.id AND r.fair_settings_id = fs.id
    WHERE c.id = $1
  `, [req.params.id, fairSettingsId]);
  if (!companyRes.rows.length) return res.status(404).json({ error: 'Company not found' });

  const paramsRes = await pool.query(
    'SELECT id, parameter_name, display_order FROM rating_parameters WHERE company_id = $1 ORDER BY display_order',
    [req.params.id]
  );
  const slotsRes = await pool.query(
    `SELECT s.id, s.slot_start, s.duration_minutes, s.capacity,
            (SELECT COUNT(*) FROM candidate_company_status ccs
             WHERE ccs.slot_id = s.id AND ccs.deleted_at IS NULL)::int AS taken
     FROM interview_slots s WHERE s.company_id = $1 ORDER BY s.slot_start`,
    [req.params.id]
  );
  const postsRes = await pool.query(
    'SELECT * FROM company_posts WHERE company_id = $1 ORDER BY id',
    [req.params.id]
  );

  res.json({ ...companyRes.rows[0], rating_parameters: paramsRes.rows, slots: slotsRes.rows, posts: postsRes.rows });
}));

// Shared by the single-create route and the bulk-import route below. Runs
// entirely on the caller's `client` inside whatever transaction the caller
// opened — a single row's failure inside a bulk import must only roll back
// that row's own transaction, not every row already committed before it.
// Throws on validation/DB failure; callers translate that into a per-row (or
// single) HTTP error the same way, via companyInsertError() below.
async function insertCompanyRow(client, { company_name, description, location, floor_number, field, job_type, min_qualification, max_qualification, max_queue_limit, seats, interview_minutes, center_id }) {
  if (!company_name) { const e = new Error('company_name is required'); e.httpStatus = 400; throw e; }
  // Red-team L3: interview_minutes feeds `60 / interview_minutes` in the
  // booking-cap math (registerCandidate.js) — 0 or negative breaks that
  // divisor (Infinity/NaN, or a negative cap that silently waitlists
  // everyone). The DB CHECK constraint is the hard backstop; this just gives
  // a clean 400 instead of a raw constraint-violation error.
  if (interview_minutes != null && !(Number.isInteger(interview_minutes) && interview_minutes > 0)) {
    const e = new Error('interview_minutes must be a positive integer'); e.httpStatus = 400; throw e;
  }
  // Ground floor is 0, not 1 — reject negatives before they hit the DB
  // CHECK constraint. `floor_number || null` below would silently turn a
  // valid 0 into null (0 is falsy), so this uses an explicit null check.
  if (floor_number != null && !(Number.isInteger(floor_number) && floor_number >= 0)) {
    const e = new Error('floor_number must be a non-negative integer'); e.httpStatus = 400; throw e;
  }

  // center_id defaults to the sole seeded Center — fair_cycle_isolation_
  // plan.md Phase 0 (a company is tied to exactly one Center permanently).
  const result = await client.query(
    `INSERT INTO companies (company_name, description, location, field, job_type, min_qualification, max_qualification, max_queue_limit, center_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, 7), COALESCE($9, (SELECT id FROM centers ORDER BY id LIMIT 1))) RETURNING *`,
    [company_name, description || null, location || null, field || null, job_type || null, min_qualification || null, max_qualification || null, max_queue_limit || null, center_id || null]
  );
  const company = result.rows[0];

  // One multi-row INSERT instead of 5 round trips — same DEFAULT_RATING_
  // PARAMETERS list, just written in a single statement.
  const values = DEFAULT_RATING_PARAMETERS.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(', ');
  const params = DEFAULT_RATING_PARAMETERS.flatMap((name, i) => [name, i]);
  await client.query(
    `INSERT INTO rating_parameters (company_id, parameter_name, display_order) VALUES ${values}`,
    [company.id, ...params]
  );

  // company_roster_plan.md: seats/interview_minutes/floor_number still
  // accepted as optional convenience params on create — if this Center has
  // an active fair right now, this inserts the company's first roster row
  // in the same transaction, so first-time entry stays a single form
  // submit instead of a separate "now add it to today's roster" step.
  // is_open stays false regardless (a brand-new company always needs an
  // explicit open, same default the legacy column always had).
  const fairRes = await client.query('SELECT id FROM fair_settings WHERE center_id = $1 AND is_active = true', [company.center_id]);
  if (fairRes.rows.length) {
    await client.query(
      `INSERT INTO fair_company_roster (fair_settings_id, company_id, seats, interview_minutes, floor_number, is_open)
       VALUES ($1, $2, COALESCE($3, 1), COALESCE($4, 6), $5, false)`,
      [fairRes.rows[0].id, company.id, seats || null, interview_minutes || null, floor_number != null ? floor_number : null]
    );
  }

  return company;
}

// Translates insertCompanyRow()'s thrown errors (validation, or a raw PG
// error) into a { status, error } pair — same mapping the single-create
// route always did inline, now shared with the bulk route so a bad row in a
// large import reports the same reason a single bad create would.
function companyInsertError(err) {
  if (err.httpStatus) return { status: err.httpStatus, error: err.message };
  if (err.code === '23505') return { status: 409, error: 'A company with that name already exists at this center' };
  if (err.code === '23514' && err.constraint === 'companies_floor_number_nonnegative') {
    return { status: 400, error: 'floor_number must be a non-negative integer' };
  }
  if (err.code === '23514') return { status: 400, error: 'interview_minutes must be a positive integer' };
  return null; // not a recognized create-time failure — rethrow as a real 500
}

// Admin: create a company. seats/interview_minutes feed the queue-system
// booking-cap gate (new_architecture.md §4: capacity_j = seats *
// (60/interview_minutes) * fair_hours) — default to 1 seat / 6-min
// interviews (sim's baseline) so an unconfigured company still gets a
// sane, non-zero cap instead of silently waitlisting everyone.
router.post('/companies', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const company = await insertCompanyRow(client, req.body);
    await client.query('COMMIT');
    res.status(201).json(company);
  } catch (err) {
    await client.query('ROLLBACK');
    const mapped = companyInsertError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.error });
    throw err;
  } finally {
    client.release();
  }
}));

// Admin: bulk-import companies — CompanyManagement.jsx's CSV upload. One
// connection, but each row gets its own transaction (via insertCompanyRow),
// so a bad row (duplicate name, bad interview_minutes) fails just that row
// instead of aborting the whole batch — the natural behavior for "I pasted a
// spreadsheet and one row has a typo," not an all-or-nothing import. Row
// order in the response mirrors the request so the caller can map failures
// back to the CSV line that produced them.
router.post('/companies/bulk', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'rows must be a non-empty array' });
  }
  if (rows.length > 500) {
    return res.status(400).json({ error: 'Import is limited to 500 rows at a time' });
  }

  const client = await pool.connect();
  const created = [];
  const failed = [];
  try {
    for (let i = 0; i < rows.length; i++) {
      try {
        await client.query('BEGIN');
        const company = await insertCompanyRow(client, rows[i]);
        await client.query('COMMIT');
        created.push(company);
      } catch (err) {
        await client.query('ROLLBACK');
        const mapped = companyInsertError(err);
        if (!mapped) throw err; // an unrecognized failure aborts the whole import, same as any other 500 would
        failed.push({ row: i + 1, company_name: rows[i]?.company_name || null, error: mapped.error });
      }
    }
    res.status(207).json({ created, failed });
  } finally {
    client.release();
  }
}));

// Admin: edit a company's own fields — the create form (POST /companies)
// was the only way to set these; nothing let you fix a typo'd location or
// add a floor number after the fact. Same partial-update (COALESCE) shape
// as the postings PUT below. company_roster_plan.md: this is now directory-
// fields-only — seats/interview_minutes/floor_number/is_open moved to the
// per-cycle roster (PUT/POST /fair-settings/:id/roster[/:companyId] in
// routes/fair.js); a request that still sends those four is silently
// ignored rather than erroring, since the Companies tab's edit form hasn't
// been split yet (company_roster_plan.md's deferred UI phase) and shouldn't
// break in the meantime.
router.put('/companies/:id', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { company_name, description, location, field, job_type, min_qualification, max_qualification, max_queue_limit } = req.body;

  try {
    const result = await pool.query(
      `UPDATE companies SET
         company_name = COALESCE($1, company_name),
         description = COALESCE($2, description),
         location = COALESCE($3, location),
         field = COALESCE($4, field),
         job_type = COALESCE($5, job_type),
         min_qualification = COALESCE($6, min_qualification),
         max_qualification = COALESCE($7, max_qualification),
         max_queue_limit = COALESCE($8, max_queue_limit)
       WHERE id = $9
       RETURNING *`,
      [company_name || null, description || null, location || null,
       field || null, job_type || null, min_qualification || null, max_qualification || null,
       max_queue_limit || null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Company not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A company with that name already exists at this center' });
    throw err;
  }
}));

// Admin / Company HR (own company only): the quick "is this desk actually
// running today" toggle — the thing candidates' GET /qr/companies checks.
// Separate from the general edit above so company_hr, who can't touch any
// other company field, can still flip their own without an admin in the loop.
// company_roster_plan.md: is_open now lives on the active fair's roster row,
// not the company itself — 404s clearly (instead of silently no-op-ing) if
// this company has no roster row for the Center's currently active fair.
router.put('/companies/:id/open-status', authenticateJWT, requireRole('admin', 'company_hr'), requireCompanyScope((req) => req.params.id), asyncHandler(async (req, res) => {
  const { is_open } = req.body;
  if (typeof is_open !== 'boolean') return res.status(400).json({ error: 'is_open must be a boolean' });

  const result = await pool.query(
    `UPDATE fair_company_roster r SET is_open = $1
     FROM fair_settings fs
     WHERE r.fair_settings_id = fs.id AND r.company_id = $2
       AND fs.center_id = (SELECT center_id FROM companies WHERE id = $2) AND fs.is_active = true
     RETURNING r.company_id AS id, (SELECT company_name FROM companies WHERE id = $2) AS company_name, r.is_open`,
    [is_open, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'This company is not on the current fair\'s roster' });
  res.json(result.rows[0]);
}));

const FUTURE_INTEREST_VALUES = ['Definitely Yes', 'Probably Yes', 'Maybe', 'Probably No', 'Definitely No'];

// candidate_and_desk_improvements_plan.md §D: Company HR's "Close Desk"
// button — unlike the plain instant PUT /open-status toggle above (which
// admin also uses, proxy-closing on HR's behalf), this is the path
// DeskTablet.jsx's own close action goes through: a short feedback form is
// required before is_open actually flips to false. Kept as its own route
// rather than an optional-feedback-body branch on PUT /open-status, so that
// route stays a plain simple toggle for the admin-proxy case.
// requireCompanyScope confines company_hr to its own company_id, same as
// PUT /open-status; admin may also call this directly (e.g. closing on HR's
// behalf while still capturing feedback) but the UI only wires it from
// DeskTablet.jsx.
router.post('/companies/:id/close-desk', authenticateJWT, requireRole('admin', 'company_hr'), requireCompanyScope((req) => req.params.id), asyncHandler(async (req, res) => {
  const { candidate_quality, venue_rating, app_performance_rating, volunteer_satisfaction, future_interest } = req.body;
  const ratings = { candidate_quality, venue_rating, app_performance_rating, volunteer_satisfaction };
  for (const [key, value] of Object.entries(ratings)) {
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      return res.status(400).json({ error: `${key} must be a whole number from 1 to 5` });
    }
  }
  if (!FUTURE_INTEREST_VALUES.includes(future_interest)) {
    return res.status(400).json({ error: `future_interest must be one of: ${FUTURE_INTEREST_VALUES.join(', ')}` });
  }

  const client = await pool.connect();
  let is_open;
  try {
    await client.query('BEGIN');

    const fairRes = await client.query(
      `SELECT fs.id FROM fair_settings fs
       WHERE fs.center_id = (SELECT center_id FROM companies WHERE id = $1) AND fs.is_active = true`,
      [req.params.id]
    );
    if (!fairRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No active fair for this company\'s Center' });
    }
    const fairSettingsId = fairRes.rows[0].id;

    await client.query(
      `INSERT INTO company_hr_feedback
         (company_id, fair_settings_id, candidate_quality, venue_rating, app_performance_rating, volunteer_satisfaction, future_interest)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (company_id, fair_settings_id) DO UPDATE SET
         candidate_quality = EXCLUDED.candidate_quality, venue_rating = EXCLUDED.venue_rating,
         app_performance_rating = EXCLUDED.app_performance_rating, volunteer_satisfaction = EXCLUDED.volunteer_satisfaction,
         future_interest = EXCLUDED.future_interest, submitted_at = now()`,
      [req.params.id, fairSettingsId, candidate_quality, venue_rating, app_performance_rating, volunteer_satisfaction, future_interest]
    );

    const rosterRes = await client.query(
      `UPDATE fair_company_roster SET is_open = false
       WHERE company_id = $1 AND fair_settings_id = $2
       RETURNING is_open`,
      [req.params.id, fairSettingsId]
    );
    if (!rosterRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'This company is not on the current fair\'s roster' });
    }
    is_open = rosterRes.rows[0].is_open;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // STAFF_INCONSISTENCY_REPORT.md S9: company_hr_feedback backs
  // company-hr-feedback-report, cached 20s alongside every other report
  // with no write-side invalidation.
  await invalidateReportsCache();

  res.json({ id: Number(req.params.id), is_open });
}));

// Admin: delete a company — hard delete (companies aren't fair-scoped or
// soft-deleted like candidates are). FK RESTRICT on interview_slots and
// candidate_company_status is the real guard here — Postgres raises 23001
// (restrict_violation) for those explicit ON DELETE RESTRICT columns, not
// 23503 (only users.company_id, which has no ON DELETE clause, would raise
// that) — so both codes need catching, or a company with real bookings/slots
// crashes this into a raw 500 instead of a clean 409. rating_parameters/
// company_posts are ON DELETE CASCADE, so those go with it.
router.delete('/companies/:id', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM companies WHERE id = $1 RETURNING id, company_name', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Company not found' });
    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    if (err.code === '23503' || err.code === '23001') {
      return res.status(409).json({ error: 'Cannot delete a company with existing candidates, interview slots, or assigned staff — remove those first' });
    }
    throw err;
  }
}));

// Admin: add a rating parameter
router.post('/companies/:id/rating-parameters', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { parameter_name, display_order } = req.body;
  if (!parameter_name) return res.status(400).json({ error: 'parameter_name is required' });

  const result = await pool.query(
    `INSERT INTO rating_parameters (company_id, parameter_name, display_order) VALUES ($1,$2,$3) RETURNING *`,
    [req.params.id, parameter_name, display_order || 0]
  );
  res.status(201).json(result.rows[0]);
}));

// Admin: remove a rating parameter
router.delete('/companies/:id/rating-parameters/:paramId', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await pool.query(
    'DELETE FROM rating_parameters WHERE id = $1 AND company_id = $2 RETURNING id',
    [req.params.paramId, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Rating parameter not found' });
  res.json({ ok: true, id: result.rows[0].id });
}));

// Admin: add a posting (vacancy tracking — v2.5's company_posts, see schema.sql)
router.post('/companies/:id/posts', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { post_title, vacancies, qualification, gender, age_min, age_max } = req.body;
  if (!post_title) return res.status(400).json({ error: 'post_title is required' });

  const result = await pool.query(
    `INSERT INTO company_posts (company_id, post_title, vacancies, qualification, gender, age_min, age_max)
     VALUES ($1,$2, COALESCE($3,1), $4,$5,$6,$7) RETURNING *`,
    [req.params.id, post_title, vacancies || null, qualification || null, gender || null, age_min || null, age_max || null]
  );
  res.status(201).json(result.rows[0]);
}));

// Admin: edit a posting
router.put('/companies/:id/posts/:postId', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { post_title, vacancies, qualification, gender, age_min, age_max } = req.body;

  const result = await pool.query(
    `UPDATE company_posts
     SET post_title = COALESCE($1, post_title),
         vacancies = COALESCE($2, vacancies),
         qualification = COALESCE($3, qualification),
         gender = COALESCE($4, gender),
         age_min = COALESCE($5, age_min),
         age_max = COALESCE($6, age_max)
     WHERE id = $7 AND company_id = $8
     RETURNING *`,
    [post_title || null, vacancies || null, qualification || null, gender || null, age_min || null, age_max || null, req.params.postId, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Posting not found' });
  res.json(result.rows[0]);
}));

// Admin: remove a posting
router.delete('/companies/:id/posts/:postId', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await pool.query(
    'DELETE FROM company_posts WHERE id = $1 AND company_id = $2 RETURNING id',
    [req.params.postId, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Posting not found' });
  res.json({ ok: true, id: result.rows[0].id });
}));

// Admin: add a slot
router.post('/companies/:id/slots', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { slot_start, duration_minutes, capacity } = req.body;
  if (!slot_start) return res.status(400).json({ error: 'slot_start is required' });

  const result = await pool.query(
    `INSERT INTO interview_slots (company_id, slot_start, duration_minutes, capacity) VALUES ($1,$2, COALESCE($3,15), COALESCE($4,1)) RETURNING *`,
    [req.params.id, slot_start, duration_minutes || null, capacity || null]
  );
  res.status(201).json(result.rows[0]);
}));

module.exports = router;
