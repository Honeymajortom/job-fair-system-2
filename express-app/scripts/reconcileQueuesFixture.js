// Verification fixture for scripts/reconcileQueues.js — proves the recovery
// tool actually reconstructs a flushed company queue from Postgres correctly,
// and that its dry-run / skip-unless-healthy / --force guards behave as
// documented. Not part of the build-order fixture suite; ad hoc companion
// to reconcileQueues.js only.
require('dotenv').config();
const pool = require('../db');
const redis = require('../lib/redisClient');
const store = require('../lib/queueStore');
const { reconcileQueues } = require('./reconcileQueues');

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

async function makeCandidate(name) {
  const tok = await pool.query("SELECT nextval('token_seq') AS n");
  const tokenNo = `T-${tok.rows[0].n}`;
  const r = await pool.query(
    `INSERT INTO candidates (token_no, name, checked_in_at) VALUES ($1, $2, now()) RETURNING id`,
    [tokenNo, name]
  );
  return { id: r.rows[0].id, token: tokenNo };
}

async function book(candidateId, companyId, { serial, status = 'Pending', misses = 0 }) {
  const r = await pool.query(
    `INSERT INTO candidate_company_status (candidate_id, company_id, status, serial, misses)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [candidateId, companyId, status, serial, misses]
  );
  return r.rows[0].id;
}

async function zmembers(companyId) {
  // [member, score, member, score, ...] -> { candidateId: score }
  const flat = await redis.zrange(`queue:${companyId}`, 0, -1, 'WITHSCORES');
  const out = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = parseFloat(flat[i + 1]);
  return out;
}

async function main() {
  console.log('=== reconcileQueues fixture ===\n');

  const companyA = await makeCompany('__test_reconcile_A'); // will be "crashed" (flushed)
  const companyB = await makeCompany('__test_reconcile_B'); // stays populated, but with a stale score to prove --force

  const c1 = await makeCandidate('__test RQ Asha');   // A, Pending, serial 1, no misses -> score 1
  const c2 = await makeCandidate('__test RQ Bhanu');  // A, Pending, serial 2, 1 miss -> score 12
  const c3 = await makeCandidate('__test RQ Chetan'); // A, Dispatched, serial 3, no misses -> score 3
  const c4 = await makeCandidate('__test RQ Deepa');  // A, Selected -> must NOT be reconciled
  const c5 = await makeCandidate('__test RQ Esha');   // A, Waitlisted, no serial -> must NOT be reconciled
  const cB1 = await makeCandidate('__test RQ Feroz'); // B, Pending, serial 1 -> correct score 1, but seeded wrong (999) to prove force fixes it

  await book(c1.id, companyA, { serial: 1, status: 'Pending', misses: 0 });
  await book(c2.id, companyA, { serial: 2, status: 'Pending', misses: 1 });
  await book(c3.id, companyA, { serial: 3, status: 'Dispatched', misses: 0 });
  await book(c4.id, companyA, { serial: 4, status: 'Selected', misses: 0 });
  await book(c5.id, companyA, { serial: null, status: 'Waitlisted', misses: 0 });
  await book(cB1.id, companyB, { serial: 1, status: 'Pending', misses: 0 });

  // Pre-crash Redis state: A gets correctly enqueued, then we simulate a flush
  // of just A's key. B gets seeded with a deliberately wrong score (999
  // instead of 1) to prove --force actually corrects a "healthy but stale"
  // queue, and that without --force it's left untouched.
  await store.enqueue(companyA, c1.id, 1);
  await store.enqueue(companyA, c2.id, 12);
  await store.enqueue(companyA, c3.id, 3);
  await store.enqueue(companyB, cB1.id, 999);

  await redis.del(`queue:${companyA}`); // simulate the crash/flush for company A only

  try {
    console.log('--- dry run ---');
    const dry = await reconcileQueues({ apply: false, force: false });
    const dryA = dry.find((e) => e.companyId === companyA);
    const dryB = dry.find((e) => e.companyId === companyB);

    check('dry run finds company A', !!dryA);
    check('company A candidateCount excludes Selected/Waitlisted -> 3', dryA && dryA.candidateCount === 3, JSON.stringify(dryA));
    check('company A pendingCount=2, dispatchedCount=1', dryA && dryA.pendingCount === 2 && dryA.dispatchedCount === 1, JSON.stringify(dryA));
    check('company A existingMembers=0 (flushed)', dryA && dryA.existingMembers === 0);
    check('company A action = would-rebuild', dryA && dryA.action === 'would-rebuild');
    check('company B existingMembers=1 (still populated)', dryB && dryB.existingMembers === 1);
    check('company B action = skip-healthy-queue (no --force)', dryB && dryB.action === 'skip-healthy-queue');

    const afterDryA = await zmembers(companyA);
    const afterDryB = await zmembers(companyB);
    check('dry run wrote nothing to company A', Object.keys(afterDryA).length === 0, JSON.stringify(afterDryA));
    check('dry run left company B untouched (still stale 999)', afterDryB[cB1.id] === 999, JSON.stringify(afterDryB));

    console.log('\n--- apply (no --force) ---');
    const applied = await reconcileQueues({ apply: true, force: false });
    const appliedA = applied.find((e) => e.companyId === companyA);
    const appliedB = applied.find((e) => e.companyId === companyB);
    check('company A action = rebuilt', appliedA && appliedA.action === 'rebuilt');
    check('company B action = skip-healthy-queue (still no --force)', appliedB && appliedB.action === 'skip-healthy-queue');

    const rebuiltA = await zmembers(companyA);
    check('company A has exactly c1,c2,c3', Object.keys(rebuiltA).length === 3
      && rebuiltA[c1.id] !== undefined && rebuiltA[c2.id] !== undefined && rebuiltA[c3.id] !== undefined,
      JSON.stringify(rebuiltA));
    check('c1 score = serial(1) + 10*misses(0) = 1', rebuiltA[c1.id] === 1, JSON.stringify(rebuiltA));
    check('c2 score = serial(2) + 10*misses(1) = 12', rebuiltA[c2.id] === 12, JSON.stringify(rebuiltA));
    check('c3 score = serial(3) + 10*misses(0) = 3 (Dispatched, still reconciled)', rebuiltA[c3.id] === 3, JSON.stringify(rebuiltA));
    check('c4 (Selected) not in rebuilt queue', rebuiltA[c4.id] === undefined, JSON.stringify(rebuiltA));
    check('c5 (Waitlisted) not in rebuilt queue', rebuiltA[c5.id] === undefined, JSON.stringify(rebuiltA));

    const stillStaleB = await zmembers(companyB);
    check('company B still stale (untouched without --force)', stillStaleB[cB1.id] === 999, JSON.stringify(stillStaleB));

    console.log('\n--- apply --force ---');
    const forced = await reconcileQueues({ apply: true, force: true });
    const forcedB = forced.find((e) => e.companyId === companyB);
    check('company B action = force-overwrote', forcedB && forcedB.action === 'force-overwrote');

    const fixedB = await zmembers(companyB);
    check('company B corrected to exactly cB1 with score 1', Object.keys(fixedB).length === 1 && fixedB[cB1.id] === 1, JSON.stringify(fixedB));

    console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  } finally {
    const allCandidateIds = [c1.id, c2.id, c3.id, c4.id, c5.id, cB1.id];
    await pool.query('DELETE FROM candidate_company_status WHERE candidate_id = ANY($1::int[])', [allCandidateIds]);
    await pool.query('DELETE FROM candidates WHERE id = ANY($1::int[])', [allCandidateIds]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::int[])', [[companyA, companyB]]);
    await redis.del(`queue:${companyA}`, `queue:${companyB}`);

    await pool.end();
    redis.disconnect();
  }
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Fixture crashed:', err);
  process.exit(1);
});
