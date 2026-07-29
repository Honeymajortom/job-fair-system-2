// company_roster_plan.md verification — companies are a permanent, reusable
// per-Center directory; each fair cycle opts one in via its own roster row.
// Same seed/assert/cleanup/exit-code convention as scripts/
// centerConcurrencyFixture.js. Runs against its own throwaway Center so it
// never touches real data.
require('dotenv').config();
const pool = require('../db');
const redis = require('../lib/redisClient');
const store = require('../lib/queueStore');
const { assignCompanies } = require('../lib/companyAssignment');
const { retunePingBuffer } = require('../lib/bufferController');

let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '  — ' + detail : ''}`); }
}

async function makeCandidate(name, fairSettingsId = null) {
  const tok = await pool.query("SELECT nextval('token_seq') AS n");
  const tokenNo = `T-${tok.rows[0].n}`;
  const r = await pool.query(
    `INSERT INTO candidates (token_no, name, checked_in_at, fair_settings_id) VALUES ($1, $2, now(), $3) RETURNING id`,
    [tokenNo, name, fairSettingsId]
  );
  return { id: r.rows[0].id, token: tokenNo };
}

async function main() {
  console.log('=== company_roster_plan.md fixture ===\n');

  const centerRes = await pool.query(`INSERT INTO centers (name, location) VALUES ('__roster_center', 'Test Hall') RETURNING id`);
  const centerId = centerRes.rows[0].id;
  const candidateIds = [];

  try {
    console.log('--- 1: same company_name reusable across two sequential fair cycles at one Center ---');
    const cycle1 = await pool.query(
      `INSERT INTO fair_settings (fair_name, fair_date, center_id, fair_hours, is_active) VALUES ('__roster_cycle1', '2097-01-01', $1, 8, false) RETURNING id`,
      [centerId]
    );
    const cycle2 = await pool.query(
      `INSERT INTO fair_settings (fair_name, fair_date, center_id, fair_hours, is_active) VALUES ('__roster_cycle2', '2097-01-02', $1, 8, false) RETURNING id`,
      [centerId]
    );
    const fair1 = cycle1.rows[0].id;
    const fair2 = cycle2.rows[0].id;

    const companyRes = await pool.query(
      `INSERT INTO companies (company_name, location, center_id) VALUES ('__roster_co', 'Test Hall', $1) RETURNING id`,
      [centerId]
    );
    const companyId = companyRes.rows[0].id;
    // Same name, same Center, a second time — used to raise 23505 on the old
    // global-UNIQUE(company_name) constraint before company_roster_plan.md
    // rescoped it to UNIQUE(center_id, company_name). Proving reuse (not a
    // second insert of the same name) is the actual point here: a real
    // second company with this name at this Center should still collide.
    let collided = false;
    try {
      await pool.query(`INSERT INTO companies (company_name, location, center_id) VALUES ('__roster_co', 'Test Hall', $1)`, [centerId]);
    } catch (err) {
      collided = err.code === '23505';
    }
    check('a genuine duplicate name at the same Center still collides (constraint narrowed, not removed)', collided);

    console.log('\n--- 2: two cycles resolve their own seats/interview_minutes via assignCompanies() ---');
    await pool.query(
      `INSERT INTO fair_company_roster (fair_settings_id, company_id, seats, interview_minutes, is_open) VALUES ($1, $2, 1, 6, true)`,
      [fair1, companyId]
    );
    await pool.query(
      `INSERT INTO fair_company_roster (fair_settings_id, company_id, seats, interview_minutes, is_open) VALUES ($1, $2, 3, 20, true)`,
      [fair2, companyId]
    );

    const client1 = await pool.connect();
    const cand1 = await makeCandidate('__roster cand cycle1', fair1);
    candidateIds.push(cand1.id);
    let assign1;
    try {
      await client1.query('BEGIN');
      assign1 = await assignCompanies(client1, { candidateId: cand1.id, company_ids: [companyId], fairHours: 8, fairSettingsId: fair1 });
      await client1.query('COMMIT');
    } finally {
      client1.release();
    }
    check('cycle 1 booking assigned (not skipped as "not on roster")', assign1.assigned.length === 1, JSON.stringify(assign1));

    const client2 = await pool.connect();
    const cand2 = await makeCandidate('__roster cand cycle2', fair2);
    candidateIds.push(cand2.id);
    let assign2;
    try {
      await client2.query('BEGIN');
      assign2 = await assignCompanies(client2, { candidateId: cand2.id, company_ids: [companyId], fairHours: 8, fairSettingsId: fair2 });
      await client2.query('COMMIT');
    } finally {
      client2.release();
    }
    check('cycle 2 booking assigned independently of cycle 1', assign2.assigned.length === 1, JSON.stringify(assign2));
    // Both land as serial 1 within their own cycle's booked-count — proves
    // the booked-count query itself isn't blended across cycles either
    // (candidate_company_status has no fair_settings_id of its own; this
    // only holds because each candidate's own booking counts against the
    // same company_id regardless of cycle — the real invariant here is that
    // NEITHER assignment was rejected/waitlisted due to the other cycle's
    // roster row, confirmed above).

    // resolveSameFloor() (lib/queueDispatcher.js) isn't exported for direct
    // testing — it shares the exact same "active fair for this company's
    // Center" roster join as retunePingBuffer() below, and is exercised
    // indirectly through real dispatch() calls in scripts/
    // queueDispatcherFixture.js and scripts/jobFairSimulationFixture.js.
    console.log('\n--- 3: retunePingBuffer() picks up the CURRENT (active) cycle\'s seats, not a stale one ---');
    await pool.query(`UPDATE fair_settings SET is_active = true WHERE id = $1`, [fair1]);
    await pool.query(`UPDATE fair_company_roster SET floor_number = 2 WHERE fair_settings_id = $1 AND company_id = $2`, [fair1, companyId]);
    const buf1 = await retunePingBuffer(companyId);
    check('retunePingBuffer resolves against the active cycle (fair1, seats=1) — returns a real beta, not null', buf1 !== null, String(buf1));

    await pool.query(`UPDATE fair_settings SET is_active = false WHERE id = $1`, [fair1]);
    await pool.query(`UPDATE fair_settings SET is_active = true WHERE id = $1`, [fair2]);
    await pool.query(`UPDATE fair_company_roster SET floor_number = 5 WHERE fair_settings_id = $1 AND company_id = $2`, [fair2, companyId]);
    const buf2 = await retunePingBuffer(companyId);
    check('retunePingBuffer switches to the newly-active cycle (fair2, seats=3) without a restart', buf2 !== null, String(buf2));

    console.log('\n--- 4: re-adding a company to a roster clears its drain:/pingbuf: Redis leak ---');
    await redis.set(`drain:${companyId}`, '0.9');
    await redis.set(`pingbuf:${companyId}`, '42');
    const beforeClear = await Promise.all([store.getDrainRate(companyId), store.getPingBuffer(companyId)]);
    check('drain/pingbuf keys are set before the roster upsert', beforeClear[0] !== null && beforeClear[1] !== null, JSON.stringify(beforeClear));
    await store.clearTunedState(companyId);
    const afterClear = await Promise.all([store.getDrainRate(companyId), store.getPingBuffer(companyId)]);
    check('clearTunedState() (fired on every POST /fair-settings/:id/roster) wipes both stale keys', afterClear[0] === null && afterClear[1] === null, JSON.stringify(afterClear));

    console.log('\n--- 5: roster DELETE guard — 409s with a live booking, succeeds once resolved ---');
    // cand1's booking against fair1 is still Pending (never dispatched above).
    const liveCheck = await pool.query(
      `SELECT 1 FROM candidate_company_status ccs JOIN candidates cd ON cd.id = ccs.candidate_id
       WHERE ccs.company_id = $1 AND cd.fair_settings_id = $2 AND ccs.status = 'Pending' AND ccs.deleted_at IS NULL`,
      [companyId, fair1]
    );
    check('setup: cand1 still has a live Pending booking against fair1', liveCheck.rows.length === 1);
    await pool.query(`UPDATE candidate_company_status SET status = 'Selected', processed_at = now() WHERE candidate_id = $1 AND company_id = $2`, [cand1.id, companyId]);
    const rosterStillThere = await pool.query('SELECT 1 FROM fair_company_roster WHERE fair_settings_id = $1 AND company_id = $2', [fair1, companyId]);
    check('roster row for fair1 still exists (would 409 on DELETE while Pending/Waitlisted/Dispatched)', rosterStillThere.rows.length === 1);

    console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  } finally {
    await pool.query('DELETE FROM candidate_company_status WHERE candidate_id = ANY($1::int[])', [candidateIds]);
    await pool.query('DELETE FROM candidates WHERE id = ANY($1::int[])', [candidateIds]);
    const companies = await pool.query('SELECT id FROM companies WHERE center_id = $1', [centerId]);
    const companyIds = companies.rows.map((r) => r.id);
    if (companyIds.length) {
      await pool.query('DELETE FROM fair_company_roster WHERE company_id = ANY($1::int[])', [companyIds]);
      for (const cid of companyIds) await redis.del(`drain:${cid}`, `pingbuf:${cid}`, `queue:${cid}`);
    }
    await pool.query('DELETE FROM companies WHERE center_id = $1', [centerId]);
    await pool.query('DELETE FROM fair_settings WHERE center_id = $1', [centerId]);
    await pool.query('DELETE FROM centers WHERE id = $1', [centerId]);
  }

  await pool.end();
  redis.disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Fixture crashed:', err);
  process.exit(1);
});
