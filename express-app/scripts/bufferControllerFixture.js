// Phase 5's closed-loop exit criteria (new_architecture.md §6.2) — lib/bufferController.js
// retunes lib/pingLadder.js's "warm" ping window (beta) off on-hand vs
// B_j* = d_hat_j * (tau_bar + sigma_tau): below target widens it (pull people
// in earlier), above target narrows it back toward the baseline, and
// pingLadder.js's resolveRung() actually reads the tuned value once it's set.
// travel buffer (tau_bar + sigma_tau) is fair-wide, computed from whatever
// candidates.travel_time_minutes rows already exist in the dev DB — so this
// fixture reads the real value via getTravelBuffer() rather than assuming
// one, and only asserts things that hold for any T > 0 (see comments below).
require('dotenv').config();
const pool = require('../db');
const redis = require('../lib/redisClient');
const store = require('../lib/queueStore');
const { getTravelBuffer } = require('../lib/travelBuffer');
const { retunePingBuffer, MIN_BETA, MAX_BETA } = require('../lib/bufferController');
const { resolveRung, DEFAULT_BETA } = require('../lib/pingLadder');

let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '  — ' + detail : ''}`); }
}

async function seedCheckedInPending(companyId, n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const candRes = await pool.query(
      `INSERT INTO candidates (token_no, name, checked_in_at)
       VALUES ($1, $2, now()) RETURNING id`,
      [`__bufctl-${companyId}-${i}`, `__bufctl test ${i}`]
    );
    const candidateId = candRes.rows[0].id;
    ids.push(candidateId);
    await pool.query(
      `INSERT INTO candidate_company_status (candidate_id, company_id, status, serial)
       VALUES ($1, $2, 'Pending', $3)`,
      [candidateId, companyId, i + 1]
    );
  }
  return ids;
}

async function main() {
  const companyRes = await pool.query(
    `INSERT INTO companies (company_name, location, seats, interview_minutes)
     VALUES ('__test_bufctl_co', 'Test Hall', 2, 6)
     ON CONFLICT (company_name) DO UPDATE SET seats = 2, interview_minutes = 6
     RETURNING id`
  );
  const companyId = companyRes.rows[0].id;
  let seededIds = [];

  try {
    // A generous drain rate keeps target = rate * travelBuffer comfortably
    // above 3 for any plausible travelBuffer (fallback alone is 20min), so
    // the "onHand = 0" clamp-to-MAX_BETA assertion below holds regardless of
    // what real candidates.travel_time_minutes data happens to be seeded.
    await redis.set(`drain:${companyId}`, '1'); // 1 interview/min

    console.log('=== Part A: retunePingBuffer() clamps at the extremes ===\n');

    await redis.del(`pingbuf:${companyId}`);
    let beta = await retunePingBuffer(companyId);
    check('on_hand=0 (far below any realistic target) widens to MAX_BETA', beta === MAX_BETA, `got ${beta}`);
    check('store.getPingBuffer reflects the same value', (await store.getPingBuffer(companyId)) === MAX_BETA);

    seededIds = await seedCheckedInPending(companyId, 300); // deliberately huge on_hand
    beta = await retunePingBuffer(companyId);
    check('on_hand=300 (far above any realistic target) narrows to MIN_BETA', beta === MIN_BETA, `got ${beta}`);

    console.log('\n=== Part B: on_hand ~= target holds beta near the baseline ===\n');

    const travelBuffer = await getTravelBuffer();
    await redis.set(`drain:${companyId}`, '0.4'); // 0.4/min -> target = 0.4 * travelBuffer
    const target = 0.4 * travelBuffer;
    const targetRounded = Math.max(1, Math.round(target));

    // Reset on_hand to exactly targetRounded checked-in Pending candidates.
    await pool.query('DELETE FROM candidate_company_status WHERE candidate_id = ANY($1::int[])', [seededIds]);
    await pool.query('DELETE FROM candidates WHERE id = ANY($1::int[])', [seededIds]);
    seededIds = await seedCheckedInPending(companyId, targetRounded);

    beta = await retunePingBuffer(companyId);
    const expected = Math.min(MAX_BETA, Math.max(MIN_BETA, Math.round(DEFAULT_BETA * (target / targetRounded))));
    check('on_hand rounded to target -> beta matches the formula directly', beta === expected, `target=${target.toFixed(2)} onHand=${targetRounded} got=${beta} expected=${expected}`);
    check('and that value sits close to the DEFAULT_BETA baseline', Math.abs(beta - DEFAULT_BETA) <= 2, `beta=${beta} baseline=${DEFAULT_BETA}`);

    console.log('\n=== Part C: pingLadder.resolveRung() actually reads the tuned beta ===\n');

    // Force a case where DEFAULT_BETA would say "far" but the retuned
    // (wider) beta says "warm" — proves resolveRung consults store.getPingBuffer,
    // not just the DEFAULT_BETA constant.
    await pool.query('DELETE FROM candidate_company_status WHERE candidate_id = ANY($1::int[])', [seededIds]);
    await pool.query('DELETE FROM candidates WHERE id = ANY($1::int[])', [seededIds]);
    seededIds = [];
    await redis.set(`pingbuf:${companyId}`, '30'); // pretend a prior retune widened this company to 30
    await redis.set(`drain:${companyId}`, '1'); // 1/min
    await redis.del(`queue:${companyId}`);
    for (let i = 0; i < 6; i++) await store.enqueue(companyId, 91000 + i, i + 1); // 6 filler ranks ahead
    await store.enqueue(companyId, 91999, 100); // test candidate lands at position 6

    const candidateId = 91999;
    // Push the candidate out to position 20 -> eta = ceil(20/1) = 20min. At
    // travel=0: DEFAULT_BETA=15 says far (20 > 0+15), a widened beta=30 says
    // warm (20 <= 0+30) — only reachable if resolveRung actually reads
    // store.getPingBuffer() instead of the DEFAULT_BETA constant.
    await redis.del(`queue:${companyId}`);
    for (let i = 0; i < 20; i++) await store.enqueue(companyId, 92000 + i, i + 1); // 20 filler ranks
    await store.enqueue(companyId, candidateId, 100); // position 20

    await redis.del(`pingbuf:${companyId}`); // cold start -> resolveRung falls back to DEFAULT_BETA
    const untuned = await resolveRung({ status: 'Pending', companyId, candidateId, travelTimeMinutes: 0, seats: 2, interviewMinutes: 6 });
    check('eta=20,travel=0: untuned (DEFAULT_BETA=15) -> far (20 > 0+15)', untuned.rung === 'far', JSON.stringify(untuned));

    await redis.set(`pingbuf:${companyId}`, '30'); // simulate a prior retune widening this company
    const tuned = await resolveRung({ status: 'Pending', companyId, candidateId, travelTimeMinutes: 0, seats: 2, interviewMinutes: 6 });
    check('same candidate, retuned beta=30 -> warm (20 <= 0+30)', tuned.rung === 'warm', JSON.stringify(tuned));
  } finally {
    await pool.query('DELETE FROM candidate_company_status WHERE candidate_id = ANY($1::int[])', [seededIds]);
    await pool.query('DELETE FROM candidates WHERE id = ANY($1::int[])', [seededIds]);
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
