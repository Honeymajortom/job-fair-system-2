// Phase 1 exit criteria (new_architecture_rollout_plan.md): "given a fixture
// of desk-done events, the dispatcher's lock/skip/backfill behavior matches
// the sim traces — verifiable without any frontend." This script is that
// fixture: it seeds companies/candidates directly (Phase 2 will do this via
// real registration), then drives dispatch()/completeInterview() through the
// scenarios §3.2/§3.4 describe, asserting on Postgres + Redis state after each.
require('dotenv').config();
const pool = require('../db');
const redis = require('../lib/redisClient');
const store = require('../lib/queueStore');
const dispatcher = require('../lib/queueDispatcher');

let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '  — ' + detail : ''}`); }
}

async function makeCompany(name) {
  const r = await pool.query(
    `INSERT INTO companies (company_name, location) VALUES ($1, 'Test Hall')
     ON CONFLICT (company_name) DO UPDATE SET location = EXCLUDED.location
     RETURNING id`,
    [name]
  );
  return r.rows[0].id;
}

async function makeCandidate(name, { checkedIn }) {
  const tok = await pool.query("SELECT nextval('token_seq') AS n");
  const tokenNo = `T-${tok.rows[0].n}`;
  const r = await pool.query(
    `INSERT INTO candidates (token_no, name, checked_in_at)
     VALUES ($1, $2, ${checkedIn ? 'now()' : 'NULL'})
     RETURNING id`,
    [tokenNo, name]
  );
  return { id: r.rows[0].id, token: tokenNo };
}

async function bookCandidate(candidateId, companyId, serial) {
  const r = await pool.query(
    `INSERT INTO candidate_company_status (candidate_id, company_id, status, serial)
     VALUES ($1, $2, 'Pending', $3) RETURNING id`,
    [candidateId, companyId, serial]
  );
  await store.enqueue(companyId, candidateId, serial);
  return r.rows[0].id;
}

async function ccsStatus(ccsId) {
  const r = await pool.query('SELECT status FROM candidate_company_status WHERE id = $1', [ccsId]);
  return r.rows[0].status;
}

async function main() {
  console.log('=== Phase 1 fixture: queue + lock dispatcher ===\n');

  const companyA = await makeCompany('__test_TCS');
  const companyB = await makeCompany('__test_Infosys');

  const c1 = await makeCandidate('__test Priya', { checkedIn: true });   // onsite, serial 1 at A
  const c2 = await makeCandidate('__test Rahul', { checkedIn: true });   // onsite, serial 2 at A
  const c3 = await makeCandidate('__test Sneha', { checkedIn: false });  // NOT onsite, serial 3 at A — must be skipped

  const ccs1A = await bookCandidate(c1.id, companyA, 1);
  const ccs2A = await bookCandidate(c2.id, companyA, 2);
  const ccs3A = await bookCandidate(c3.id, companyA, 3);
  const ccs1B = await bookCandidate(c1.id, companyB, 1); // c1 also booked at B — used for the "race other queues" test

  console.log('--- scenario 1: skip not-onsite, lock first eligible ---');
  const d1 = await dispatcher.dispatch(companyA, 'deskA-1');
  check('dispatched c1 (lowest serial, onsite)', d1 && d1.candidateId === c1.id, JSON.stringify(d1));
  check('c1 ccs status -> Dispatched', (await ccsStatus(ccs1A)) === 'Dispatched');
  check('c1 is locked', await store.isLocked(c1.id));

  console.log('\n--- scenario 2: skip busy (locked elsewhere), keeps rank ---');
  const d2 = await dispatcher.dispatch(companyA, 'deskA-2');
  check('c1 skipped (already locked) -> c2 dispatched instead', d2 && d2.candidateId === c2.id, JSON.stringify(d2));
  const stillQueued = await store.topCandidates(companyA, 10);
  check('c3 (not onsite) still in queue, not dropped', stillQueued.includes(c3.id), stillQueued.join(','));

  console.log('\n--- scenario 3: all remaining busy/ineligible -> desk waits ---');
  const d3 = await dispatcher.dispatch(companyA, 'deskA-3');
  check('no eligible candidate -> null', d3 === null);
  const waitingA3 = await redis.sismember('waiting_desks:' + companyA, 'deskA-3');
  check('deskA-3 marked waiting', waitingA3 === 1);

  console.log('\n--- scenario 4: company B desk waits (nobody onsite there yet at first) ---');
  // c1 is the only booking at B and is currently locked at A, so B has nobody to dispatch yet.
  const dB = await dispatcher.dispatch(companyB, 'deskB-1');
  check('company B desk waits (c1 locked elsewhere)', dB === null);
  const waitingB1 = await redis.sismember('waiting_desks:' + companyB, 'deskB-1');
  check('deskB-1 marked waiting', waitingB1 === 1);

  console.log('\n--- scenario 5: completeInterview releases lock, backfills, races other queues ---');
  await dispatcher.completeInterview({ candidateId: c1.id, companyId: companyA, deskId: 'deskA-1', serviceMinutes: 6 });
  // Lock is released and immediately re-acquired for B within this same call
  // (the "race their other queues" step) — so the observable end state is
  // "locked again, but at B now," not "unlocked."
  const lockedAfter = await store.isLocked(c1.id);
  check('c1 re-locked at company B (raced into the waiting desk)', lockedAfter === true);
  check('c1 ccs at B -> Dispatched', (await ccsStatus(ccs1B)) === 'Dispatched');
  const drainA = await store.getDrainRate(companyA);
  check('drain rate recorded for company A', typeof drainA === 'number' && drainA > 0, String(drainA));
  const queueAfterA = await store.topCandidates(companyA, 10);
  check('c1 removed from company A queue (done there)', !queueAfterA.includes(c1.id), queueAfterA.join(','));
  // backfill attempt for deskA-1: only c3 is left pending at A and c3 isn't
  // onsite, so the backfill should find nobody and the desk goes back on the
  // waiting list rather than silently dropping the freed desk.
  const deskA1Waiting = await redis.sismember('waiting_desks:' + companyA, 'deskA-1');
  check('deskA-1 backfill found nobody eligible -> marked waiting', deskA1Waiting === 1);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);

  // cleanup — leave no test rows behind
  await pool.query('DELETE FROM candidate_company_status WHERE candidate_id = ANY($1::int[])', [[c1.id, c2.id, c3.id]]);
  await pool.query('DELETE FROM candidates WHERE id = ANY($1::int[])', [[c1.id, c2.id, c3.id]]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1::int[])', [[companyA, companyB]]);
  for (const cid of [companyA, companyB]) {
    await redis.del('queue:' + cid, 'drain:' + cid, 'waiting_desks:' + cid);
  }
  for (const c of [c1, c2, c3]) await redis.del('lock:' + c.id);

  await pool.end();
  redis.disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Fixture crashed:', err);
  process.exit(1);
});
