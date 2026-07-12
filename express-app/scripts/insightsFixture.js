// Insights dashboard exit criteria: lib/insights.js's computeInsights()
// correctly aggregates vacancies (without company_posts x candidate fan-out),
// outcome status counts, gender/is_sdc breakdowns (without the outer-join
// "unknown" miscount bug caught during manual testing — a company with zero
// candidates must report 0, not 1, for every *_unknown column), fill_rate,
// and the ?date scope.
require('dotenv').config();
const pool = require('../db');
const { computeInsights } = require('../lib/insights');

let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '  — ' + detail : ''}`); }
}

async function makeCompany(name) {
  const r = await pool.query(
    `INSERT INTO companies (company_name, location, seats, interview_minutes)
     VALUES ($1, 'Test Hall', 1, 6)
     ON CONFLICT (company_name) DO UPDATE SET location = EXCLUDED.location
     RETURNING id`,
    [name]
  );
  return r.rows[0].id;
}

async function makeCandidate({ name, gender = null, isSdc = null, registeredAt = null }) {
  const tok = await pool.query("SELECT nextval('token_seq') AS n");
  const tokenNo = `T-${tok.rows[0].n}`;
  const r = await pool.query(
    `INSERT INTO candidates (token_no, name, gender, is_sdc, registered_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, now())) RETURNING id`,
    [tokenNo, name, gender, isSdc, registeredAt]
  );
  return r.rows[0].id;
}

async function book(candidateId, companyId, status) {
  await pool.query(
    `INSERT INTO candidate_company_status (candidate_id, company_id, status) VALUES ($1, $2, $3)`,
    [candidateId, companyId, status]
  );
}

async function main() {
  console.log('=== Insights fixture ===\n');

  const companyA = await makeCompany('__test_insights_A'); // gets posts + candidates
  const companyB = await makeCompany('__test_insights_B'); // zero candidates — the regression case
  const candidateIds = [];

  try {
    await pool.query(
      `INSERT INTO company_posts (company_id, post_title, vacancies) VALUES ($1, 'Post 1', 5), ($1, 'Post 2', 5)`,
      [companyA]
    );

    const c1 = await makeCandidate({ name: '__test i1', gender: 'Male', isSdc: true });
    const c2 = await makeCandidate({ name: '__test i2', gender: 'Female', isSdc: false });
    const c3 = await makeCandidate({ name: '__test i3', gender: null, isSdc: null }); // unknown/unknown
    candidateIds.push(c1, c2, c3);

    await book(c1, companyA, 'Selected');
    await book(c2, companyA, 'Rejected');
    await book(c3, companyA, 'Pending');

    const all = await computeInsights({});
    const a = all.companies.find((c) => c.id === companyA);
    const b = all.companies.find((c) => c.id === companyB);

    check('vacancies summed correctly despite 2 posts x 3 candidates (no fan-out)', a && a.vacancies === 10, JSON.stringify(a));
    check('assigned counts all 3 bookings', a && a.assigned === 3, JSON.stringify(a));
    check('selected/rejected/pending counted correctly', a && a.selected === 1 && a.rejected === 1 && a.pending === 1, JSON.stringify(a));
    check('gender breakdown: 1 male, 1 female, 1 unknown', a && a.male === 1 && a.female === 1 && a.gender_unknown === 1, JSON.stringify(a));
    check('sdc breakdown: 1 sdc, 1 non_sdc, 1 unknown', a && a.sdc === 1 && a.non_sdc === 1 && a.sdc_unknown === 1, JSON.stringify(a));
    check('fill_rate = selected(1)/vacancies(10) = 10%', a && a.fill_rate === 10, JSON.stringify(a));

    check('zero-candidate company: assigned=0 (regression: outer-join phantom row)', b && b.assigned === 0, JSON.stringify(b));
    check('zero-candidate company: gender_unknown=0, NOT 1 (the bug caught during manual testing)', b && b.gender_unknown === 0, JSON.stringify(b));
    check('zero-candidate company: sdc_unknown=0, NOT 1', b && b.sdc_unknown === 0, JSON.stringify(b));
    check('zero-candidate company: fill_rate is null (0 vacancies)', b && b.fill_rate === null, JSON.stringify(b));

    console.log('\n--- date scope ---');
    const c4 = await makeCandidate({ name: '__test i4', gender: 'Male', isSdc: true, registeredAt: '2099-06-01T10:00:00Z' });
    candidateIds.push(c4);
    await book(c4, companyA, 'Selected');

    const scoped = await computeInsights({ date: '2099-06-01' });
    const aScoped = scoped.companies.find((c) => c.id === companyA);
    check('date-scoped query only sees the one candidate registered that day', aScoped && aScoped.assigned === 1 && aScoped.selected === 1, JSON.stringify(aScoped));
    check('date-scoped fill_rate uses only that day\'s selected count (1/10 = 10%)', aScoped && aScoped.fill_rate === 10, JSON.stringify(aScoped));
    check('available_dates includes the seeded future date', scoped.available_dates.includes('2099-06-01'), JSON.stringify(scoped.available_dates));

    const unscopedAfter = await computeInsights({});
    const aUnscoped = unscopedAfter.companies.find((c) => c.id === companyA);
    check('unscoped query now sees all 4 candidates (3 + the future one)', aUnscoped && aUnscoped.assigned === 4, JSON.stringify(aUnscoped));
  } finally {
    await pool.query('DELETE FROM candidate_company_status WHERE candidate_id = ANY($1::int[])', [candidateIds]);
    await pool.query('DELETE FROM candidates WHERE id = ANY($1::int[])', [candidateIds]);
    await pool.query('DELETE FROM company_posts WHERE company_id = ANY($1::int[])', [[companyA, companyB]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::int[])', [[companyA, companyB]]);
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Fixture crashed:', err);
  process.exit(1);
});
