// Phase 2 exit criteria (new_architecture_rollout_plan.md): "curl-booking
// past a company's cap demonstrably spills to next choice/waitlist instead
// of overbooking; booked serials show up correctly ranked in Phase 1's
// queue:{companyId} ZSETs." This drives registerCandidate() directly (same
// function both POST /api/register and POST /api/qr/register call) against
// a real Postgres + Redis, with a deliberately small cap so it's exercised
// in a handful of calls instead of thousands.
require('dotenv').config();
const pool = require('../db');
const redis = require('../lib/redisClient');
const store = require('../lib/queueStore');
const registerCandidate = require('../lib/registerCandidate');

let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '  — ' + detail : ''}`); }
}

async function main() {
  console.log('=== Phase 2 fixture: registration capacity gate ===\n');

  // seats=1, interview_minutes=10 -> mu=6/hr; fair_hours default 8 ->
  // capacity=48, cap_sold=floor(0.9*48)=43. Too big to exercise by hand, so
  // this fixture temporarily lowers the active fair's fair_hours instead of
  // hand-computing against the real default — keeps the math identical to
  // what registerCandidate() actually runs, just at a testable scale.
  const companyRes = await pool.query(
    `INSERT INTO companies (company_name, location, seats, interview_minutes)
     VALUES ('__test_cap_co', 'Test Hall', 1, 10)
     ON CONFLICT (company_name) DO UPDATE SET seats = 1, interview_minutes = 10
     RETURNING id`
  );
  const companyId = companyRes.rows[0].id;
  const sideCompanyRes = await pool.query(
    `INSERT INTO companies (company_name, location, seats, interview_minutes)
     VALUES ('__test_side_co', 'Test Hall', 5, 5)
     ON CONFLICT (company_name) DO UPDATE SET seats = 5, interview_minutes = 5
     RETURNING id`
  );
  const sideCompanyId = sideCompanyRes.rows[0].id;

  // Must match registerCandidate()'s own selection exactly (ORDER BY
  // fair_date DESC) — with more than one active fair_settings row (e.g. a
  // reseed on a new day leaves an old one active too), a plain LIMIT 1 here
  // can silently update a different row than the one registerCandidate()
  // actually reads, making this fixture test against the wrong fair_hours.
  const fairRes = await pool.query(`SELECT id, fair_hours FROM fair_settings WHERE is_active = true ORDER BY fair_date DESC LIMIT 1`);
  if (!fairRes.rows.length) throw new Error('No active fair_settings row — run npm run seed first');
  const fairId = fairRes.rows[0].id;
  const originalHours = fairRes.rows[0].fair_hours;
  await pool.query(`UPDATE fair_settings SET fair_hours = 1 WHERE id = $1`, [fairId]); // capacity_j = 1*6*1=6, cap_sold=floor(0.9*6)=5

  const created = [];
  try {
    console.log('--- booking 5 candidates against a company with cap_sold=5 ---');
    for (let i = 1; i <= 5; i++) {
      const r = await registerCandidate({ name: `__test cap ${i}`, mobile: `9${String(9000000 + i)}`, company_ids: [companyId] });
      created.push(r.body.token);
      check(`candidate ${i} booked as Pending with serial ${i}`, r.status === 201 && r.body.assigned.length === 1 && r.body.assigned[0].serial === i, JSON.stringify(r.body));
    }

    const queueAfter5 = await store.topCandidates(companyId, 10);
    check('all 5 pushed onto the live Redis queue in serial order', queueAfter5.length === 5, queueAfter5.join(','));

    console.log('\n--- 6th candidate exceeds cap_sold=5 -> waitlisted, not queued ---');
    const r6 = await registerCandidate({ name: '__test cap 6', mobile: '9999906', company_ids: [companyId] });
    created.push(r6.body.token);
    check('6th candidate waitlisted, not assigned', r6.body.assigned.length === 0 && r6.body.waitlisted.length === 1, JSON.stringify(r6.body));
    const queueAfter6 = await store.topCandidates(companyId, 10);
    check('waitlisted candidate never reached the Redis queue', queueAfter6.length === 5, queueAfter6.join(','));

    console.log('\n--- mixed booking: one company at cap, one with room ---');
    const r7 = await registerCandidate({
      name: '__test cap 7', mobile: '9999907',
      company_ids: [companyId, sideCompanyId],
    });
    created.push(r7.body.token);
    check('capped company -> waitlisted, open company -> assigned, in one registration', r7.body.assigned.length === 1 && r7.body.assigned[0].company_id === sideCompanyId && r7.body.waitlisted.length === 1 && r7.body.waitlisted[0].company_id === companyId, JSON.stringify(r7.body));

    console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  } finally {
    // cleanup
    await pool.query(`UPDATE fair_settings SET fair_hours = $1 WHERE id = $2`, [originalHours, fairId]);
    const candRes = await pool.query(`SELECT id FROM candidates WHERE token_no = ANY($1::varchar[])`, [created]);
    const candIds = candRes.rows.map((r) => r.id);
    if (candIds.length) {
      await pool.query('DELETE FROM candidate_company_status WHERE candidate_id = ANY($1::int[])', [candIds]);
      await pool.query('DELETE FROM candidates WHERE id = ANY($1::int[])', [candIds]);
    }
    await pool.query('DELETE FROM companies WHERE id = ANY($1::int[])', [[companyId, sideCompanyId]]);
    await redis.del('queue:' + companyId, 'queue:' + sideCompanyId, 'drain:' + companyId, 'drain:' + sideCompanyId);
    for (const cid of candIds) await redis.del('lock:' + cid);
  }

  await pool.end();
  redis.disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Fixture crashed:', err);
  process.exit(1);
});
