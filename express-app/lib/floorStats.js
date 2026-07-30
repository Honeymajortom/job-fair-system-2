// Phase 5 (new_architecture.md §4/§6.3) — buffer target + starvation
// projection display. lib/bufferController.js closes the loop this module
// only used to display — same B_j* formula, via lib/travelBuffer.js
// so the two can't drift onto different numbers. One function, mirroring how
// routes/reports.js keeps each report self-contained — this just
// consolidates several queries into one payload since the dashboard needs
// them together.
const pool = require('../db');
const redis = require('./redisClient');
const store = require('./queueStore');
const { MIN_DRAIN_RATE } = require('./pingLadder');
const { getTravelBuffer } = require('./travelBuffer');

// Approximation: fair_settings has no start/close timestamp, only a duration
// (fair_hours). The earliest batch's arrival_time is the practical start.
// centerId (fair_cycle_isolation_plan.md Phase 4): when scoped to one Center,
// picks that Center's own active fair. Left null (the "all centers" admin
// view), this still just grabs *an* active fair arbitrarily — accurate only
// when a single fair is active system-wide, a known limitation carried
// forward from Phase 0 (see that phase's own notes) rather than fixed here.
async function getClosingTime(centerId) {
  const fairRes = await pool.query(
    `SELECT id, fair_date, fair_hours FROM fair_settings
     WHERE is_active = true AND ($1::int IS NULL OR center_id = $1)
     ORDER BY fair_date DESC LIMIT 1`,
    [centerId || null]
  );
  if (!fairRes.rows.length) return null;
  const { id: fairId, fair_date, fair_hours } = fairRes.rows[0];
  // fair_settings_id, not fair_date, is the correct key now that two Centers
  // can share a date (fair_cycle_isolation_plan.md Phase 0) — a bare
  // fair_date lookup would blend another center's batches into this start-
  // time estimate on a shared date.
  const batchRes = await pool.query(
    `SELECT MIN(arrival_time) AS start FROM fair_batches WHERE fair_settings_id = $1`,
    [fairId]
  );
  const start = batchRes.rows[0].start;
  if (!start) return null;
  return new Date(new Date(start).getTime() + fair_hours * 60 * 60 * 1000);
}

// date (optional, 'YYYY-MM-DD'): scopes registered/at_desk/outcome/waitlisted
// and the per-company on_hand/remaining counts to one registration day — same
// semantics and same registered_at::date grouping as lib/insights.js, so
// Floor and Insights agree on what "day-wise" means. now_serving/alerts/
// minutesToClose stay unfiltered regardless — Redis desk locks and the
// close-time projection only ever describe the current moment, there's no
// historical record of "who was at a desk" to scope by day.
//
// Historical vs. live-state deleted_at filtering: candidates.deleted_at (and
// the matching candidate_company_status.deleted_at) gets set by TWO things —
// a genuine exit-scan (POST /candidates/exit, "done for the day, on their way
// out") and an explicit staff correction (DELETE /candidates/:id, the Delete
// Candidate tool). Either way, "registered today" and a real outcome
// (Selected/Rejected/Hold/Shortlisted) already happened and stays true
// regardless of whether the candidate later left — filtering those on
// deleted_at made "Registered"/"Completed" visibly shrink through the day as
// people exited, which reads as data loss even though nothing was lost.
// registered/selected/rejected/hold/shortlisted/completed below are
// therefore historical (no deleted_at filter). at_desk/waitlisted/on_hand/
// remaining/now_serving describe the current moment, not history, so those
// keep excluding exited/deleted candidates.
// centerId (optional, fair_cycle_isolation_plan.md Phase 4): scopes companies
// (direct companies.center_id) and the fair-wide candidate counts (via
// candidates.fair_settings_id -> fair_settings.center_id — a LEFT JOIN, not
// INNER, so a legacy pre-Phase-1 candidate with no fair_settings_id doesn't
// vanish from the unscoped/all-centers view; it's simply excluded once a
// specific center is actually selected, same "no info = excluded when
// scoped" tradeoff Phase 2's dedup fix already accepted).
async function computeFloorStats({ date, centerId } = {}) {
  const dateFilter = date || null;
  const centerFilter = centerId || null;
  const [registeredRes, atDeskRes, outcomesRes, waitlistedRes, companiesRes, availableDatesRes, activeFairRes, closingTime, travelBuffer] = await Promise.all([
    // Historical: how many registered today, full stop — see the deleted_at
    // note above.
    pool.query(
      `SELECT COUNT(*)::int AS n FROM candidates cd
       LEFT JOIN fair_settings fs ON fs.id = cd.fair_settings_id
       WHERE ($1::date IS NULL OR cd.registered_at::date = $1::date)
         AND ($2::int IS NULL OR fs.center_id = $2)`,
      [dateFilter, centerFilter]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM candidate_company_status ccs
       JOIN candidates cd ON cd.id = ccs.candidate_id AND cd.deleted_at IS NULL
       LEFT JOIN fair_settings fs ON fs.id = cd.fair_settings_id
       WHERE ccs.status = 'Dispatched' AND ccs.deleted_at IS NULL
         AND ($1::date IS NULL OR cd.registered_at::date = $1::date)
         AND ($2::int IS NULL OR fs.center_id = $2)`,
      [dateFilter, centerFilter]
    ),
    // Historical outcome breakdown — Selected/Rejected/Hold/Shortlisted each
    // get their own tile on Floor now, not just a combined "Completed".
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE ccs.status = 'Selected')::int AS selected,
         COUNT(*) FILTER (WHERE ccs.status = 'Rejected')::int AS rejected,
         COUNT(*) FILTER (WHERE ccs.status = 'Hold')::int AS hold,
         COUNT(*) FILTER (WHERE ccs.status = 'Shortlisted')::int AS shortlisted,
         COUNT(*) FILTER (WHERE ccs.status IN ('Selected','Rejected','Shortlisted','Hold'))::int AS completed
       FROM candidate_company_status ccs
       JOIN candidates cd ON cd.id = ccs.candidate_id
       LEFT JOIN fair_settings fs ON fs.id = cd.fair_settings_id
       WHERE ($1::date IS NULL OR cd.registered_at::date = $1::date)
         AND ($2::int IS NULL OR fs.center_id = $2)`,
      [dateFilter, centerFilter]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM candidate_company_status ccs
       JOIN candidates cd ON cd.id = ccs.candidate_id AND cd.deleted_at IS NULL
       LEFT JOIN fair_settings fs ON fs.id = cd.fair_settings_id
       WHERE ccs.status = 'Waitlisted' AND ccs.deleted_at IS NULL
         AND ($1::date IS NULL OR cd.registered_at::date = $1::date)
         AND ($2::int IS NULL OR fs.center_id = $2)`,
      [dateFilter, centerFilter]
    ),
    // on_hand (approximation #2): checked-in + still Pending for this company.
    // remaining (approximation #4): everyone not yet at a terminal outcome.
    // completed: same terminal-status set as the fair-wide `outcomesRes`
    // above, just grouped per company — added for the Floor tile redesign's
    // per-company "done" counter and pace ("falling behind") signal.
    // Date-scoping happens in the ccs_scoped CTE (not a bare WHERE after the
    // LEFT JOIN) so a company with zero matching candidates on that day still
    // shows up with on_hand/remaining = 0 instead of disappearing — same
    // fan-out-avoidance shape as lib/insights.js's `cand` CTE. Center-scoping
    // filters the companies list itself (c.center_id) — the per-company
    // counts fall out correctly for free since they're grouped by company id.
    // company_roster_plan.md: seats/interview_minutes now come from the
    // roster, not the company's own (now-legacy) columns — and this query
    // is the one place that genuinely needs to be date-aware about it: a
    // historical date should resolve the roster for whichever fair was
    // actually active *that day* (fs.fair_date = the given date), not
    // today's active fair, or a past day's Floor view would show today's
    // capacity numbers against an ended cycle. Blank date (all-time view)
    // falls back to "active fair for this company's Center", same
    // live-only convention every other consumer uses. Both the fair_settings
    // and fair_company_roster joins below are INNER, not LEFT — a company
    // with no roster row for the resolved fair (never added to this cycle's
    // roster, or no fair resolves at all) is excluded from Floor entirely,
    // not shown with null seats/interview_minutes.
    pool.query(`
      WITH ccs_scoped AS (
        -- deleted_at carried through, not pre-filtered, so on_hand/remaining
        -- (live-state) and completed (historical outcome) can each apply the
        -- right rule — see the deleted_at note above this function.
        SELECT ccs.company_id, ccs.status, ccs.serial, cd.checked_in_at, cd.token_no,
               ccs.deleted_at AS ccs_deleted_at, cd.deleted_at AS cd_deleted_at
        FROM candidate_company_status ccs
        JOIN candidates cd ON cd.id = ccs.candidate_id
        WHERE ($1::date IS NULL OR cd.registered_at::date = $1::date)
      )
      SELECT c.id, c.company_name, r.seats, r.interview_minutes,
             COUNT(*) FILTER (WHERE ccs.status = 'Pending' AND ccs.checked_in_at IS NOT NULL
               AND ccs.ccs_deleted_at IS NULL AND ccs.cd_deleted_at IS NULL)::int AS on_hand,
             COUNT(*) FILTER (WHERE ccs.status IN ('Pending','Waitlisted','Dispatched')
               AND ccs.ccs_deleted_at IS NULL AND ccs.cd_deleted_at IS NULL)::int AS remaining,
             COUNT(*) FILTER (WHERE ccs.status IN ('Selected','Rejected','Shortlisted','Hold'))::int AS completed,
             -- Floor tile redesign: the "Queue" squares show the actual next-
             -- up token numbers (serial order = call order), not placeholder
             -- 1..N counters — capped at 6 to match the tile's MAX_SLOTS, the
             -- rest is still covered by the existing "+N" overflow badge.
             (SELECT array_agg(t.token_no ORDER BY t.serial ASC) FROM (
                SELECT token_no, serial FROM ccs_scoped s2
                 WHERE s2.company_id = c.id AND s2.status = 'Pending' AND s2.checked_in_at IS NOT NULL
                   AND s2.ccs_deleted_at IS NULL AND s2.cd_deleted_at IS NULL
                 ORDER BY serial ASC LIMIT 6
              ) t) AS on_hand_tokens
      FROM companies c
      LEFT JOIN ccs_scoped ccs ON ccs.company_id = c.id
      JOIN fair_settings fs ON fs.center_id = c.center_id
        AND (($1::date IS NOT NULL AND fs.fair_date = $1::date) OR ($1::date IS NULL AND fs.is_active = true))
      JOIN fair_company_roster r ON r.company_id = c.id AND r.fair_settings_id = fs.id
      WHERE ($2::int IS NULL OR c.center_id = $2)
      GROUP BY c.id, r.seats, r.interview_minutes
      ORDER BY c.company_name
    `, [dateFilter, centerFilter]),
    // Same text-cast reasoning as lib/insights.js: avoid node-pg's local-time
    // Date round trip silently shifting the day back by one.
    pool.query(
      `SELECT DISTINCT (cd.registered_at::date)::text AS day FROM candidates cd
        LEFT JOIN fair_settings fs ON fs.id = cd.fair_settings_id
        WHERE cd.deleted_at IS NULL AND ($1::int IS NULL OR fs.center_id = $1)
        ORDER BY day DESC`,
      [centerFilter]
    ),
    // A freshly-activated fair has zero registered candidates yet, so its own
    // date never shows up in availableDatesRes (that's derived purely from
    // registered_at) — floor_manager has no access to GET /fair-settings to
    // find the date another way, so it's surfaced here instead, folded into
    // available_dates below so "today" is always selectable once a fair is
    // live, even before anyone has registered.
    pool.query(
      `SELECT to_char(fair_date, 'YYYY-MM-DD') AS d FROM fair_settings
        WHERE is_active = true AND ($1::int IS NULL OR center_id = $1)
        ORDER BY fair_date DESC LIMIT 1`,
      [centerFilter]
    ),
    getClosingTime(centerFilter),
    getTravelBuffer(),
  ]);

  const activeFairDate = activeFairRes.rows[0]?.d || null;

  const minutesToClose = closingTime ? Math.max(0, (closingTime.getTime() - Date.now()) / 60000) : null;

  const companies = [];
  const alerts = [];
  for (const row of companiesRes.rows) {
    const drainRate = await store.getDrainRate(row.id);
    const rate = Math.max(drainRate || (row.seats / row.interview_minutes), MIN_DRAIN_RATE);
    const target = Math.round(rate * travelBuffer); // B_j* = d_hat_j * (tau_bar + sigma_tau), §4

    companies.push({
      id: row.id,
      name: row.company_name,
      interviewers: row.seats,
      on_hand: row.on_hand,
      on_hand_tokens: row.on_hand_tokens || [],
      target,
      low: row.on_hand < target,
      completed: row.completed,
      remaining: row.remaining,
    });

    // Starvation projection, §6.3: p_ij > d_hat_j * (T_close - t).
    if (minutesToClose !== null && row.remaining > rate * minutesToClose) {
      alerts.push({ company_id: row.id, company_name: row.company_name, remaining: row.remaining });
    }
  }

  // Now-serving board: Postgres has no desk_id column anywhere — the Redis
  // candidate lock (lock:{candidateId} -> deskId) is the only place it lives.
  const dispatchedRes = await pool.query(`
    SELECT cd.id AS candidate_id, cd.token_no, c.id AS company_id, c.company_name
    FROM candidate_company_status ccs
    JOIN candidates cd ON cd.id = ccs.candidate_id AND cd.deleted_at IS NULL
    JOIN companies c ON c.id = ccs.company_id
    WHERE ccs.status = 'Dispatched' AND ccs.deleted_at IS NULL
      AND ($1::int IS NULL OR c.center_id = $1)
    ORDER BY ccs.dispatched_at ASC NULLS LAST
  `, [centerFilter]);
  let nowServing = [];
  if (dispatchedRes.rows.length) {
    const desks = await redis.mget(...dispatchedRes.rows.map((r) => `lock:${r.candidate_id}`));
    nowServing = dispatchedRes.rows
      .map((r, i) => ({ token: r.token_no, company_id: r.company_id, company_name: r.company_name, desk_id: desks[i] || null }))
      .filter((r) => r.desk_id);
  }

  const availableDates = availableDatesRes.rows.map((r) => r.day);
  if (activeFairDate && !availableDates.includes(activeFairDate)) {
    availableDates.unshift(activeFairDate);
    availableDates.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // keep DESC order
  }

  return {
    date: dateFilter,
    center_id: centerFilter,
    available_dates: availableDates,
    active_fair_date: activeFairDate,
    registered: registeredRes.rows[0].n,
    at_desk: atDeskRes.rows[0].n,
    completed: outcomesRes.rows[0].completed,
    selected: outcomesRes.rows[0].selected,
    rejected: outcomesRes.rows[0].rejected,
    hold: outcomesRes.rows[0].hold,
    shortlisted: outcomesRes.rows[0].shortlisted,
    waitlisted: waitlistedRes.rows[0].n,
    needs_attention: alerts.length,
    companies,
    now_serving: nowServing,
    alerts,
  };
}

module.exports = { computeFloorStats };
