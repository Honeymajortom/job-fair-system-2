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
async function getClosingTime() {
  const fairRes = await pool.query(
    `SELECT fair_date, fair_hours FROM fair_settings WHERE is_active = true ORDER BY fair_date DESC LIMIT 1`
  );
  if (!fairRes.rows.length) return null;
  const { fair_date, fair_hours } = fairRes.rows[0];
  const batchRes = await pool.query(
    `SELECT MIN(arrival_time) AS start FROM fair_batches WHERE fair_date = $1`,
    [fair_date]
  );
  const start = batchRes.rows[0].start;
  if (!start) return null;
  return new Date(new Date(start).getTime() + fair_hours * 60 * 60 * 1000);
}

// date (optional, 'YYYY-MM-DD'): scopes registered/at_desk/completed/waitlisted
// and the per-company on_hand/remaining counts to one registration day — same
// semantics and same registered_at::date grouping as lib/insights.js, so
// Floor and Insights agree on what "day-wise" means. now_serving/alerts/
// minutesToClose stay unfiltered regardless — Redis desk locks and the
// close-time projection only ever describe the current moment, there's no
// historical record of "who was at a desk" to scope by day.
async function computeFloorStats({ date } = {}) {
  const dateFilter = date || null;
  const [registeredRes, atDeskRes, completedRes, waitlistedRes, companiesRes, availableDatesRes, closingTime, travelBuffer] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS n FROM candidates
       WHERE deleted_at IS NULL AND ($1::date IS NULL OR registered_at::date = $1::date)`,
      [dateFilter]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM candidate_company_status ccs
       JOIN candidates cd ON cd.id = ccs.candidate_id AND cd.deleted_at IS NULL
       WHERE ccs.status = 'Dispatched' AND ccs.deleted_at IS NULL
         AND ($1::date IS NULL OR cd.registered_at::date = $1::date)`,
      [dateFilter]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM candidate_company_status ccs
       JOIN candidates cd ON cd.id = ccs.candidate_id AND cd.deleted_at IS NULL
       WHERE ccs.status IN ('Selected','Rejected','Shortlisted','Hold') AND ccs.deleted_at IS NULL
         AND ($1::date IS NULL OR cd.registered_at::date = $1::date)`,
      [dateFilter]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM candidate_company_status ccs
       JOIN candidates cd ON cd.id = ccs.candidate_id AND cd.deleted_at IS NULL
       WHERE ccs.status = 'Waitlisted' AND ccs.deleted_at IS NULL
         AND ($1::date IS NULL OR cd.registered_at::date = $1::date)`,
      [dateFilter]
    ),
    // on_hand (approximation #2): checked-in + still Pending for this company.
    // remaining (approximation #4): everyone not yet at a terminal outcome.
    // Date-scoping happens in the ccs_scoped CTE (not a bare WHERE after the
    // LEFT JOIN) so a company with zero matching candidates on that day still
    // shows up with on_hand/remaining = 0 instead of disappearing — same
    // fan-out-avoidance shape as lib/insights.js's `cand` CTE.
    pool.query(`
      WITH ccs_scoped AS (
        SELECT ccs.company_id, ccs.status, cd.checked_in_at
        FROM candidate_company_status ccs
        JOIN candidates cd ON cd.id = ccs.candidate_id AND cd.deleted_at IS NULL
        WHERE ccs.deleted_at IS NULL
          AND ($1::date IS NULL OR cd.registered_at::date = $1::date)
      )
      SELECT c.id, c.company_name, c.seats, c.interview_minutes,
             COUNT(*) FILTER (WHERE ccs.status = 'Pending' AND ccs.checked_in_at IS NOT NULL)::int AS on_hand,
             COUNT(*) FILTER (WHERE ccs.status IN ('Pending','Waitlisted','Dispatched'))::int AS remaining
      FROM companies c
      LEFT JOIN ccs_scoped ccs ON ccs.company_id = c.id
      GROUP BY c.id
      ORDER BY c.company_name
    `, [dateFilter]),
    // Same text-cast reasoning as lib/insights.js: avoid node-pg's local-time
    // Date round trip silently shifting the day back by one.
    pool.query(
      `SELECT DISTINCT (registered_at::date)::text AS day FROM candidates
        WHERE deleted_at IS NULL ORDER BY day DESC`
    ),
    getClosingTime(),
    getTravelBuffer(),
  ]);

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
      target,
      low: row.on_hand < target,
    });

    // Starvation projection, §6.3: p_ij > d_hat_j * (T_close - t).
    if (minutesToClose !== null && row.remaining > rate * minutesToClose) {
      alerts.push({ company_id: row.id, company_name: row.company_name, remaining: row.remaining });
    }
  }

  // Now-serving board: Postgres has no desk_id column anywhere — the Redis
  // candidate lock (lock:{candidateId} -> deskId) is the only place it lives.
  const dispatchedRes = await pool.query(`
    SELECT cd.id AS candidate_id, cd.token_no, c.company_name
    FROM candidate_company_status ccs
    JOIN candidates cd ON cd.id = ccs.candidate_id AND cd.deleted_at IS NULL
    JOIN companies c ON c.id = ccs.company_id
    WHERE ccs.status = 'Dispatched' AND ccs.deleted_at IS NULL
    ORDER BY ccs.dispatched_at ASC NULLS LAST
  `);
  let nowServing = [];
  if (dispatchedRes.rows.length) {
    const desks = await redis.mget(...dispatchedRes.rows.map((r) => `lock:${r.candidate_id}`));
    nowServing = dispatchedRes.rows
      .map((r, i) => ({ token: r.token_no, company_name: r.company_name, desk_id: desks[i] || null }))
      .filter((r) => r.desk_id);
  }

  return {
    date: dateFilter,
    available_dates: availableDatesRes.rows.map((r) => r.day),
    registered: registeredRes.rows[0].n,
    at_desk: atDeskRes.rows[0].n,
    completed: completedRes.rows[0].n,
    waitlisted: waitlistedRes.rows[0].n,
    needs_attention: alerts.length,
    companies,
    now_serving: nowServing,
    alerts,
  };
}

module.exports = { computeFloorStats };
