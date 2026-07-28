// Insights dashboard (admin tab) — cross-cutting inference over registration
// + interview-outcome data: per-company vacancy fill against Selected/
// Rejected/Shortlisted/Hold/Pending, plus gender and SDC-program composition.
// One function, same self-contained-report shape as lib/floorStats.js.
const pool = require('../db');

// Vacancies and candidate activity are aggregated in separate CTEs before the
// join, not joined directly — joining candidate_company_status straight
// against company_posts would fan out (N posts x M candidates per company)
// and inflate every count. See lib/floorStats.js's on_hand query for the
// same fan-out trap in a different join.
// centerId (optional, fair_cycle_isolation_plan.md Phase 4): scopes companies
// (direct companies.center_id) — the cand CTE's counts fall out correctly for
// free since they're grouped by company id and the outer query filters the
// companies list itself, same shape as lib/floorStats.js's per-company query.
//
// Historical vs. live-state deleted_at filtering (same reasoning as
// lib/floorStats.js): registered/assigned/done/selected/shortlisted/hold/
// rejected/no_show/the demographic breakdowns are historical facts about
// today and stay true even after a candidate exits or gets soft-deleted —
// filtering those on deleted_at made them visibly shrink through the day as
// people exited, which reads as data loss even though nothing was lost.
// Only pending/dispatched/waitlisted describe the current moment, so those
// keep excluding exited/deleted candidates.
async function computeInsights({ date, centerId } = {}) {
  const dateFilter = date || null;
  const centerFilter = centerId || null;

  const [availableDatesRes, registeredRes, rowsRes] = await Promise.all([
    // Cast to text in SQL, not JS: node-pg parses a DATE column into a JS
    // Date via `new Date(y, m, d)` (local time), and .toISOString() on that
    // is UTC — the round trip silently shifts the date back a day whenever
    // the session runs ahead of UTC (this DB's session timezone is
    // Asia/Calcutta, +5:30 — every date would be one day early). Returning
    // text keeps Postgres's own YYYY-MM-DD, no JS Date involved.
    pool.query(
      `SELECT DISTINCT (cd.registered_at::date)::text AS day FROM candidates cd
        LEFT JOIN fair_settings fs ON fs.id = cd.fair_settings_id
        WHERE cd.deleted_at IS NULL AND ($1::int IS NULL OR fs.center_id = $1)
        ORDER BY day DESC`,
      [centerFilter]
    ),
    // Historical: how many registered today, full stop — mirrors
    // lib/floorStats.js's own registered count so Floor and Insights agree.
    // Gender/SDC breakdown lives here too, one row per candidate (not per
    // booking) — the per-company `cand` CTE below double/triple-counts
    // anyone booked at more than one company when its own per-company
    // gender/SDC columns get summed across companies into `totals`, so
    // `totals.male` etc. is really "male interviews," not "male candidates."
    // This is the actual distinct-candidate figure the demographic donuts
    // use; the per-company breakdown table further down is a different,
    // legitimate metric (candidates assigned to *that* company) and is left
    // reading from `totals` as before.
    pool.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE cd.gender = 'Male')::int AS male,
              COUNT(*) FILTER (WHERE cd.gender = 'Female')::int AS female,
              COUNT(*) FILTER (WHERE cd.gender = 'Other')::int AS other_gender,
              COUNT(*) FILTER (WHERE cd.gender IS NULL)::int AS gender_unknown,
              COUNT(*) FILTER (WHERE cd.is_sdc = true)::int AS sdc,
              COUNT(*) FILTER (WHERE cd.is_sdc = false)::int AS non_sdc,
              COUNT(*) FILTER (WHERE cd.is_sdc IS NULL)::int AS sdc_unknown
         FROM candidates cd
        LEFT JOIN fair_settings fs ON fs.id = cd.fair_settings_id
       WHERE ($1::date IS NULL OR cd.registered_at::date = $1::date)
         AND ($2::int IS NULL OR fs.center_id = $2)`,
      [dateFilter, centerFilter]
    ),
    pool.query(
      `WITH vac AS (
         SELECT company_id, COALESCE(SUM(vacancies), 0)::int AS vacancies
         FROM company_posts GROUP BY company_id
       ),
       cand AS (
         -- deleted_at carried through, not pre-filtered — historical outcome
         -- counts below don't filter on it, live-state ones do.
         SELECT ccs.company_id, ccs.status, cd.gender, cd.is_sdc,
                ccs.deleted_at AS ccs_deleted_at, cd.deleted_at AS cd_deleted_at
         FROM candidate_company_status ccs
         JOIN candidates cd ON cd.id = ccs.candidate_id
         WHERE ($1::date IS NULL OR cd.registered_at::date = $1::date)
       )
       SELECT
         c.id, c.company_name,
         COALESCE(v.vacancies, 0)::int AS vacancies,
         COUNT(cand.*)::int AS assigned,
         COUNT(*) FILTER (WHERE cand.status IN ('Selected','Rejected','Shortlisted','Hold'))::int AS done,
         COUNT(*) FILTER (WHERE cand.status = 'Selected')::int AS selected,
         COUNT(*) FILTER (WHERE cand.status = 'Shortlisted')::int AS shortlisted,
         COUNT(*) FILTER (WHERE cand.status = 'Hold')::int AS hold,
         COUNT(*) FILTER (WHERE cand.status = 'Rejected')::int AS rejected,
         COUNT(*) FILTER (WHERE cand.status = 'Pending' AND cand.ccs_deleted_at IS NULL AND cand.cd_deleted_at IS NULL)::int AS pending,
         COUNT(*) FILTER (WHERE cand.status = 'Dispatched' AND cand.ccs_deleted_at IS NULL AND cand.cd_deleted_at IS NULL)::int AS dispatched,
         COUNT(*) FILTER (WHERE cand.status = 'Waitlisted' AND cand.ccs_deleted_at IS NULL AND cand.cd_deleted_at IS NULL)::int AS waitlisted,
         COUNT(*) FILTER (WHERE cand.status = 'No_Show')::int AS no_show,
         COUNT(*) FILTER (WHERE cand.gender = 'Male')::int AS male,
         COUNT(*) FILTER (WHERE cand.gender = 'Female')::int AS female,
         COUNT(*) FILTER (WHERE cand.gender = 'Other')::int AS other_gender,
         -- cand.status IS NOT NULL is the "this LEFT JOIN actually matched a
         -- candidate" guard — without it, a company with zero candidates
         -- gets its one all-NULL outer-join row miscounted as one
         -- "unknown gender" candidate (ccs.status is NOT NULL, so it's a
         -- safe matched-row sentinel; gender/is_sdc themselves are nullable
         -- and can't be used as their own guard).
         COUNT(*) FILTER (WHERE cand.status IS NOT NULL AND cand.gender IS NULL)::int AS gender_unknown,
         COUNT(*) FILTER (WHERE cand.is_sdc = true)::int AS sdc,
         COUNT(*) FILTER (WHERE cand.is_sdc = false)::int AS non_sdc,
         COUNT(*) FILTER (WHERE cand.status IS NOT NULL AND cand.is_sdc IS NULL)::int AS sdc_unknown
       FROM companies c
       LEFT JOIN vac v ON v.company_id = c.id
       LEFT JOIN cand ON cand.company_id = c.id
       WHERE ($2::int IS NULL OR c.center_id = $2)
       GROUP BY c.id, c.company_name, v.vacancies
       ORDER BY c.company_name`,
      [dateFilter, centerFilter]
    ),
  ]);

  const companies = rowsRes.rows.map((r) => ({
    ...r,
    fill_rate: r.vacancies > 0 ? Math.round((r.selected / r.vacancies) * 100) : null,
  }));

  const totals = companies.reduce((t, c) => {
    for (const key of ['vacancies', 'assigned', 'done', 'selected', 'shortlisted', 'hold', 'rejected',
      'pending', 'dispatched', 'waitlisted', 'no_show', 'male', 'female', 'other_gender', 'gender_unknown',
      'sdc', 'non_sdc', 'sdc_unknown']) {
      t[key] = (t[key] || 0) + c[key];
    }
    return t;
  }, {});
  totals.fill_rate = totals.vacancies > 0 ? Math.round((totals.selected / totals.vacancies) * 100) : null;

  return {
    date: dateFilter,
    center_id: centerFilter,
    available_dates: availableDatesRes.rows.map((r) => r.day),
    registered: registeredRes.rows[0].n,
    // Distinct-candidate demographics — see the query comment above for why
    // this can't just be `totals` (which sums per-company bookings).
    candidate_demographics: {
      male: registeredRes.rows[0].male,
      female: registeredRes.rows[0].female,
      other_gender: registeredRes.rows[0].other_gender,
      gender_unknown: registeredRes.rows[0].gender_unknown,
      sdc: registeredRes.rows[0].sdc,
      non_sdc: registeredRes.rows[0].non_sdc,
      sdc_unknown: registeredRes.rows[0].sdc_unknown,
    },
    totals,
    companies,
  };
}

module.exports = { computeInsights };
