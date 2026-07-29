const express = require('express');
const pool = require('../db');
const asyncHandler = require('../asyncHandler');
const { authenticateJWT } = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const store = require('../lib/queueStore');
const { clearNoShowTimer } = require('../lib/noShowTimer');
const dispatcher = require('../lib/queueDispatcher');
const { resolveCenterFilter } = require('../lib/centerScope');
const redisCache = require('../middleware/redisCache');
const redis = require('../lib/redisClient');

const router = express.Router();

// Fair configuration + arrival-wave generation (Admin setup, Phase 1).
// Batch check-in and status transitions belong to stage 3's batches.js.

// Read-only: also needed by Registration Staff's "Generate batch" control on
// the Gate tab (reads the active fair's date/interval) — write endpoints
// below stay admin-only.
// fair_date is cast to text here (rather than left as the raw DATE column) —
// node-pg parses DATE into a JS Date via `new Date(y,m,d)` in the server
// process's local time, and JSON serializing that calls .toISOString() (UTC);
// on a server running ahead of UTC that round trip silently shifts the date
// back a day (same pitfall lib/insights.js's available_dates works around).
// Nothing in the frontend currently reads fair_date from this response raw
// (the one place that used to, GateCheckIn.jsx's old "Generate batch"
// button, was removed — see lib/batchAssignment.js), so this is a pure fix,
// not a contract change.
// candidate_count (fair_cycle_isolation_plan.md Phase 3): how many candidates
// are still tied to this fair via fair_settings_id — is what the Floor tab's
// "Past fairs" archive list needs to show before someone taps Archive on an
// ended one. A LEFT JOIN + GROUP BY, not a per-row subquery, so this stays
// one round trip regardless of how many fair_settings rows exist.
// centerId (fair_cycle_isolation_plan.md Phase 4): admin optionally narrows
// via ?center_id=; registration_staff is unconditionally pinned to their own
// center (resolveCenterFilter), same as every other non-admin role.
router.get('/fair-settings', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (req, res) => {
  const centerId = resolveCenterFilter(req);
  const result = await pool.query(
    `SELECT fs.id, fs.fair_name, to_char(fs.fair_date, 'YYYY-MM-DD') AS fair_date, fs.center_id, fs.max_companies_per_candidate,
            fs.slot_duration_minutes, fs.batch_size, fs.batch_interval_minutes, fs.is_active, fs.created_at, fs.fair_hours,
            COUNT(c.id)::int AS candidate_count
     FROM fair_settings fs
     LEFT JOIN candidates c ON c.fair_settings_id = fs.id
     WHERE ($1::int IS NULL OR fs.center_id = $1)
     GROUP BY fs.id
     ORDER BY fs.fair_date DESC`,
    [centerId || null]
  );
  res.json(result.rows);
}));

router.post('/fair-settings', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { fair_name, fair_date, center_id, max_companies_per_candidate, slot_duration_minutes, batch_size, batch_interval_minutes, is_active } = req.body;
  if (!fair_name || !fair_date) return res.status(400).json({ error: 'fair_name and fair_date are required' });

  try {
    // center_id defaults to the sole seeded Center — fair_cycle_isolation_
    // plan.md Phase 0. Optional body param accepted now for forward-compat
    // with Phase 4's actual center picker; nothing sends it yet.
    const result = await pool.query(
      `INSERT INTO fair_settings (fair_name, fair_date, center_id, max_companies_per_candidate, slot_duration_minutes, batch_size, batch_interval_minutes, is_active)
       VALUES ($1,$2, COALESCE($3, (SELECT id FROM centers ORDER BY id LIMIT 1)), COALESCE($4,3), COALESCE($5,15), COALESCE($6,25), COALESCE($7,15), COALESCE($8,false)) RETURNING *`,
      [fair_name, fair_date, center_id || null, max_companies_per_candidate || null, slot_duration_minutes || null, batch_size || null, batch_interval_minutes || null, is_active === undefined ? null : is_active]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'uq_fair_settings_one_active_per_center') {
      return res.status(409).json({ error: 'Another fair is already active for this center — end it first' });
    }
    if (err.code === '23505') return res.status(409).json({ error: 'A fair already exists for that center and date' });
    throw err;
  }
}));

// Admin: the Gate tab's "Start job fair" date picker — one call instead of
// staff having to create-then-activate (and hit uq_fair_settings_one_active_
// per_center themselves if another fair was still active for this center).
// Deactivates whatever's
// currently active, then upserts the target date active — reactivating an
// already-configured past date keeps its existing batch_size/etc rather than
// resetting them, since only fair_name/is_active are ever touched here.
router.post('/fair-settings/activate', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { fair_date, fair_name, center_id } = req.body;
  if (!fair_date) return res.status(400).json({ error: 'fair_date is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // center_id defaults to the sole seeded Center (fair_cycle_isolation_
    // plan.md Phase 0 — Phase 4 replaces this with a real picker). Resolved
    // once up front so the deactivate-step below only touches *this*
    // center's other active fair, not every center's.
    const centerRes = await client.query(
      'SELECT COALESCE($1::int, (SELECT id FROM centers ORDER BY id LIMIT 1)) AS id',
      [center_id || null]
    );
    const resolvedCenterId = centerRes.rows[0].id;
    await client.query(
      `UPDATE fair_settings SET is_active = false WHERE is_active = true AND center_id = $1 AND fair_date != $2`,
      [resolvedCenterId, fair_date]
    );
    const result = await client.query(
      `INSERT INTO fair_settings (fair_name, fair_date, center_id, is_active)
       VALUES (COALESCE($2, 'SDC Job Fair'), $1, $3, true)
       ON CONFLICT (center_id, fair_date) DO UPDATE SET is_active = true, fair_name = COALESCE($2, fair_settings.fair_name)
       RETURNING id, fair_name, to_char(fair_date, 'YYYY-MM-DD') AS fair_date, center_id, max_companies_per_candidate,
                 slot_duration_minutes, batch_size, batch_interval_minutes, is_active, created_at, fair_hours`,
      [fair_date, fair_name || null, resolvedCenterId]
    );
    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Partial update — also how the is_active soft-delete guard is toggled
router.put('/fair-settings/:id', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { fair_name, max_companies_per_candidate, slot_duration_minutes, batch_size, batch_interval_minutes, is_active } = req.body;

  const result = await pool.query(
    `UPDATE fair_settings SET
       fair_name = COALESCE($1, fair_name),
       max_companies_per_candidate = COALESCE($2, max_companies_per_candidate),
       slot_duration_minutes = COALESCE($3, slot_duration_minutes),
       batch_size = COALESCE($4, batch_size),
       batch_interval_minutes = COALESCE($5, batch_interval_minutes),
       is_active = COALESCE($6, is_active)
     WHERE id = $7
     RETURNING *`,
    [fair_name || null, max_companies_per_candidate || null, slot_duration_minutes || null, batch_size || null, batch_interval_minutes || null, is_active === undefined ? null : is_active, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Fair settings not found' });
  res.json(result.rows[0]);
}));

// fair_cycle_isolation_plan.md Phase 3 — the bulk end-of-cycle cleanup that
// was missing entirely: previously the only way to clear out a finished
// cycle's candidates was DELETE /candidates/:id, one at a time. This closes
// the actual practical consequence of Phase 2's fix (a mobile number is only
// really "free for the next cycle" once the row occupying this cycle's slot
// in idx_candidates_mobile is gone) — admin-only, and only for a fair that's
// already been ended (is_active=false), so a live cycle's data can never be
// wiped out by mistake.
//
// Hard delete, not a soft archive to a separate table — matches this app's
// existing precedent (DELETE /candidates/:id already hard-deletes once no
// fair is active) rather than introducing a new archival concept nothing
// else in the schema has.
//
// Redis cleanup runs post-commit, same "a Redis outage never blocks a DB
// commit" convention lib/registerCandidate.js's enqueue already follows —
// mirrors the exact release/remove/clear-timer/backfill sequence routes/
// queue.js's manual no-show handler uses, just looped over every live
// booking this cycle's candidates still held (there normally shouldn't be
// any, for an ended fair, but nothing enforces that staff actually resolved
// every interview before ending it).
router.post('/fair-settings/:id/archive', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const fairId = Number(req.params.id);
  if (!Number.isInteger(fairId)) return res.status(400).json({ error: 'Invalid fair id' });

  const fairRes = await pool.query('SELECT id, fair_name, is_active FROM fair_settings WHERE id = $1', [fairId]);
  if (!fairRes.rows.length) return res.status(404).json({ error: 'Fair not found' });
  if (fairRes.rows[0].is_active) {
    return res.status(409).json({ error: 'End this job fair before archiving it' });
  }

  const client = await pool.connect();
  let candIds = [];
  let liveBookings = [];
  try {
    await client.query('BEGIN');
    const candRes = await client.query('SELECT id FROM candidates WHERE fair_settings_id = $1', [fairId]);
    candIds = candRes.rows.map((r) => r.id);

    if (candIds.length) {
      // Captured before the cascade delete below removes the rows this
      // needs to know which Redis queues/locks to clean up afterward.
      const liveRes = await client.query(
        `SELECT candidate_id, company_id, status FROM candidate_company_status
         WHERE candidate_id = ANY($1::int[]) AND status IN ('Pending', 'Dispatched')`,
        [candIds]
      );
      liveBookings = liveRes.rows;

      await client.query('DELETE FROM candidate_company_status WHERE candidate_id = ANY($1::int[])', [candIds]);
      await client.query('DELETE FROM candidates WHERE id = ANY($1::int[])', [candIds]);
    }

    // Arrival-wave rows have no reporting value once a cycle ends (unlike
    // candidates/bookings) — left behind otherwise, they'd pile up forever on
    // the Gate tab's batch list with nothing to ever clean them up. Safe to
    // run after the candidates delete above: candidates.batch_id is the only
    // FK into this table (ON DELETE RESTRICT), and none reference this fair's
    // batches anymore by this point.
    await client.query('DELETE FROM fair_batches WHERE fair_settings_id = $1', [fairId]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  for (const row of liveBookings) {
    try {
      const deskId = row.status === 'Dispatched' ? await store.getLockDesk(row.candidate_id) : null;
      await store.releaseLock(row.candidate_id);
      await store.remove(row.company_id, row.candidate_id);
      await clearNoShowTimer(row.candidate_id, row.company_id);
      if (deskId) await dispatcher.dispatch(row.company_id, deskId); // don't leave the desk idle
    } catch (err) {
      console.error(`[archive] Redis cleanup failed for candidate ${row.candidate_id} / company ${row.company_id}:`, err.message);
    }
  }

  res.json({ archived: candIds.length, fair_settings_id: fairId, fair_name: fairRes.rows[0].fair_name });
}));

// Admin: remove a fair_settings row entirely — the Settings → Fair tab's
// "All fairs" list, for a fair created by mistake or an old cycle nobody
// needs to keep around once it's fully wound down. Same is_active guard as
// /archive above (never delete a live cycle), plus a candidate_count guard —
// if candidates are still tied to this fair, archive it first (POST
// /fair-settings/:id/archive already exists specifically to purge those
// safely, including the Redis cleanup a bare DELETE here has no business
// doing); this route only ever removes fair_settings + its now-empty
// fair_batches rows, never candidate data itself.
router.delete('/fair-settings/:id', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const fairId = Number(req.params.id);
  if (!Number.isInteger(fairId)) return res.status(400).json({ error: 'Invalid fair id' });

  const fairRes = await pool.query('SELECT id, fair_name, is_active FROM fair_settings WHERE id = $1', [fairId]);
  if (!fairRes.rows.length) return res.status(404).json({ error: 'Fair not found' });
  if (fairRes.rows[0].is_active) {
    return res.status(409).json({ error: 'End this job fair before deleting it' });
  }

  const candRes = await pool.query('SELECT COUNT(*)::int AS n FROM candidates WHERE fair_settings_id = $1', [fairId]);
  if (candRes.rows[0].n > 0) {
    return res.status(409).json({ error: 'Archive this fair (purge its candidates) before deleting it' });
  }

  await pool.query('DELETE FROM fair_batches WHERE fair_settings_id = $1', [fairId]);
  await pool.query('DELETE FROM fair_settings WHERE id = $1', [fairId]);
  res.json({ ok: true, fair_settings_id: fairId, fair_name: fairRes.rows[0].fair_name });
}));

// Waiting rooms, one per floor — matched against companies.floor_number so a
// candidate waiting for a Floor 2 company is told to sit in the Floor 2
// waiting room, not a fair-wide generic one (superseded fair_settings.
// waiting_room_location/floor_number the same day it shipped, see schema.sql).
// Read is public (GateBoard.jsx + every candidate's LivePosition.jsx need the
// full list to pick the right one); writes are admin-only, from the Gate tab.
// Still fair-wide (not center-filtered) — candidates have no resolvable
// center yet (that's Phase 1: candidates.fair_settings_id), so this returns
// every center's rooms. Harmless while only one Center exists; Phase 4 scopes
// this once a candidate's own fair/center is known.
// Cached 60s (same TTL/convention as GET /qr/companies) — identical output
// for every reader (GateBoard's 10s poll, every candidate's schedule poll).
// The POST/DELETE below actively bust this key (WAITING_ROOMS_CACHE_KEY) on
// write — unlike this app's other caches, this one's writer and reader are
// often the same admin, in the same Gate-tab session, seconds apart (e.g.
// setting up floors right before a fair starts); a same-tab 60s-stale "no
// rooms configured yet" right after adding one reads as a bug, not eventual
// consistency, so it's worth the extra `redis.del()` here specifically.
const WAITING_ROOMS_CACHE_KEY = 'cache:/api/waiting-rooms';
router.get('/waiting-rooms', redisCache(60), asyncHandler(async (_req, res) => {
  const result = await pool.query('SELECT center_id, floor_number, location FROM waiting_rooms ORDER BY floor_number');
  res.json(result.rows);
}));

// Upsert — (center_id, floor_number) is the natural key now (was floor_number
// alone) — fair_cycle_isolation_plan.md Phase 0. center_id defaults to the
// sole seeded Center until Phase 4 adds a real picker.
router.post('/waiting-rooms', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { floor_number, location, center_id } = req.body;
  if (!(Number.isInteger(floor_number) && floor_number >= 0)) {
    return res.status(400).json({ error: 'floor_number must be a non-negative integer' });
  }
  if (!location || !location.trim()) return res.status(400).json({ error: 'location is required' });

  const result = await pool.query(
    `INSERT INTO waiting_rooms (center_id, floor_number, location)
     VALUES (COALESCE($1, (SELECT id FROM centers ORDER BY id LIMIT 1)), $2, $3)
     ON CONFLICT (center_id, floor_number) DO UPDATE SET location = EXCLUDED.location
     RETURNING center_id, floor_number, location`,
    [center_id || null, floor_number, location.trim()]
  );
  await redis.del(WAITING_ROOMS_CACHE_KEY).catch(() => {});
  res.status(201).json(result.rows[0]);
}));

// center_id scoped (optional query param, defaults to the sole seeded
// Center) — floor_number alone is no longer the whole key, so an unscoped
// delete would remove that floor number's room from every center at once.
router.delete('/waiting-rooms/:floorNumber', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await pool.query(
    `DELETE FROM waiting_rooms
     WHERE center_id = COALESCE($1::int, (SELECT id FROM centers ORDER BY id LIMIT 1)) AND floor_number = $2
     RETURNING floor_number`,
    [req.query.center_id || null, req.params.floorNumber]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'No waiting room configured for that floor' });
  await redis.del(WAITING_ROOMS_CACHE_KEY).catch(() => {});
  res.json({ ok: true, floor_number: result.rows[0].floor_number });
}));

// Admin / Registration Staff: auto-generate arrival waves from fair_settings
// (batch_size × batch_interval_minutes). Appends rather than rejecting when a
// date already has batches — batch_number picks up after the highest
// existing one, on the same evenly-spaced grid the original batches used
// (anchored on batch #1's arrival_time), so "Generate batch" can be used more
// than once per fair day as more arrival waves turn out to be needed.
// center_id (fair_cycle_isolation_plan.md Phase 4): resolves which fair_settings
// row to generate batches against — admin passes it explicitly (defaults to
// the sole center via resolveCenterFilter's null when omitted, resolved
// further below), registration_staff is forced to their own. This also fixes
// a real latent bug: every lookup here used to key off a bare `fair_date`,
// which stopped being unique the moment Phase 0 let two Centers share a date
// — two centers generating batches for the same date would have silently
// collided on `fair_batches`'s (fair_date, batch_number) numbering (now
// (fair_settings_id, batch_number), but the lookups themselves still read
// fair_date alone until this fix).
router.post('/batches/generate', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (req, res) => {
  const { fair_date, first_arrival, batch_count } = req.body;
  if (!fair_date) return res.status(400).json({ error: 'fair_date is required' });
  if (!Number.isInteger(batch_count) || batch_count < 1 || batch_count > 100) {
    return res.status(400).json({ error: 'batch_count must be an integer between 1 and 100' });
  }
  const centerId = req.user.role === 'admin' ? (req.body.center_id || null) : req.user.center_id;

  const settingsRes = await pool.query(
    `SELECT * FROM fair_settings
     WHERE fair_date = $1 AND center_id = COALESCE($2::int, (SELECT id FROM centers ORDER BY id LIMIT 1))`,
    [fair_date, centerId]
  );
  if (!settingsRes.rows.length) return res.status(404).json({ error: 'No fair configured for that date (in this center)' });
  const settings = settingsRes.rows[0];

  const lastRes = await pool.query(
    'SELECT batch_number FROM fair_batches WHERE fair_settings_id = $1 ORDER BY batch_number DESC LIMIT 1',
    [settings.id]
  );
  const startNumber = lastRes.rows.length ? lastRes.rows[0].batch_number + 1 : 1;

  // Re-derive the original firstArrival from batch #1 (rather than re-
  // anchoring at "now" or trusting a caller-supplied first_arrival) so
  // appended batches land on the exact same grid as the existing ones —
  // batch_number n's arrival_time is always firstArrival + (n-1)*interval,
  // whether n was inserted today or in an earlier call.
  let firstArrival = first_arrival || `${fair_date} 09:00`;
  if (lastRes.rows.length) {
    const anchorRes = await pool.query(
      'SELECT arrival_time FROM fair_batches WHERE fair_settings_id = $1 AND batch_number = 1',
      [settings.id]
    );
    firstArrival = anchorRes.rows[0].arrival_time;
  }

  const result = await pool.query(
    `INSERT INTO fair_batches (fair_settings_id, fair_date, batch_number, arrival_time, capacity)
     SELECT $1, $2, gs.n, $3::timestamptz + (gs.n - 1) * ($4 * interval '1 minute'), $5
     FROM generate_series($6::int, $6::int + $7::int - 1) AS gs(n)
     RETURNING *`,
    [settings.id, fair_date, firstArrival, settings.batch_interval_minutes, settings.batch_size, startNumber, batch_count]
  );
  res.status(201).json(result.rows);
}));

// All staff roles: batch list with live check-in counts — the Gate tab's
// "Today's arrival batches" panel. centerId scopes via fair_settings_id ->
// fair_settings.center_id (fair_batches has no center_id of its own — it
// belongs to exactly one fair, which belongs to exactly one center).
//
// Scoped to each center's own currently *active* fair only — every fair
// cycle gets its own fresh batch waves (batch numbering restarts at 1,
// anchored to that cycle's own first arrival), but nothing previously
// filtered this list by cycle, so every past day's batches piled up here
// forever alongside today's real ones. An admin viewing "all centers"
// (centerId null) still only ever sees each center's *own* active fair's
// batches, never a blended history — same "is_active" join every other
// live-only consumer in this codebase already uses.
router.get('/batches', authenticateJWT, asyncHandler(async (req, res) => {
  const centerId = resolveCenterFilter(req);
  const result = await pool.query(
    `SELECT fb.* FROM fair_batches fb
     JOIN fair_settings fs ON fs.id = fb.fair_settings_id
     WHERE fs.is_active = true AND ($1::int IS NULL OR fs.center_id = $1)
     ORDER BY fb.fair_date, fb.batch_number`,
    [centerId || null]
  );
  res.json(result.rows);
}));

// ---------------------------------------------------------------------------
// Per-fair-cycle company roster (company_roster_plan.md) — a company is a
// permanent, reusable per-Center directory entry (routes/companies.js); each
// fair cycle explicitly opts one in via its own roster row here, carrying
// that cycle's operational values (seats/interview_minutes/floor_number/
// is_open). Nested under the fair, same convention as archive/waiting-rooms
// above.
// ---------------------------------------------------------------------------

router.get('/fair-settings/:id/roster', authenticateJWT, requireRole('admin', 'registration_staff'), asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT r.id, r.company_id, c.company_name, r.seats, r.interview_minutes, r.floor_number, r.is_open, r.created_at
     FROM fair_company_roster r
     JOIN companies c ON c.id = r.company_id
     WHERE r.fair_settings_id = $1
     ORDER BY c.company_name`,
    [req.params.id]
  );
  res.json(result.rows);
}));

// Upsert-by-(fair_settings_id, company_id) — re-adding a company that was
// previously removed from this cycle's roster just refreshes its values
// rather than erroring on the UNIQUE constraint. Also where the Redis leak
// fix lives (company_roster_plan.md): a re-added company must start this
// cycle from fresh drain-rate/ping-buffer defaults, not a stale tuned value
// carried over from whatever cycle last used it.
router.post('/fair-settings/:id/roster', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const fairId = Number(req.params.id);
  if (!Number.isInteger(fairId)) return res.status(400).json({ error: 'Invalid fair id' });
  const { company_id, seats, interview_minutes, floor_number, is_open } = req.body;
  if (!company_id) return res.status(400).json({ error: 'company_id is required' });
  if (interview_minutes != null && !(Number.isInteger(interview_minutes) && interview_minutes > 0)) {
    return res.status(400).json({ error: 'interview_minutes must be a positive integer' });
  }
  if (floor_number != null && !(Number.isInteger(floor_number) && floor_number >= 0)) {
    return res.status(400).json({ error: 'floor_number must be a non-negative integer' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO fair_company_roster (fair_settings_id, company_id, seats, interview_minutes, floor_number, is_open)
       VALUES ($1, $2, COALESCE($3, 1), COALESCE($4, 6), $5, COALESCE($6, false))
       ON CONFLICT (fair_settings_id, company_id) DO UPDATE SET
         seats = EXCLUDED.seats, interview_minutes = EXCLUDED.interview_minutes,
         floor_number = EXCLUDED.floor_number, is_open = EXCLUDED.is_open
       RETURNING *`,
      [fairId, company_id, seats || null, interview_minutes || null,
       floor_number != null ? floor_number : null, typeof is_open === 'boolean' ? is_open : null]
    );
    await store.clearTunedState(company_id);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23514') return res.status(400).json({ error: 'interview_minutes must be positive and floor_number must be non-negative' });
    if (err.code === '23503') return res.status(404).json({ error: 'Company or fair not found' });
    throw err;
  }
}));

router.put('/fair-settings/:id/roster/:companyId', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const { seats, interview_minutes, floor_number, is_open } = req.body;
  if (interview_minutes != null && !(Number.isInteger(interview_minutes) && interview_minutes > 0)) {
    return res.status(400).json({ error: 'interview_minutes must be a positive integer' });
  }
  if (floor_number != null && !(Number.isInteger(floor_number) && floor_number >= 0)) {
    return res.status(400).json({ error: 'floor_number must be a non-negative integer' });
  }

  const result = await pool.query(
    `UPDATE fair_company_roster SET
       seats = COALESCE($1, seats),
       interview_minutes = COALESCE($2, interview_minutes),
       floor_number = COALESCE($3, floor_number),
       is_open = COALESCE($4, is_open)
     WHERE fair_settings_id = $5 AND company_id = $6
     RETURNING *`,
    [seats || null, interview_minutes || null, floor_number != null ? floor_number : null,
     typeof is_open === 'boolean' ? is_open : null, req.params.id, req.params.companyId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Roster entry not found' });
  res.json(result.rows[0]);
}));

// App-level 409 guard (no DB FK enforces this — candidate_company_status.
// company_id references companies, not the roster row): a company with a
// live booking in this cycle can't be pulled off the roster out from under
// it — resolve the booking first.
router.delete('/fair-settings/:id/roster/:companyId', authenticateJWT, requireRole('admin'), asyncHandler(async (req, res) => {
  const liveRes = await pool.query(
    `SELECT 1 FROM candidate_company_status ccs
     JOIN candidates cd ON cd.id = ccs.candidate_id
     WHERE ccs.company_id = $1 AND cd.fair_settings_id = $2
       AND ccs.status IN ('Pending', 'Waitlisted', 'Dispatched') AND ccs.deleted_at IS NULL
     LIMIT 1`,
    [req.params.companyId, req.params.id]
  );
  if (liveRes.rows.length) {
    return res.status(409).json({ error: 'This company has live bookings in this cycle — resolve them before removing it from the roster' });
  }

  const result = await pool.query(
    'DELETE FROM fair_company_roster WHERE fair_settings_id = $1 AND company_id = $2 RETURNING id',
    [req.params.id, req.params.companyId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Roster entry not found' });
  res.json({ ok: true });
}));

module.exports = router;
