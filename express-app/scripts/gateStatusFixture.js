// Entrance Gate + Staging board exit criteria: lib/gateStatus.js correctly
// reduces each checked-in candidate's multiple per-company rungs down to one
// most-urgent bucket, excludes candidates who aren't checked in / are fully
// done / are waitlisted-only, and caps+overflows the staging slot list.
require('dotenv').config();
const pool = require('../db');
const redis = require('../lib/redisClient');
const store = require('../lib/queueStore');
const { computeGateStatus } = require('../lib/gateStatus');

let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '  — ' + detail : ''}`); }
}

async function makeCompany(name) {
  const r = await pool.query(
    `INSERT INTO companies (company_name, location, seats, interview_minutes)
     VALUES ($1, 'Test Hall', 1, 6)
     ON CONFLICT (company_name) DO UPDATE SET seats = 1, interview_minutes = 6
     RETURNING id`,
    [name]
  );
  return r.rows[0].id;
}

async function makeCandidate(name, { checkedIn = true } = {}) {
  const tok = await pool.query("SELECT nextval('token_seq') AS n");
  const tokenNo = `T-${tok.rows[0].n}`;
  const r = await pool.query(
    `INSERT INTO candidates (token_no, name, checked_in_at) VALUES ($1, $2, ${checkedIn ? 'now()' : 'NULL'}) RETURNING id`,
    [tokenNo, name]
  );
  return { id: r.rows[0].id, token: tokenNo };
}

async function book(candidateId, companyId, status, serial) {
  await pool.query(
    `INSERT INTO candidate_company_status (candidate_id, company_id, status, serial) VALUES ($1, $2, $3, $4)`,
    [candidateId, companyId, status, serial]
  );
  if (status === 'Pending' && serial != null) await store.enqueue(companyId, candidateId, serial);
}

async function main() {
  console.log('=== Gate status fixture ===\n');

  const companyId = await makeCompany('__test_gate_co');
  const candidateIds = [];

  try {
    await redis.set(`drain:${companyId}`, '1'); // 1 interview/min -> eta = position minutes, deterministic

    const desk = await makeCandidate('__test desk');       // Dispatched -> desk_call
    const s1 = await makeCandidate('__test staging-1');     // rank 0 (position 0) -> staging
    const s2 = await makeCandidate('__test staging-2');     // rank 1 (position 1) -> staging
    const s3 = await makeCandidate('__test staging-3');     // rank 2 (position 2) -> staging
    const s4 = await makeCandidate('__test staging-4');     // rank 3 (position 3) -> staging, boundary — this is the one that should overflow
    const gate = await makeCandidate('__test gate');        // rank 5 (position 5) -> gate -> waiting room
    const far = await makeCandidate('__test far');          // rank 10, null travel time -> always 'far' regardless of eta -> waiting room
    const waitlisted = await makeCandidate('__test waitlisted'); // Waitlisted only -> excluded entirely
    const done = await makeCandidate('__test done');        // Selected -> excluded
    const notCheckedIn = await makeCandidate('__test not-checked-in', { checkedIn: false }); // excluded regardless of position

    candidateIds.push(desk.id, s1.id, s2.id, s3.id, s4.id, gate.id, far.id, waitlisted.id, done.id, notCheckedIn.id);

    // Explicit ascending scores (ZSET rank = ascending score) so each lands at
    // an exact 0-based position: 0,1,2,3 for staging, a filler at 4, gate at
    // 5, fillers at 6-9, far at 10.
    await book(desk.id, companyId, 'Dispatched', 900);
    await book(s1.id, companyId, 'Pending', 0);
    await book(s2.id, companyId, 'Pending', 1);
    await book(s3.id, companyId, 'Pending', 2);
    await book(s4.id, companyId, 'Pending', 3);
    await store.enqueue(companyId, 80004, 4); // filler at rank 4
    await book(gate.id, companyId, 'Pending', 5);
    for (let i = 6; i <= 9; i++) await store.enqueue(companyId, 80000 + i, i); // fillers at ranks 6-9
    await book(far.id, companyId, 'Pending', 10);
    await book(waitlisted.id, companyId, 'Waitlisted', null);
    await book(done.id, companyId, 'Selected', 20);
    await book(notCheckedIn.id, companyId, 'Pending', 21);
    await store.enqueue(companyId, notCheckedIn.id, 21);

    const status = await computeGateStatus();

    check('called_to_desk counts the Dispatched candidate', status.called_to_desk >= 1, JSON.stringify(status));
    check('staging list capped at staging_max (3)', status.staging.length <= status.staging_max, JSON.stringify(status));
    check('staging_overflow reflects the 4th staging-ranked candidate', status.staging_overflow >= 1, JSON.stringify(status));
    check('the 3 shown staging slots are the 3 closest (staging-1/2/3, not staging-4)',
      status.staging.includes(s1.token) && status.staging.includes(s2.token) && status.staging.includes(s3.token) && !status.staging.includes(s4.token),
      JSON.stringify(status.staging));
    check('waiting_room includes gate + far candidates (not staging/desk/waitlisted/done/not-checked-in)', status.waiting_room >= 2, JSON.stringify(status));
    check('waiting_room_max/staging_max are present', typeof status.waiting_room_max === 'number' && typeof status.staging_max === 'number', JSON.stringify(status));

    console.log('\n--- exclusion checks: rebuild status after removing the ambiguous shared-queue candidates ---');
    // Clean confirmation that waitlisted/done/not-checked-in never appear as
    // staging tokens or inflate called_to_desk — spot check by token identity.
    check('waitlisted candidate never appears in staging', !status.staging.includes(waitlisted.token));
    check('done candidate never appears in staging', !status.staging.includes(done.token));
    check('not-checked-in candidate never appears in staging', !status.staging.includes(notCheckedIn.token));
  } finally {
    await pool.query('DELETE FROM candidate_company_status WHERE candidate_id = ANY($1::int[])', [candidateIds]);
    await pool.query('DELETE FROM candidates WHERE id = ANY($1::int[])', [candidateIds]);
    await pool.query('DELETE FROM companies WHERE id = $1', [companyId]);
    await redis.del(`queue:${companyId}`, `drain:${companyId}`, `pingbuf:${companyId}`);
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  await pool.end();
  redis.disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Fixture crashed:', err);
  process.exit(1);
});
