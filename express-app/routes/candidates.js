const express = require('express');
const path = require('path');
const pool = require('../db');
const asyncHandler = require('../asyncHandler');
const { authenticateJWT } = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const requireCompanyScope = require('../middleware/requireCompanyScope');
const registerCandidate = require('../lib/registerCandidate');
const { verifyQr } = require('../lib/checkinSig');
const queueStore = require('../lib/queueStore');
const { emit } = require('../lib/events');
const { RESUME_DIR } = require('../lib/resumeStorage');
const { assignCompanies } = require('../lib/companyAssignment');
const { resolveCenterFilter } = require('../lib/centerScope');
const { normalizeMobile } = require('../lib/mobile');
const { DONE_STATUSES } = require('../lib/pingLadder');

const router = express.Router();

// Manual registration (Admin / Registration Staff, per permission matrix) —
// exception path for QR failures (flow D). Same transaction as the public
// path: lib/registerCandidate.js.
// centerId (fair_cycle_isolation_plan.md Phase 5 follow-up): registration_
// staff is pinned to their own Center regardless of the request body; admin
// may pass one explicitly (mirrors every other admin-only create — Companies/
// Users/fair-settings all work the same way), and is required to when more
// than one Center currently has an active fair, since registerCandidate()'s
// "which fair" lookup would otherwise be genuinely ambiguous, not just
// defaulting sensibly.
router.post('/register', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (req, res) => {
  let centerId = req.user.role === 'admin' ? (req.body.center_id ? Number(req.body.center_id) : null) : req.user.center_id;
  if (centerId == null) {
    const activeCount = await pool.query('SELECT COUNT(*)::int AS n FROM fair_settings WHERE is_active = true');
    if (activeCount.rows[0].n > 1) {
      return res.status(400).json({ error: 'Multiple centers have an active fair — center_id is required' });
    }
  }
  const result = await registerCandidate({ ...req.body, centerId });
  res.status(result.status).json(result.body);
}));

// Staff (any role): candidate directory — feeds the Candidate tab's list
// (filtered client-side by name/token) and FloorMonitor's batch roster
// (grouped client-side by batch_id). Optional ?date= (added alongside
// FloorMonitor's Day dropdown) scopes to one registration day — filtered in
// SQL via registered_at::date rather than client-side ISO-string slicing, so
// it agrees with lib/floorStats.js/lib/insights.js's day grouping instead of
// drifting a day near midnight IST the way a UTC ISO-string slice would.
// Omitted entirely for every other caller, so their behavior is unchanged.
// centerId (fair_cycle_isolation_plan.md Phase 4): admin optionally narrows
// via ?center_id=; every other role is pinned to its own center — via
// candidates.fair_settings_id -> fair_settings.center_id, a LEFT JOIN so a
// legacy candidate with no fair_settings_id still shows up in the unscoped
// (admin, no center picked) view instead of silently vanishing.
// ?mobile= (CandidateLookup.jsx's mobile-number lookup): normalized the same
// way registration stores it, so a staff member can type the number with
// spaces/a country code and still match. Mobile dedup is per-fair-cycle now
// (not global), so this can legitimately return more than one row for the
// same person across different cycles — the caller disambiguates.
router.get('/candidates', authenticateJWT, asyncHandler(async (req, res) => {
  const centerId = resolveCenterFilter(req);
  const mobile = req.query.mobile ? normalizeMobile(req.query.mobile) : null;
  const result = await pool.query(
    `SELECT cd.id, cd.token_no, cd.name, cd.qualification, cd.checked_in_at, cd.batch_id, cd.registered_at
     FROM candidates cd
     LEFT JOIN fair_settings fs ON fs.id = cd.fair_settings_id
     WHERE cd.deleted_at IS NULL
       AND ($1::date IS NULL OR cd.registered_at::date = $1::date)
       AND ($2::int IS NULL OR fs.center_id = $2)
       AND ($3::text IS NULL OR cd.mobile = $3)
     ORDER BY cd.registered_at DESC`,
    [req.query.date || null, centerId || null, mobile]
  );
  res.json(result.rows);
}));

// Staff (any role): candidate lookup by token — Company Desk search, volunteer
// directions. The public candidate view is GET /qr/schedule/:token (public.js).
router.get('/candidates/:token', authenticateJWT, asyncHandler(async (req, res) => {
  const candidateRes = await pool.query(
    'SELECT * FROM candidates WHERE token_no = $1 AND deleted_at IS NULL',
    [req.params.token]
  );
  if (!candidateRes.rows.length) return res.status(404).json({ error: 'Candidate not found' });
  const candidate = candidateRes.rows[0];

  // candidate_and_desk_improvements_plan.md §A: CandidateLookup.jsx's staff-
  // side add-companies picker needs the candidate's own fair cycle's
  // configured cap, not a hardcoded frontend constant.
  const capRes = candidate.fair_settings_id
    ? await pool.query('SELECT max_companies_per_candidate FROM fair_settings WHERE id = $1', [candidate.fair_settings_id])
    : { rows: [] };
  const maxCompanies = capRes.rows.length ? capRes.rows[0].max_companies_per_candidate : 3;

  const statusRes = await pool.query(
    `SELECT ccs.id, ccs.status, ccs.ratings, ccs.feedback_text, ccs.processed_at, ccs.misses,
            ccs.serial, ccs.dispatched_at, ccs.interview_started_at,
            c.id AS company_id, c.company_name, c.location, c.floor_number,
            s.slot_start
     FROM candidate_company_status ccs
     JOIN companies c ON c.id = ccs.company_id
     LEFT JOIN interview_slots s ON s.id = ccs.slot_id
     WHERE ccs.candidate_id = $1 AND ccs.deleted_at IS NULL
     ORDER BY s.slot_start ASC NULLS LAST`,
    [candidate.id]
  );

  // candidate_and_desk_improvements_plan.md §B: CandidateLookup.jsx's
  // work-experience section and the Desk's auto-resume fallback both read
  // this off the one endpoint they already call.
  const workExperienceRes = await pool.query(
    'SELECT id, company_name, years, months FROM candidate_work_experience WHERE candidate_id = $1 ORDER BY created_at',
    [candidate.id]
  );

  res.json({
    ...candidate,
    companies: statusRes.rows,
    max_companies_per_candidate: maxCompanies,
    work_experience: workExperienceRes.rows,
  });
}));

// Admin / Registration Staff: manual company reassignment — the staff-side
// override for the new one-shot candidate self-service pick (public.js's
// POST /qr/select-companies/:qr). Covers walk-ups who registered manually
// (no phone to self-serve with) and mistakes/swaps for anyone else. Only
// Pending/Waitlisted bookings are touchable — a Dispatched/in-interview or
// already-decided one is left alone (could corrupt live queue/desk state or
// erase a real recorded outcome).
router.post('/candidates/:id/companies', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (req, res) => {
  const companyIds = req.body.company_ids;
  if (!Array.isArray(companyIds) || companyIds.length === 0) {
    return res.status(400).json({ error: 'Select at least one company' });
  }

  const candRes = await pool.query('SELECT id, fair_settings_id FROM candidates WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
  if (!candRes.rows.length) return res.status(404).json({ error: 'Candidate not found' });
  const candidateId = candRes.rows[0].id;
  const fairSettingsId = candRes.rows[0].fair_settings_id;

  // company_roster_plan.md: read the candidate's own fair cycle instead of a
  // fresh "whichever fair is active" lookup — arbitrary once 2+ Centers each
  // have a live fair, and wrong outright for a candidate from an ended cycle
  // (this route has no checked_in_at requirement, so staff can use it before
  // or well after a candidate's own fair has wound down).
  // candidate_and_desk_improvements_plan.md §A: max_companies_per_candidate is
  // now per-fair-cycle (admin-configurable), not a hardcoded constant — fetched
  // alongside fair_hours since both come off the same fair_settings row.
  const fairRes = fairSettingsId
    ? await pool.query('SELECT fair_hours, max_companies_per_candidate FROM fair_settings WHERE id = $1', [fairSettingsId])
    : { rows: [] };
  const fairHours = fairRes.rows.length ? Number(fairRes.rows[0].fair_hours) : 8;
  const maxCompanies = fairRes.rows.length ? fairRes.rows[0].max_companies_per_candidate : 3;

  const currentRes = await pool.query(
    'SELECT COUNT(*)::int AS n FROM candidate_company_status WHERE candidate_id = $1 AND deleted_at IS NULL',
    [candidateId]
  );
  if (currentRes.rows[0].n + companyIds.length > maxCompanies) {
    return res.status(400).json({ error: `A candidate can have at most ${maxCompanies} companies` });
  }

  const client = await pool.connect();
  let assigned, waitlisted;
  try {
    await client.query('BEGIN');
    ({ assigned, waitlisted } = await assignCompanies(client, { candidateId, company_ids: companyIds, fairHours, fairSettingsId }));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Same post-commit ordering as registerCandidate.js/select-companies — a
  // Redis outage must never undo an already-committed booking. Deliberately
  // doesn't require checked_in_at (unlike the candidate self-service route) —
  // this is a staff override and may run before the candidate arrives.
  for (const a of assigned) {
    try {
      await queueStore.enqueue(a.company_id, candidateId, a.serial);
    } catch (err) {
      console.error(`[candidates/:id/companies] queue enqueue failed for candidate ${candidateId} company ${a.company_id}:`, err.message);
    }
  }
  if (assigned.length) {
    emit('queue_joined', {
      companies: assigned.map((a) => ({ company_id: a.company_id, company_name: a.company_name, serial: a.serial })),
      statsDelta: { queued: assigned.length },
    });
  }
  if (waitlisted.length) {
    emit('candidate_waitlisted', {
      companies: waitlisted.map((a) => ({ company_id: a.company_id, company_name: a.company_name })),
      statsDelta: { waitlisted: waitlisted.length },
    });
  }

  res.status(201).json({
    assigned: assigned.map(({ ccs_id, ...rest }) => rest),
    waitlisted: waitlisted.map(({ ccs_id, ...rest }) => rest),
  });
}));

// Admin / Registration Staff: remove one company booking for a candidate —
// the other half of the manual reassignment tool above. Only Pending/
// Waitlisted, same reasoning as the route above.
router.delete('/candidates/:id/companies/:companyId', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (req, res) => {
  const client = await pool.connect();
  let status;
  try {
    await client.query('BEGIN');
    const ccsRes = await client.query(
      `SELECT id, status FROM candidate_company_status
       WHERE candidate_id = $1 AND company_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [req.params.id, req.params.companyId]
    );
    if (!ccsRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No active booking for that candidate/company' });
    }
    status = ccsRes.rows[0].status;
    if (status !== 'Pending' && status !== 'Waitlisted') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Can only remove a company before the candidate has been called for it' });
    }
    await client.query('UPDATE candidate_company_status SET deleted_at = now() WHERE id = $1', [ccsRes.rows[0].id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Waitlisted rows were never enqueued — only a Pending one needs its Redis
  // queue entry cleared.
  if (status === 'Pending') {
    try {
      await queueStore.remove(Number(req.params.companyId), Number(req.params.id));
    } catch (err) {
      console.error(`[candidates/:id/companies delete] queue remove failed for candidate ${req.params.id} company ${req.params.companyId}:`, err.message);
    }
  }

  res.json({ ok: true });
}));

// candidate_and_desk_improvements_plan.md §B: the staff-side realization of
// "facility to add company and years/months" — appends one work-experience
// entry to a candidate who's already registered (correcting/extending what
// they gave at registration time). No soft-delete/outcome lifecycle to
// preserve here (unlike a company booking), so this is a plain insert/hard
// delete pair, same shape as the company add/remove routes above minus the
// capacity/waitlist machinery those need and this doesn't.
router.post('/candidates/:id/work-experience', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (req, res) => {
  const { company_name, years, months } = req.body;
  if (!company_name || !String(company_name).trim()) {
    return res.status(400).json({ error: 'company_name is required' });
  }
  const y = years == null || years === '' ? 0 : Number(years);
  const m = months == null || months === '' ? 0 : Number(months);
  if (!Number.isFinite(y) || y < 0) return res.status(400).json({ error: 'years must be 0 or greater' });
  if (!Number.isFinite(m) || m < 0 || m > 11) return res.status(400).json({ error: 'months must be between 0 and 11' });

  const candRes = await pool.query('SELECT id FROM candidates WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
  if (!candRes.rows.length) return res.status(404).json({ error: 'Candidate not found' });

  const result = await pool.query(
    'INSERT INTO candidate_work_experience (candidate_id, company_name, years, months) VALUES ($1,$2,$3,$4) RETURNING id, company_name, years, months',
    [req.params.id, String(company_name).trim(), y, m]
  );
  res.status(201).json(result.rows[0]);
}));

router.delete('/candidates/:id/work-experience/:entryId', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (req, res) => {
  const result = await pool.query(
    'DELETE FROM candidate_work_experience WHERE id = $1 AND candidate_id = $2 RETURNING id',
    [req.params.entryId, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Work experience entry not found' });
  res.json({ ok: true });
}));

// Admin / Registration Staff: reactivate a settled booking — CandidateLookup.jsx's
// "Reassign" button. Started as a No_Show-only override (a candidate genuinely
// showed up after all and staff need to give them another shot, rather than
// leaving them permanently locked out by workers/noShowWorker.js's 5-miss
// cutoff), then widened to cover every DONE_STATUSES outcome (Selected/
// Rejected/Hold/Shortlisted too) — a recorded result can be wrong (staff
// mistake, a result logged against the wrong candidate/company, stale test
// data), and staff need a way to put that booking back in the live queue
// without deleting and re-registering the candidate. Still 409s for anything
// NOT in DONE_STATUSES (Pending/Waitlisted/Dispatched) — those aren't settled
// yet, so "reactivate" doesn't mean anything for them; use the remove/add
// routes above instead.
router.post('/candidates/:id/companies/:companyId/reactivate', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (req, res) => {
  const candidateId = Number(req.params.id);
  const companyId = Number(req.params.companyId);

  // Same fair_hours resolution the candidate's own booking was made under —
  // prefer their own fair_settings_id over a fresh "whichever fair is active"
  // lookup (the latter is only ever a fallback, for a legacy candidate with no
  // fair_settings_id).
  const fairRes = await pool.query(
    `SELECT fs.fair_hours FROM candidates cd
      LEFT JOIN fair_settings fs ON fs.id = cd.fair_settings_id
     WHERE cd.id = $1`,
    [candidateId]
  );
  let fairHours = fairRes.rows[0]?.fair_hours;
  if (fairHours == null) {
    const fallbackRes = await pool.query(`SELECT fair_hours FROM fair_settings WHERE is_active = true ORDER BY fair_date DESC LIMIT 1`);
    fairHours = fallbackRes.rows.length ? fallbackRes.rows[0].fair_hours : 8;
  }
  fairHours = Number(fairHours);

  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [companyId]);

    const ccsRes = await client.query(
      `SELECT id, status FROM candidate_company_status
        WHERE candidate_id = $1 AND company_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [candidateId, companyId]
    );
    if (!ccsRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No active booking for that candidate/company' });
    }
    if (!DONE_STATUSES.includes(ccsRes.rows[0].status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Only a completed booking (Selected/Rejected/Hold/Shortlisted/No_Show) can be reassigned' });
    }
    const ccsId = ccsRes.rows[0].id;

    // Same capacity/waitlist gate every other booking goes through
    // (lib/companyAssignment.js) — excludes this row itself from the "already
    // booked" count, since it's about to be re-decided, not double-counted
    // against its own prior occupancy.
    const companyRes = await client.query(
      `SELECT c.seats, c.interview_minutes,
              (SELECT COUNT(*)::int FROM candidate_company_status ccs
                WHERE ccs.company_id = c.id AND ccs.status != 'Waitlisted' AND ccs.deleted_at IS NULL AND ccs.id != $2) AS booked
         FROM companies c WHERE c.id = $1`,
      [companyId, ccsId]
    );
    if (!companyRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Company not found' });
    }
    const company = companyRes.rows[0];
    const capacity = company.seats * (60 / company.interview_minutes) * fairHours;
    const capSold = Math.floor(0.9 * capacity);
    const isWaitlisted = company.booked >= capSold;
    const serial = isWaitlisted ? null : company.booked + 1;

    await client.query(
      `UPDATE candidate_company_status
          SET status = $1, serial = $2, misses = 0, dispatched_at = NULL,
              interview_started_at = NULL, processed_at = NULL, ratings = NULL, feedback_text = NULL
        WHERE id = $3`,
      [isWaitlisted ? 'Waitlisted' : 'Pending', serial, ccsId]
    );
    await client.query('COMMIT');
    result = { status: isWaitlisted ? 'Waitlisted' : 'Pending', serial };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Same post-commit ordering as every other booking mutation in this file —
  // a Redis outage must never undo an already-committed status change.
  if (result.status === 'Pending') {
    try {
      await queueStore.enqueue(companyId, candidateId, result.serial);
    } catch (err) {
      console.error(`[candidates/:id/companies/:companyId/reactivate] queue enqueue failed for candidate ${candidateId} company ${companyId}:`, err.message);
    }
    emit('queue_joined', { companies: [{ company_id: companyId, serial: result.serial }], statsDelta: { queued: 1 } });
  } else {
    emit('candidate_waitlisted', { companies: [{ company_id: companyId }], statsDelta: { waitlisted: 1 } });
  }

  res.json(result);
}));

// Admin / Floor Manager / Company HR: serve an uploaded resume — inline, not
// as a forced download, since HR needs to read it during the interview.
// Gated server-side, not just hidden in the UI: everyone (admin and
// floor_manager included, no fair-wide bypass) only sees it once this
// candidate's interview at this specific company has actually started, so
// nobody can pre-judge a candidate before meeting them. requireCompanyScope
// additionally confines a company_hr account to its own company_id.
router.get('/candidates/:token/resume', authenticateJWT, requireRole('admin', 'floor_manager', 'company_hr'), requireCompanyScope((req) => req.query.company_id), asyncHandler(async (req, res) => {
  const companyId = Number(req.query.company_id);
  if (!companyId) return res.status(400).json({ error: 'company_id is required' });

  const candRes = await pool.query(
    'SELECT id, resume_uploaded_at, resume_ext FROM candidates WHERE token_no = $1 AND deleted_at IS NULL',
    [req.params.token]
  );
  if (!candRes.rows.length) return res.status(404).json({ error: 'Candidate not found' });
  const candidate = candRes.rows[0];
  if (!candidate.resume_uploaded_at) return res.status(404).json({ error: 'No resume on file' });

  const ccsRes = await pool.query(
    `SELECT status, interview_started_at FROM candidate_company_status
      WHERE candidate_id = $1 AND company_id = $2 AND deleted_at IS NULL`,
    [candidate.id, companyId]
  );
  const ccs = ccsRes.rows[0];
  if (!ccs || ccs.status !== 'Dispatched' || !ccs.interview_started_at) {
    return res.status(403).json({ error: 'Resume is only viewable after the interview has started' });
  }

  // candidate_and_desk_improvements_plan.md §C: PDF or image now, so both the
  // on-disk extension and the Content-Type are resolved from resume_ext
  // instead of a hardcoded `.pdf` — sendFile's automatic MIME inference
  // already worked for PDF alone, but an explicit type is needed now that
  // more than one kind exists.
  const ext = candidate.resume_ext || 'pdf';
  res.type(ext === 'pdf' ? 'application/pdf' : `image/${ext === 'jpg' ? 'jpeg' : ext}`);
  res.sendFile(path.join(RESUME_DIR, `${req.params.token}.${ext}`));
}));

// Admin / Floor Manager: emergency batch reschedule (Waiting Room drag-and-drop)
// — moves which arrival wave a candidate belongs to. Queue-system Phase 6
// cutover: this used to also re-pick an interview_slots row per company and
// enqueue a v1 dispatch job (PUT /slots/:id/reassign's sibling) — that logic
// silently did nothing for anyone booked under the new count-based queue
// model, since a candidate's queue position (serial) is fixed at registration
// and has never depended on batch_id; removed rather than fixed forward, per
// handoff.md's own flag that this needed resolving before it was relied on.
// A checked-in candidate can't move (would desync fair_batches.checked_in
// from the dispatcher's checked-in guard).
router.put('/candidates/:id/batch', authenticateJWT, requireRole('admin', 'floor_manager'), asyncHandler(async (req, res) => {
  const { batch_id } = req.body;
  if (!batch_id) return res.status(400).json({ error: 'batch_id is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const candRes = await client.query(
      'SELECT id, token_no, batch_id, checked_in_at FROM candidates WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [req.params.id]
    );
    if (!candRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Candidate not found' });
    }
    const candidate = candRes.rows[0];
    if (candidate.checked_in_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `${candidate.token_no} is already checked in and can't be rescheduled` });
    }

    const batchRes = await client.query('SELECT * FROM fair_batches WHERE id = $1 FOR UPDATE', [batch_id]);
    if (!batchRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Target batch not found' });
    }
    const batch = batchRes.rows[0];
    if (batch.status === 'closed') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Batch ${batch.batch_number} is closed` });
    }

    if (candidate.batch_id === batch.id) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, candidate_id: candidate.id, token_no: candidate.token_no, batch_id: batch.id });
    }

    const occRes = await client.query(
      'SELECT COUNT(*)::int AS n FROM candidates WHERE batch_id = $1 AND deleted_at IS NULL',
      [batch.id]
    );
    if (occRes.rows[0].n >= batch.capacity) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Batch ${batch.batch_number} is full` });
    }

    await client.query('UPDATE candidates SET batch_id = $1 WHERE id = $2', [batch.id, candidate.id]);
    await client.query('COMMIT');

    res.json({ ok: true, candidate_id: candidate.id, token_no: candidate.token_no, batch_id: batch.id });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Admin / Registration Staff: gate exit-scan — candidate hands back their
// token on the way out (done with all interviews, or leaving early/voluntarily).
// Same QR the schedule page shows for entrance check-in (checkinSig.verifyQr),
// scanned in "Exit" mode on the same GateCheckIn screen. Unlike check-in this
// isn't batch-scoped — it ends the candidate's whole session: soft-deleted
// (same convention as DELETE /candidates/:id, so every deleted_at IS NULL read —
// GET /qr/schedule/:token, check-in, candidate lookup — treats the token as
// dead from this point on) and pulled off any company queues they were still
// waiting in, so a photographed/reused QR can't jump a queue after the
// candidate has physically left.
router.post('/candidates/exit', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (req, res) => {
  const { qr, candidate_token } = req.body;

  let tokenNo;
  if (qr !== undefined) {
    tokenNo = verifyQr(qr);
    if (!tokenNo) return res.status(400).json({ error: 'Invalid or forged check-in QR' });
  } else if (candidate_token) {
    tokenNo = candidate_token;
  } else {
    return res.status(400).json({ error: 'qr or candidate_token is required' });
  }

  const client = await pool.connect();
  let candidate;
  let companyIds;
  try {
    await client.query('BEGIN');

    const candRes = await client.query(
      'SELECT id, token_no, name FROM candidates WHERE token_no = $1 AND deleted_at IS NULL FOR UPDATE',
      [tokenNo]
    );
    if (!candRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Candidate not found or already exited' });
    }
    candidate = candRes.rows[0];

    const ccsRes = await client.query(
      'SELECT company_id FROM candidate_company_status WHERE candidate_id = $1 AND deleted_at IS NULL',
      [candidate.id]
    );
    companyIds = ccsRes.rows.map((r) => r.company_id);

    await client.query('UPDATE candidates SET deleted_at = now() WHERE id = $1', [candidate.id]);
    await client.query(
      'UPDATE candidate_company_status SET deleted_at = now() WHERE candidate_id = $1 AND deleted_at IS NULL',
      [candidate.id]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Redis cleanup after commit — same reasoning as registerCandidate.js's
  // post-commit enqueue: a Redis outage must never undo an already-committed
  // exit. Release the desk lock too, in case they're mid-interview and
  // choose to leave early.
  for (const companyId of companyIds) {
    try {
      await queueStore.remove(companyId, candidate.id);
    } catch (err) {
      console.error(`[candidates/exit] queue remove failed for candidate ${candidate.id} company ${companyId}:`, err.message);
    }
  }
  try {
    await queueStore.releaseLock(candidate.id);
  } catch (err) {
    console.error(`[candidates/exit] lock release failed for candidate ${candidate.id}:`, err.message);
  }

  emit('candidate_exited', { token: candidate.token_no, name: candidate.name, statsDelta: { exited: 1 } });

  res.json({ ok: true, token: candidate.token_no, name: candidate.name });
}));

// Admin / Reg Staff: delete a candidate — integrity fix #10: while a fair is
// live (fair_settings.is_active) only soft-delete; hard delete is post-fair cleanup.
router.delete('/candidates/:id', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (req, res) => {
  const fairActive = await pool.query('SELECT 1 FROM fair_settings WHERE is_active = true LIMIT 1');

  if (fairActive.rows.length) {
    const result = await pool.query(
      'UPDATE candidates SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Candidate not found' });
    await pool.query(
      'UPDATE candidate_company_status SET deleted_at = now() WHERE candidate_id = $1 AND deleted_at IS NULL',
      [req.params.id]
    );
    return res.json({ deleted: 'soft', id: result.rows[0].id });
  }

  // No live fair — hard delete permitted (FKs are RESTRICT, so clear ccs rows first)
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM candidate_company_status WHERE candidate_id = $1', [req.params.id]);
    const result = await client.query('DELETE FROM candidates WHERE id = $1 RETURNING id', [req.params.id]);
    await client.query('COMMIT');
    if (!result.rows.length) return res.status(404).json({ error: 'Candidate not found' });
    res.json({ deleted: 'hard', id: result.rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
