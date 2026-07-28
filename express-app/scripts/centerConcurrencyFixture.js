// fair_cycle_isolation_plan.md Phase 5 — verifies Floor/Insights never blend
// two Centers' (or two concurrent fair cycles') numbers together, now that
// concurrent active fairs are real (Phase 0) and the Nav switcher (Phase 4)
// lets an operator actually view either one in isolation. Same seed/assert/
// cleanup/exit-code convention as scripts/floorStatsFixture.js.
//
// Unlike floorStatsFixture.js, this fixture does NOT touch the real active
// fair at all — it creates two brand-new Centers, each with its own active
// fair_settings row, which uq_fair_settings_one_active_per_center (Phase 0)
// explicitly allows to coexist. That's the whole point being tested: two
// Centers' fairs running at once, with overlapping candidate identity
// (same name, same mobile number) across them.
//
// Part B below also runs lib/registerCandidate.js's *actual* registration
// path — not a raw INSERT — while both test fairs are active, to check
// whether the shared "get the active fair" lookup (still a bare
// `WHERE is_active = true ORDER BY fair_date DESC LIMIT 1`, undocumented as
// center-aware since Phase 0) behaves correctly or ambiguously under real
// concurrent-center load. This is a confirmed finding, not a hypothetical.
require('dotenv').config();
const pool = require('../db');
const redis = require('../lib/redisClient');
const registerCandidate = require('../lib/registerCandidate');
const { computeFloorStats } = require('../lib/floorStats');
const { computeInsights } = require('../lib/insights');
const bcrypt = require('bcryptjs');

const API = process.env.FIXTURE_API_URL || 'http://localhost:3000/api';

let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '  — ' + detail : ''}`); }
}

async function makeCenter(name) {
  const r = await pool.query(
    `INSERT INTO centers (name, location) VALUES ($1, 'Test Hall') RETURNING id`,
    [name]
  );
  return r.rows[0].id;
}

async function makeCompany(name, centerId) {
  const r = await pool.query(
    `INSERT INTO companies (company_name, location, seats, interview_minutes, center_id, is_open)
     VALUES ($1, 'Test Hall', 1, 6, $2, true) RETURNING id`,
    [name, centerId]
  );
  return r.rows[0].id;
}

async function makeFair(name, centerId, fairDate) {
  const r = await pool.query(
    `INSERT INTO fair_settings (fair_name, fair_date, center_id, fair_hours, is_active)
     VALUES ($1, $2, $3, 8, true) RETURNING id`,
    [name, fairDate, centerId]
  );
  return r.rows[0].id;
}

async function makeCandidate(name, mobile, fairSettingsId, { checkedIn = true } = {}) {
  const tok = await pool.query("SELECT nextval('token_seq') AS n");
  const tokenNo = `T-${tok.rows[0].n}`;
  const r = await pool.query(
    `INSERT INTO candidates (token_no, name, mobile, fair_settings_id, checked_in_at)
     VALUES ($1, $2, $3, $4, ${checkedIn ? 'now()' : 'NULL'}) RETURNING id`,
    [tokenNo, name, mobile, fairSettingsId]
  );
  return { id: r.rows[0].id, token: tokenNo };
}

async function bookCandidate(candidateId, companyId, serial, status = 'Pending') {
  await pool.query(
    `INSERT INTO candidate_company_status (candidate_id, company_id, status, serial) VALUES ($1, $2, $3, $4)`,
    [candidateId, companyId, status, serial]
  );
}

async function makeUser(username, role, centerId) {
  const hash = bcrypt.hashSync('testpass123', 4);
  const r = await pool.query(
    `INSERT INTO users (username, password_hash, role, center_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, hash, role, centerId]
  );
  return r.rows[0].id;
}

async function login(username) {
  const res = await fetch(`${API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'testpass123' }),
  });
  const body = await res.json();
  return body.token;
}

async function main() {
  console.log('=== Phase 5 fixture: Floor/Insights under real concurrent Centers ===\n');

  const centerA = await makeCenter('__cc_center_A');
  const centerB = await makeCenter('__cc_center_B');
  const companyA = await makeCompany('__cc_co_A', centerA);
  const companyB = await makeCompany('__cc_co_B', centerB);
  // Both fairs active at once, same calendar date — exactly what Phase 0's
  // per-center uq_fair_settings_one_active_per_center exists to allow.
  const fairDate = '2098-06-15';
  const fairA = await makeFair('__cc_fair_A', centerA, fairDate);
  const fairB = await makeFair('__cc_fair_B', centerB, fairDate);

  const candidateIds = [];
  const overlapMobile = '9199991111';
  let userA, userB;

  try {
    console.log('--- Part A: same name + same mobile registered under two concurrent Centers ---');
    const overlapA = await makeCandidate('Overlap Person', overlapMobile, fairA);
    const overlapB = await makeCandidate('Overlap Person', overlapMobile, fairB);
    candidateIds.push(overlapA.id, overlapB.id);
    await bookCandidate(overlapA.id, companyA, 1, 'Selected');
    await bookCandidate(overlapB.id, companyB, 1, 'Dispatched');

    const dupCheck = await pool.query('SELECT id, fair_settings_id FROM candidates WHERE mobile = $1 ORDER BY id', [overlapMobile]);
    check('same mobile number exists twice — once per Center\'s fair cycle (Phase 2\'s whole point)', dupCheck.rows.length === 2, JSON.stringify(dupCheck.rows));

    // A few more candidates per Center so the counts are non-trivial and a
    // bleed bug would visibly produce the wrong number, not just "at least 1".
    const aFiller1 = await makeCandidate('__cc A filler 1', '9100000001', fairA);
    const aFiller2 = await makeCandidate('__cc A filler 2', '9100000002', fairA);
    candidateIds.push(aFiller1.id, aFiller2.id);
    await bookCandidate(aFiller1.id, companyA, 2, 'Pending');
    await bookCandidate(aFiller2.id, companyA, 3, 'Waitlisted');

    const bFiller1 = await makeCandidate('__cc B filler 1', '9200000001', fairB);
    candidateIds.push(bFiller1.id);
    await bookCandidate(bFiller1.id, companyB, 2, 'Pending');

    // Center A: 3 candidates total (overlapA, aFiller1, aFiller2).
    // Center B: 2 candidates total (overlapB, bFiller1).
    console.log('\n--- Part A: computeFloorStats() scoped per Center ---');
    const statsA = await computeFloorStats({ centerId: centerA });
    check('Floor scoped to Center A: registered = 3 (not blended with B)', statsA.registered === 3, String(statsA.registered));
    check('Floor scoped to Center A: company list has only companyA', statsA.companies.length === 1 && statsA.companies[0].id === companyA, JSON.stringify(statsA.companies));
    check('Floor scoped to Center A: companyB never appears', !statsA.companies.some((c) => c.id === companyB));
    check('Floor scoped to Center A: response echoes center_id', statsA.center_id === centerA);

    const statsB = await computeFloorStats({ centerId: centerB });
    check('Floor scoped to Center B: registered = 2 (not blended with A)', statsB.registered === 2, String(statsB.registered));
    check('Floor scoped to Center B: company list has only companyB', statsB.companies.length === 1 && statsB.companies[0].id === companyB, JSON.stringify(statsB.companies));
    check('Floor scoped to Center B: companyA never appears', !statsB.companies.some((c) => c.id === companyA));

    // Unscoped ("all centers") view: assert the DELTA this fixture caused,
    // not an absolute number — the real dev DB has unrelated live data, so an
    // exact total would be flaky. This confirms unscoped correctly SUMS both
    // centers (no double-counting, no silent exclusion) rather than picking
    // just one arbitrarily.
    const before = await pool.query(`SELECT COUNT(*)::int AS n FROM candidates WHERE deleted_at IS NULL AND id != ALL($1::int[])`, [candidateIds]);
    const statsAll = await computeFloorStats({});
    check('Floor unscoped: registered = everyone-else + this fixture\'s 5 (sums both Centers, no bleed either direction)',
      statsAll.registered === before.rows[0].n + 5, `all=${statsAll.registered} before=${before.rows[0].n}`);
    check('Floor unscoped: both test companies appear', statsAll.companies.some((c) => c.id === companyA) && statsAll.companies.some((c) => c.id === companyB));

    console.log('\n--- Part A: computeInsights() scoped per Center ---');
    const insightsA = await computeInsights({ centerId: centerA });
    check('Insights scoped to Center A: company list has only companyA', insightsA.companies.length === 1 && insightsA.companies[0].id === companyA, JSON.stringify(insightsA.companies));
    const coRowA = insightsA.companies[0];
    check('Insights scoped to Center A: assigned = 3 (Selected+Pending+Waitlisted, not B\'s Dispatched+Pending)', coRowA.assigned === 3, JSON.stringify(coRowA));
    check('Insights scoped to Center A: selected = 1', coRowA.selected === 1, JSON.stringify(coRowA));

    const insightsB = await computeInsights({ centerId: centerB });
    check('Insights scoped to Center B: company list has only companyB', insightsB.companies.length === 1 && insightsB.companies[0].id === companyB, JSON.stringify(insightsB.companies));
    const coRowB = insightsB.companies[0];
    check('Insights scoped to Center B: assigned = 2 (not blended with A\'s 3)', coRowB.assigned === 2, JSON.stringify(coRowB));
    check('Insights scoped to Center B: dispatched = 1', coRowB.dispatched === 1, JSON.stringify(coRowB));

    console.log('\n--- Part A: live HTTP concurrency — two Center-pinned floor_managers hitting the shared /floor-stats cache at the same instant ---');
    userA = await makeUser('__cc_fm_a@sdc.com', 'floor_manager', centerA);
    userB = await makeUser('__cc_fm_b@sdc.com', 'floor_manager', centerB);
    const [tokenA, tokenB] = await Promise.all([login('__cc_fm_a@sdc.com'), login('__cc_fm_b@sdc.com')]);
    check('both test floor_managers logged in', !!tokenA && !!tokenB, `${!!tokenA} ${!!tokenB}`);

    // Fired together (Promise.all, not sequentially) so both requests land
    // inside the same cache TTL window — this is the actual regression test
    // for the redisCache keySuffix fix (Phase 4): before that fix, whichever
    // request's response got cached first would have been served back to
    // the OTHER center's floor_manager too.
    const [resA, resB] = await Promise.all([
      fetch(`${API}/floor-stats`, { headers: { Authorization: `Bearer ${tokenA}` } }).then((r) => r.json()),
      fetch(`${API}/floor-stats`, { headers: { Authorization: `Bearer ${tokenB}` } }).then((r) => r.json()),
    ]);
    check('concurrent request as Center A\'s floor_manager: sees only companyA', resA.companies.length === 1 && resA.companies[0].id === companyA, JSON.stringify(resA.companies));
    check('concurrent request as Center B\'s floor_manager: sees only companyB', resB.companies.length === 1 && resB.companies[0].id === companyB, JSON.stringify(resB.companies));
    check('concurrent responses did not cross-contaminate (different center_id)', resA.center_id !== resB.center_id, `${resA.center_id} vs ${resB.center_id}`);

    // Second wave, still inside the same cache window — proves this holds on
    // a cache HIT, not just whichever request happened to populate the cache
    // first.
    const [resA2, resB2] = await Promise.all([
      fetch(`${API}/floor-stats`, { headers: { Authorization: `Bearer ${tokenA}` } }).then((r) => r.json()),
      fetch(`${API}/floor-stats`, { headers: { Authorization: `Bearer ${tokenB}` } }).then((r) => r.json()),
    ]);
    check('cache-hit re-request as Center A: still only companyA (no cross-contamination on repeat)', resA2.companies.length === 1 && resA2.companies[0].id === companyA, JSON.stringify(resA2.companies));
    check('cache-hit re-request as Center B: still only companyB', resB2.companies.length === 1 && resB2.companies[0].id === companyB, JSON.stringify(resB2.companies));

    console.log('\n--- Part B: registerCandidate()\'s centerId param, under real concurrent-center load ---');
    console.log('  (both __cc_fair_A and __cc_fair_B are_active=true right now, alongside whatever the real Main Center fair is)');
    // This originally caught registerCandidate() having no Center parameter
    // at all (documented as a follow-up in Phase 4/5's first pass) — since
    // fixed (same session): registerCandidate() now accepts an explicit
    // centerId, and routes/candidates.js's POST /register + routes/public.js's
    // GET /qr/token + POST /qr/register all resolve and pass one. This part
    // now asserts the fix directly instead of just reporting the old gap.
    const probeA = await registerCandidate({ name: '__cc probe A', mobile: '9188887771', travel_time_minutes: 5, centerId: centerA });
    check('registerCandidate({centerId: centerA}) succeeds', probeA.status === 201, JSON.stringify(probeA.body));
    if (probeA.status === 201) {
      const row = await pool.query('SELECT id, fair_settings_id FROM candidates WHERE token_no = $1', [probeA.body.token]);
      candidateIds.push(row.rows[0].id);
      check('...and lands in fairA specifically, not an arbitrary active fair', row.rows[0].fair_settings_id === fairA, `got ${row.rows[0].fair_settings_id}, expected ${fairA}`);
    }

    const probeB = await registerCandidate({ name: '__cc probe B', mobile: '9188887772', travel_time_minutes: 5, centerId: centerB });
    check('registerCandidate({centerId: centerB}) succeeds', probeB.status === 201, JSON.stringify(probeB.body));
    if (probeB.status === 201) {
      const row = await pool.query('SELECT id, fair_settings_id FROM candidates WHERE token_no = $1', [probeB.body.token]);
      candidateIds.push(row.rows[0].id);
      check('...and lands in fairB specifically, not fairA', row.rows[0].fair_settings_id === fairB, `got ${row.rows[0].fair_settings_id}, expected ${fairB}`);
    }

    // Backward-compat check: a caller that still doesn't pass centerId at all
    // (none should exist anymore, but nothing enforces that) keeps the old
    // fallback behavior — picks *some* active fair rather than erroring —
    // instead of silently breaking callers that predate this fix.
    const probeNoCenter = await registerCandidate({ name: '__cc probe no-center', mobile: '9188887773', travel_time_minutes: 5 });
    check('registerCandidate() with no centerId still succeeds (backward-compatible fallback)', probeNoCenter.status === 201, JSON.stringify(probeNoCenter.body));
    if (probeNoCenter.status === 201) {
      const row = await pool.query('SELECT id, fair_settings_id FROM candidates WHERE token_no = $1', [probeNoCenter.body.token]);
      candidateIds.push(row.rows[0].id);
      check('...lands in *some* active fair (fallback is arbitrary-but-functional, not a crash)', row.rows[0].fair_settings_id != null, JSON.stringify(row.rows[0]));
    }

    console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  } finally {
    await pool.query('DELETE FROM candidate_company_status WHERE candidate_id = ANY($1::int[])', [candidateIds]);
    await pool.query('DELETE FROM candidates WHERE id = ANY($1::int[])', [candidateIds]);
    if (userA) await pool.query('DELETE FROM users WHERE id = $1', [userA]);
    if (userB) await pool.query('DELETE FROM users WHERE id = $1', [userB]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::int[])', [[companyA, companyB]]);
    // registerCandidate()'s Part B probe can auto-create a fair_batches row
    // via lib/batchAssignment.js's getOrCreateAvailableBatch() — has to go
    // before fair_settings itself, same FK-ordering lesson as this session's
    // earlier Phase 3 cleanup.
    await pool.query('DELETE FROM fair_batches WHERE fair_settings_id = ANY($1::int[])', [[fairA, fairB]]);
    await pool.query('DELETE FROM fair_settings WHERE id = ANY($1::int[])', [[fairA, fairB]]);
    await pool.query('DELETE FROM centers WHERE id = ANY($1::int[])', [[centerA, centerB]]);
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
