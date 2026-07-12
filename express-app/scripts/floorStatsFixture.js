// Phase 5 fixture: exercises lib/floorStats.js's computeFloorStats() against
// real Postgres + Redis state, following the same seed/assert/cleanup/exit-
// code convention as scripts/queueDispatcherFixture.js.
//
// One wrinkle this fixture has that the earlier ones don't: computeFloorStats
// reads "the active fair" (fair_settings WHERE is_active=true ORDER BY
// fair_date DESC LIMIT 1 — same query registerCandidate.js/phase4Position
// Fixture.js already use) to derive a closing time for the starvation check.
// db/schema.sql's uq_fair_settings_one_active partial unique index now
// forbids two is_active=true rows at once, so this fixture can no longer
// just insert a second active row alongside the real one (see handoff.md's
// fair_settings fix) — it temporarily deactivates whichever real row is
// active, seeds its own with a far-future fair_date (2099-01-01), and
// restores the original in `finally` either way.
require('dotenv').config();
const pool = require('../db');
const redis = require('../lib/redisClient');
const store = require('../lib/queueStore');
const dispatcher = require('../lib/queueDispatcher');
const { computeFloorStats } = require('../lib/floorStats');

let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '  — ' + detail : ''}`); }
}

async function makeCompany(name, { seats = 1, interviewMinutes = 6 } = {}) {
  const r = await pool.query(
    `INSERT INTO companies (company_name, location, seats, interview_minutes)
     VALUES ($1, 'Test Hall', $2, $3)
     ON CONFLICT (company_name) DO UPDATE SET seats = EXCLUDED.seats, interview_minutes = EXCLUDED.interview_minutes
     RETURNING id`,
    [name, seats, interviewMinutes]
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

async function bookCandidate(candidateId, companyId, serial, status = 'Pending') {
  const r = await pool.query(
    `INSERT INTO candidate_company_status (candidate_id, company_id, status, serial) VALUES ($1, $2, $3, $4) RETURNING id`,
    [candidateId, companyId, status, serial]
  );
  if (status === 'Pending') await store.enqueue(companyId, candidateId, serial);
  return r.rows[0].id;
}

async function main() {
  console.log('=== Phase 5 fixture: floor stats (buffer target + starvation) ===\n');

  const testFairDate = '2099-01-01';
  const realActiveRes = await pool.query(`UPDATE fair_settings SET is_active = false WHERE is_active = true RETURNING id`);
  const realActiveIds = realActiveRes.rows.map((r) => r.id);
  const fairRes = await pool.query(
    `INSERT INTO fair_settings (fair_name, fair_date, fair_hours, is_active)
     VALUES ('__test_floor_fixture', $1, 2, true) RETURNING id`,
    [testFairDate]
  );
  const fairSettingsId = fairRes.rows[0].id;
  // Arrived 90 min ago, fair_hours=2 -> closes in ~30 min from now.
  const arrival = new Date(Date.now() - 90 * 60 * 1000);
  const batchRes = await pool.query(
    `INSERT INTO fair_batches (fair_date, batch_number, arrival_time, status) VALUES ($1, 1, $2, 'active') RETURNING id`,
    [testFairDate, arrival]
  );
  const fairBatchId = batchRes.rows[0].id;

  // Company A: gets a real drain rate via one completed interview, kept
  // under the starvation threshold -> should NOT alert.
  // Company B: never completes an interview (falls back to seats/interview_
  // minutes), heavily overbooked -> SHOULD alert.
  const companyA = await makeCompany('__test_floor_A', { seats: 1, interviewMinutes: 6 });
  const companyB = await makeCompany('__test_floor_B', { seats: 1, interviewMinutes: 6 });
  const candidateIds = [];

  try {
    // --- Company A: 2 on-hand (checked-in, Pending), 1 dispatched+completed.
    // completeInterview() immediately backfills the freed desk from the same
    // queue (§7.2 "race their other queues"), so a 3rd on-hand candidate is
    // seeded to absorb that backfill and leave exactly 2 still Pending.
    const aOnHand1 = await makeCandidate('__test A-onhand-1', { checkedIn: true });
    const aOnHand2 = await makeCandidate('__test A-onhand-2', { checkedIn: true });
    const aOnHand3 = await makeCandidate('__test A-onhand-3', { checkedIn: true });
    const aDone = await makeCandidate('__test A-done', { checkedIn: true });
    candidateIds.push(aOnHand1.id, aOnHand2.id, aOnHand3.id, aDone.id);
    // aDone gets the lowest serial so dispatch() (lowest-serial-first) picks
    // it first; aOnHand1 (next-lowest) absorbs the post-completion backfill.
    const ccsADone = await bookCandidate(aDone.id, companyA, 1);
    await bookCandidate(aOnHand1.id, companyA, 2);
    await bookCandidate(aOnHand2.id, companyA, 3);
    await bookCandidate(aOnHand3.id, companyA, 4);

    const dA = await dispatcher.dispatch(companyA, 'deskA-1');
    check('company A: dispatch locked the lowest-serial candidate', dA && dA.candidateId === aDone.id, JSON.stringify(dA));
    await pool.query(`UPDATE candidate_company_status SET status = 'Selected', processed_at = now() WHERE id = $1`, [ccsADone]);
    await dispatcher.completeInterview({ candidateId: aDone.id, companyId: companyA, deskId: 'deskA-1', serviceMinutes: 6 });
    const drainA = await store.getDrainRate(companyA);
    check('company A: real drain rate recorded', typeof drainA === 'number' && drainA > 0, String(drainA));

    // --- Company B: 1 on-hand (locked at a desk, so still "now serving"),
    // 40 more Pending+checked-in -> remaining is huge relative to the
    // seats/interview_minutes fallback rate over ~30 minutes.
    const bDesk = await makeCandidate('__test B-desk', { checkedIn: true });
    candidateIds.push(bDesk.id);
    await bookCandidate(bDesk.id, companyB, 1);
    const dB = await dispatcher.dispatch(companyB, 'deskB-9');
    check('company B: dispatch locked a candidate for the now-serving board', dB && dB.candidateId === bDesk.id, JSON.stringify(dB));

    for (let i = 0; i < 40; i++) {
      const c = await makeCandidate(`__test B-wait-${i}`, { checkedIn: true });
      candidateIds.push(c.id);
      await bookCandidate(c.id, companyB, 10 + i);
    }

    const stats = await computeFloorStats();

    check('stat tiles are all numbers', ['registered', 'at_desk', 'completed', 'waitlisted', 'needs_attention'].every((k) => typeof stats[k] === 'number'), JSON.stringify(stats).slice(0, 200));

    const aRow = stats.companies.find((c) => c.id === companyA);
    check('company A appears in buffer rows', !!aRow);
    check('company A on_hand is exactly the 2 seeded checked-in Pending', aRow && aRow.on_hand === 2, JSON.stringify(aRow));
    check('company A target (B_j*) is a positive number', aRow && aRow.target > 0, JSON.stringify(aRow));

    const bRow = stats.companies.find((c) => c.id === companyB);
    check('company B appears in buffer rows', !!bRow, JSON.stringify(bRow));

    const nowServingB = stats.now_serving.find((r) => r.token === bDesk.token);
    check('now-serving board resolves company B\'s locked desk id', nowServingB && nowServingB.desk_id === 'deskB-9', JSON.stringify(stats.now_serving));

    const alertB = stats.alerts.find((a) => a.company_id === companyB);
    check('company B triggers a starvation alert (overbooked, no drain rate)', !!alertB, JSON.stringify(stats.alerts));
    const alertA = stats.alerts.find((a) => a.company_id === companyA);
    check('company A does not trigger a starvation alert (small backlog, real drain rate)', !alertA, JSON.stringify(stats.alerts));

    console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  } finally {
    await pool.query('DELETE FROM candidate_company_status WHERE candidate_id = ANY($1::int[])', [candidateIds]);
    await pool.query('DELETE FROM candidates WHERE id = ANY($1::int[])', [candidateIds]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::int[])', [[companyA, companyB]]);
    await pool.query('DELETE FROM fair_batches WHERE id = $1', [fairBatchId]);
    await pool.query('DELETE FROM fair_settings WHERE id = $1', [fairSettingsId]);
    if (realActiveIds.length) {
      await pool.query('UPDATE fair_settings SET is_active = true WHERE id = ANY($1::int[])', [realActiveIds]);
    }
    for (const cid of [companyA, companyB]) {
      await redis.del('queue:' + cid, 'drain:' + cid, 'waiting_desks:' + cid);
    }
    for (const cid of candidateIds) await redis.del('lock:' + cid);
  }

  await pool.end();
  redis.disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Fixture crashed:', err);
  process.exit(1);
});
