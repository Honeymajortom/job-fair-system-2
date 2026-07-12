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
async function computeInsights({ date } = {}) {
  const dateFilter = date || null;

  const [availableDatesRes, rowsRes] = await Promise.all([
    // Cast to text in SQL, not JS: node-pg parses a DATE column into a JS
    // Date via `new Date(y, m, d)` (local time), and .toISOString() on that
    // is UTC — the round trip silently shifts the date back a day whenever
    // the session runs ahead of UTC (this DB's session timezone is
    // Asia/Calcutta, +5:30 — every date would be one day early). Returning
    // text keeps Postgres's own YYYY-MM-DD, no JS Date involved.
    pool.query(
      `SELECT DISTINCT (registered_at::date)::text AS day FROM candidates
        WHERE deleted_at IS NULL ORDER BY day DESC`
    ),
    pool.query(
      `WITH vac AS (
         SELECT company_id, COALESCE(SUM(vacancies), 0)::int AS vacancies
         FROM company_posts GROUP BY company_id
       ),
       cand AS (
         SELECT ccs.company_id, ccs.status, cd.gender, cd.is_sdc
         FROM candidate_company_status ccs
         JOIN candidates cd ON cd.id = ccs.candidate_id AND cd.deleted_at IS NULL
         WHERE ccs.deleted_at IS NULL
           AND ($1::date IS NULL OR cd.registered_at::date = $1::date)
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
         COUNT(*) FILTER (WHERE cand.status = 'Pending')::int AS pending,
         COUNT(*) FILTER (WHERE cand.status = 'Dispatched')::int AS dispatched,
         COUNT(*) FILTER (WHERE cand.status = 'Waitlisted')::int AS waitlisted,
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
       GROUP BY c.id, c.company_name, v.vacancies
       ORDER BY c.company_name`,
      [dateFilter]
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
    available_dates: availableDatesRes.rows.map((r) => r.day),
    totals,
    companies,
  };
}

module.exports = { computeInsights };
