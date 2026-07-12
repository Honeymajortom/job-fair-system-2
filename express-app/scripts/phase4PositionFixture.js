// Phase 4 exit criteria (new_architecture_rollout_plan.md, ping ladder groundwork):
// queueStore.getPosition() ranks correctly, lib/pingLadder.js's rung precedence
// resolves the ladder's five bands at the documented boundaries, and
// GET /api/qr/schedule/:token actually surfaces position/eta_minutes/rung for
// serial-based bookings (and omits them for waitlisted ones) over a live HTTP
// server. Part A/B are lib-level (no server needed); Part C needs `node server.js`
// already running.
require('dotenv').config();
const pool = require('../db');
const redis = require('../lib/redisClient');
const store = require('../lib/queueStore');
const { resolveRung } = require('../lib/pingLadder');
const registerCandidate = require('../lib/registerCandidate');

const API = 'http://localhost:3000';
let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '  — ' + detail : ''}`); }
}

async function partA_position() {
  console.log('=== Part A: queueStore.getPosition() ===\n');

  const companyRes = await pool.query(
    `INSERT INTO companies (company_name, location, seats, interview_minutes)
     VALUES ('__test_pos_co', 'Test Hall', 1, 6)
     ON CONFLICT (company_name) DO UPDATE SET seats = 1, interview_minutes = 6
     RETURNING id`
  );
  const companyId = companyRes.rows[0].id;
  const candidateIds = [90001, 90002, 90003, 90004, 90005];

  try {
    for (let i = 0; i < candidateIds.length; i++) {
      await store.enqueue(companyId, candidateIds[i], i + 1);
    }

    check('rank 0 for the first-serial candidate', (await store.getPosition(companyId, candidateIds[0])) === 0);
    check('rank 2 for the third-serial candidate', (await store.getPosition(companyId, candidateIds[2])) === 2);
    check('rank 4 for the last-serial candidate', (await store.getPosition(companyId, candidateIds[4])) === 4);
    check('null rank for a candidate never enqueued here', (await store.getPosition(companyId, 999999)) === null);

    await store.recordMiss(companyId, candidateIds[0]);
    check('a miss decays rank — candidate 1 drops behind the others', (await store.getPosition(companyId, candidateIds[0])) === 4);

    await store.remove(companyId, candidateIds[1]);
    check('removed candidate has no rank', (await store.getPosition(companyId, candidateIds[1])) === null);
  } finally {
    await redis.del(`queue:${companyId}`);
    await pool.query('DELETE FROM companies WHERE id = $1', [companyId]);
  }
}

async function partB_rungPrecedence() {
  console.log('\n=== Part B: lib/pingLadder.js rung precedence at boundary values ===\n');

  const companyRes = await pool.query(
    `INSERT INTO companies (company_name, location, seats, interview_minutes)
     VALUES ('__test_rung_co', 'Test Hall', 1, 6)
     ON CONFLICT (company_name) DO UPDATE SET seats = 1, interview_minutes = 6
     RETURNING id`
  );
  const companyId = companyRes.rows[0].id;
  const candidateId = 90100;

  try {
    // done statuses short-circuit regardless of queue state
    for (const status of ['Selected', 'Rejected', 'Shortlisted', 'Hold', 'No_Show']) {
      const r = await resolveRung({ status, companyId, candidateId, travelTimeMinutes: null, seats: 1, interviewMinutes: 6 });
      check(`status=${status} -> rung 'done', no position/eta`, r.rung === 'done' && r.position === null && r.eta_minutes === null, JSON.stringify(r));
    }

    const dispatched = await resolveRung({ status: 'Dispatched', companyId, candidateId, travelTimeMinutes: null, seats: 1, interviewMinutes: 6 });
    check("status=Dispatched -> rung 'desk_call', position 0", dispatched.rung === 'desk_call' && dispatched.position === 0, JSON.stringify(dispatched));

    // Pending candidate at known ranks — boundary values position=3 and position=5
    await store.enqueue(companyId, candidateId, 1); // will occupy rank 0; we push filler ahead of it to land it at the target rank
    await redis.del(`queue:${companyId}`);
    for (let i = 0; i < 3; i++) await store.enqueue(companyId, 80000 + i, i + 1); // 3 fillers ranked ahead
    await store.enqueue(companyId, candidateId, 100); // candidate lands at rank 3 (0-based) = position 3
    let r = await resolveRung({ status: 'Pending', companyId, candidateId, travelTimeMinutes: null, seats: 1, interviewMinutes: 6 });
    check('position exactly 3 -> rung staging (boundary, inclusive)', r.position === 3 && r.rung === 'staging', JSON.stringify(r));

    await redis.del(`queue:${companyId}`);
    for (let i = 0; i < 5; i++) await store.enqueue(companyId, 80000 + i, i + 1); // 5 fillers ranked ahead
    await store.enqueue(companyId, candidateId, 100); // candidate lands at rank 5 (0-based) = position 5
    r = await resolveRung({ status: 'Pending', companyId, candidateId, travelTimeMinutes: null, seats: 1, interviewMinutes: 6 });
    check('position exactly 5 -> rung gate (boundary, inclusive)', r.position === 5 && r.rung === 'gate', JSON.stringify(r));

    await redis.del(`queue:${companyId}`);
    for (let i = 0; i < 6; i++) await store.enqueue(companyId, 80000 + i, i + 1); // 6 fillers ranked ahead -> candidate at position 6, past gate/staging
    await store.enqueue(companyId, candidateId, 100);
    await store.updateDrainRate(companyId, 6); // 1 interview per 6 minutes -> rate ~= 1/6/min after EMA settle; force a clean rate instead:
    await redis.set(`drain:${companyId}`, '1'); // 1 interview/minute -> eta_minutes = ceil(6/1) = 6
    r = await resolveRung({ status: 'Pending', companyId, candidateId, travelTimeMinutes: 0, seats: 1, interviewMinutes: 6 });
    check('position 6, eta 6min, travel 0min -> eta<=travel+15 -> warm', r.position === 6 && r.eta_minutes === 6 && r.rung === 'warm', JSON.stringify(r));

    r = await resolveRung({ status: 'Pending', companyId, candidateId, travelTimeMinutes: null, seats: 1, interviewMinutes: 6 });
    check('position 6, unknown travel time -> never reaches warm, stays far', r.rung === 'far', JSON.stringify(r));

    await redis.set(`drain:${companyId}`, '0.5'); // 0.5 interviews/min -> eta = ceil(6/0.5) = 12min
    r = await resolveRung({ status: 'Pending', companyId, candidateId, travelTimeMinutes: 0, seats: 1, interviewMinutes: 6 });
    check('eta exactly travel+15 boundary (eta=12 <= 0+15) -> warm', r.eta_minutes === 12 && r.rung === 'warm', JSON.stringify(r));
  } finally {
    await redis.del(`queue:${companyId}`, `drain:${companyId}`);
    await pool.query('DELETE FROM companies WHERE id = $1', [companyId]);
  }
}

async function partC_httpSchedule() {
  console.log('\n=== Part C: GET /api/qr/schedule/:token over a live server ===\n');

  const companyRes = await pool.query(
    `INSERT INTO companies (company_name, location, seats, interview_minutes)
     VALUES ('__test_sched_co', 'Test Hall', 1, 10)
     ON CONFLICT (company_name) DO UPDATE SET seats = 1, interview_minutes = 10
     RETURNING id`
  );
  const companyId = companyRes.rows[0].id;

  const fairRes = await pool.query(`SELECT id, fair_hours FROM fair_settings WHERE is_active = true ORDER BY fair_date DESC LIMIT 1`);
  if (!fairRes.rows.length) throw new Error('No active fair_settings row — run npm run seed first');
  const fairId = fairRes.rows[0].id;
  const originalHours = fairRes.rows[0].fair_hours;
  await pool.query(`UPDATE fair_settings SET fair_hours = 1 WHERE id = $1`, [fairId]); // capacity=1*6*1=6, cap_sold=floor(0.9*6)=5

  const created = [];
  try {
    console.log('--- register 5 to fill the cap, then a 6th to waitlist ---');
    for (let i = 1; i <= 5; i++) {
      const r = await registerCandidate({ name: `__test sched ${i}`, mobile: `9${8000000 + i}`, company_ids: [companyId], travel_time_minutes: 20 });
      created.push(r.body.token);
    }
    const waitlistedReg = await registerCandidate({ name: '__test sched 6', mobile: '98000006', company_ids: [companyId], travel_time_minutes: 20 });
    created.push(waitlistedReg.body.token);
    check('6th candidate landed on the waitlist', waitlistedReg.body.waitlisted.length === 1, JSON.stringify(waitlistedReg.body));

    const firstToken = created[0];
    const res = await fetch(`${API}/api/qr/schedule/${firstToken}`);
    const body = await res.json();
    check('schedule endpoint 200s', res.status === 200, JSON.stringify(body));
    const slot = body.slots.find((s) => s.company === '__test_sched_co');
    check('assigned candidate carries position/eta_minutes/rung', slot && typeof slot.position === 'number' && typeof slot.eta_minutes === 'number' && typeof slot.rung === 'string', JSON.stringify(slot));
    check('first-serial candidate is at position 0', slot.position === 0, JSON.stringify(slot));

    const waitRes = await fetch(`${API}/api/qr/schedule/${waitlistedReg.body.token}`);
    const waitBody = await waitRes.json();
    const waitSlot = waitBody.slots.find((s) => s.company === '__test_sched_co');
    check('waitlisted candidate omits position/eta_minutes/rung', waitSlot && waitSlot.position === undefined && waitSlot.rung === undefined, JSON.stringify(waitSlot));

    const companiesRes = await fetch(`${API}/api/qr/companies`);
    const companiesBody = await companiesRes.json();
    const co = companiesBody.find((c) => c.id === companyId);
    check('GET /api/qr/companies carries a live queue_depth', co && co.queue_depth === 5, JSON.stringify(co));
  } finally {
    await pool.query(`UPDATE fair_settings SET fair_hours = $1 WHERE id = $2`, [originalHours, fairId]);
    const candRes = await pool.query(`SELECT id FROM candidates WHERE token_no = ANY($1::varchar[])`, [created]);
    const candIds = candRes.rows.map((r) => r.id);
    if (candIds.length) {
      await pool.query('DELETE FROM candidate_company_status WHERE candidate_id = ANY($1::int[])', [candIds]);
      await pool.query('DELETE FROM candidates WHERE id = ANY($1::int[])', [candIds]);
    }
    await pool.query('DELETE FROM companies WHERE id = $1', [companyId]);
    await redis.del(`queue:${companyId}`, `drain:${companyId}`);
    for (const cid of candIds) await redis.del(`lock:${cid}`);
  }
}

async function main() {
  await partA_position();
  await partB_rungPrecedence();
  try {
    await partC_httpSchedule();
  } catch (err) {
    console.log(`\n  FAIL Part C crashed — is 'node server.js' running on :3000? (${err.message})`);
    fail++;
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
