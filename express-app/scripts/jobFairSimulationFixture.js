// Whole job-fair simulation — 5 fictional companies, 20 candidates, each
// randomly booking 1-3 of them, driven end-to-end through the REAL HTTP API
// (not direct SQL for the candidate journey itself): registration -> Gate
// check-in -> self-service company selection -> desk dispatch/interview loop
// (random Selected/Rejected/Shortlisted/Hold/No_Show outcomes, with the
// "I'm on my way" tap along the way) -> post-fair feedback -> end-of-cycle
// archive. Runs against its own throwaway Center so it never touches the
// real active fair or real candidates.
//
// Unlike the narrower fixtures (centerConcurrencyFixture.js etc.), this one
// deliberately uses *random* company picks and outcomes each run — the
// assertions are written as invariants checked against what the run actually
// produced (tracked in JS as we go), not hand-picked expected numbers, so the
// randomness is real coverage rather than a source of flakiness.
//
// Same seed/assert/cleanup/exit-code convention as scripts/
// centerConcurrencyFixture.js.
require('dotenv').config();
const pool = require('../db');
const redis = require('../lib/redisClient');
const bcrypt = require('bcryptjs');
const { computeFloorStats } = require('../lib/floorStats');
const { computeInsights } = require('../lib/insights');

const API = process.env.FIXTURE_API_URL || 'http://localhost:3000/api';

let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '  — ' + detail : ''}`); }
}

async function req(method, path, { token, body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function login(username, password = 'testpass123') {
  const { body } = await req('POST', '/login', { body: { username, password } });
  return body.token;
}

const COMPANIES = [
  { name: 'Nimbus Cloudworks', seats: 1, interview_minutes: 45, floor_number: 1 },
  { name: 'Solstice Robotics', seats: 1, interview_minutes: 20, floor_number: 1 },
  { name: 'Vantage Analytics', seats: 2, interview_minutes: 15, floor_number: 2 },
  { name: 'Emberlight Studios', seats: 1, interview_minutes: 30, floor_number: 2 },
  { name: 'Halcyon BioTech', seats: 3, interview_minutes: 10, floor_number: 3 },
];
const FAIR_HOURS = 3;
const NUM_CANDIDATES = 20;
const QUALIFICATIONS = ['B.Tech', 'B.Sc', 'MBA', 'Diploma', 'M.Tech'];
const GENDERS = ['Male', 'Female', 'Other'];
const OUTCOMES = ['Selected', 'Rejected', 'Shortlisted', 'Hold'];
const DONE_STATUSES = ['Selected', 'Rejected', 'Shortlisted', 'Hold', 'No_Show'];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

function pickCompanies(companies) {
  const n = randInt(1, 3);
  const pool_ = [...companies];
  const picked = [];
  for (let i = 0; i < n && pool_.length; i++) picked.push(pool_.splice(randInt(0, pool_.length - 1), 1)[0]);
  return picked;
}

function bookingCap(seats, interviewMinutes) {
  return Math.floor(seats * (60 / interviewMinutes) * FAIR_HOURS * 0.9);
}

async function main() {
  console.log('=== Whole job-fair simulation: 5 companies, 20 candidates, full journey ===\n');

  const centerRes = await pool.query(`INSERT INTO centers (name, location) VALUES ('__sim_center', 'Simulation Hall') RETURNING id`);
  const centerId = centerRes.rows[0].id;

  const companies = [];
  for (const c of COMPANIES) {
    const r = await pool.query(
      `INSERT INTO companies (company_name, location, floor_number, seats, interview_minutes, center_id, is_open)
       VALUES ($1, 'Simulation Hall', $2, $3, $4, $5, true) RETURNING id`,
      [c.name, c.floor_number, c.seats, c.interview_minutes, centerId]
    );
    companies.push({ ...c, id: r.rows[0].id, cap: bookingCap(c.seats, c.interview_minutes), results: { Selected: 0, Rejected: 0, Shortlisted: 0, Hold: 0, No_Show: 0 } });
  }
  console.log('Companies:', companies.map((c) => `${c.name} (seats ${c.seats}, ${c.interview_minutes}min, cap ${c.cap})`).join(' | '), '\n');

  const fairDate = '2098-01-01'; // far future — never collides with real dev data
  const fairRes = await pool.query(
    `INSERT INTO fair_settings (fair_name, fair_date, center_id, fair_hours, batch_size, batch_interval_minutes, is_active)
     VALUES ('__sim_fair', $1, $2, $3, 100, 15, true) RETURNING id`,
    [fairDate, centerId, FAIR_HOURS]
  );
  const fairId = fairRes.rows[0].id;

  const hash = bcrypt.hashSync('testpass123', 4);
  const regUserRes = await pool.query(
    `INSERT INTO users (username, password_hash, role, center_id) VALUES ('__sim_reg@sdc.com', $1, 'registration_staff', $2) RETURNING id`,
    [hash, centerId]
  );
  const regUserId = regUserRes.rows[0].id;

  const candidateIds = [];

  try {
    const adminToken = await login('admin', 'admin123');
    check('admin logged in', !!adminToken);
    const regToken = await login('__sim_reg@sdc.com');
    check('registration_staff logged in', !!regToken);

    console.log('\n--- Gate: mint entrance QR (registration_staff, auto-pinned to sim center) ---');
    const qrRes = await req('GET', '/qr/token', { token: regToken });
    check('QR token minted for sim center', qrRes.status === 200 && !!qrRes.body.qr_token, JSON.stringify(qrRes.body));
    const qrToken = qrRes.body.qr_token;

    console.log('\n--- Registration: 20 candidates (each a distinct simulated device, so the L2 device rate-limit sees 20 phones, not 1) ---');
    const candidates = [];
    for (let i = 1; i <= NUM_CANDIDATES; i++) {
      const payload = {
        qr_token: qrToken,
        name: `Sim Candidate ${String(i).padStart(2, '0')}`,
        mobile: `97000000${String(i).padStart(2, '0')}`,
        age: randInt(20, 30),
        qualification: rand(QUALIFICATIONS),
        gender: rand(GENDERS),
        is_sdc: Math.random() < 0.4,
        travel_time_minutes: randInt(5, 60),
      };
      const r = await req('POST', '/qr/register', { body: payload, cookie: `qr_device=__sim_device_${i}` });
      if (r.status !== 201) { check(`register candidate ${i}`, false, JSON.stringify(r.body)); continue; }
      candidates.push({ i, name: payload.name, token: r.body.token, qr: r.body.qr, checkedIn: false, companies: [] });
    }
    check('all 20 candidates registered', candidates.length === NUM_CANDIDATES, `${candidates.length}/${NUM_CANDIDATES}`);

    const idRows = await pool.query('SELECT id, token_no FROM candidates WHERE token_no = ANY($1::text[])', [candidates.map((c) => c.token)]);
    const idByToken = new Map(idRows.rows.map((r) => [r.token_no, r.id]));
    for (const c of candidates) { c.id = idByToken.get(c.token); if (c.id) candidateIds.push(c.id); }

    console.log('\n--- Gate: check in 19 of 20 (one stays a no-show-at-gate) ---');
    const noShowAtGate = candidates[candidates.length - 1];
    for (const c of candidates) {
      if (c === noShowAtGate) continue;
      const r = await req('POST', '/batch/check-in', { token: regToken, body: { qr: c.qr } });
      if (r.status !== 200) check(`check in ${c.name}`, false, JSON.stringify(r.body));
      else c.checkedIn = true;
    }
    check('19 candidates checked in', candidates.filter((c) => c.checkedIn).length === NUM_CANDIDATES - 1);

    console.log('\n--- Candidate self-service: random 1-3 company picks each ---');
    for (const c of candidates) {
      const picks = pickCompanies(companies);
      const r = await req('POST', `/qr/select-companies/${c.qr}`, { body: { company_ids: picks.map((p) => p.id) } });
      if (c === noShowAtGate) {
        check(`${c.name} (never checked in) is blocked from selecting companies`, r.status === 403, JSON.stringify(r.body));
        continue;
      }
      if (r.status !== 201) { check(`${c.name} selects companies`, false, JSON.stringify(r.body)); continue; }
      c.companies = picks.map((p) => p.name);
      c.assignedIds = new Set(r.body.assigned.map((a) => a.company_id));
      c.waitlistedIds = new Set(r.body.waitlisted.map((a) => a.company_id));
    }
    console.log('Picks:', candidates.filter((c) => c !== noShowAtGate).map((c) => `${c.name}: ${c.companies.join(', ') || '(none)'}`).join(' | '));

    console.log('\n--- Booking-cap invariant: non-waitlisted bookings per company never exceed capacity ---');
    for (const co of companies) {
      const counts = await pool.query(
        `SELECT status, COUNT(*)::int AS n FROM candidate_company_status WHERE company_id = $1 GROUP BY status`,
        [co.id]
      );
      const byStatus = Object.fromEntries(counts.rows.map((r) => [r.status, r.n]));
      const nonWaitlisted = Object.entries(byStatus).filter(([s]) => s !== 'Waitlisted').reduce((a, [, n]) => a + n, 0);
      check(`${co.name}: non-waitlisted bookings (${nonWaitlisted}) <= cap (${co.cap})`, nonWaitlisted <= co.cap, JSON.stringify(byStatus));
    }

    console.log("\n--- Desk simulation: drain every company's queue, one random outcome per candidate ---");
    const byToken = new Map(candidates.map((c) => [c.token, c]));
    for (const co of companies) {
      let rounds = 0;
      while (rounds++ < NUM_CANDIDATES + 2) { // hard cap so a dispatch bug can't hang the fixture
        const next = await req('POST', '/queue/desk/next', { token: adminToken, body: { company_id: co.id, desk_id: '1' } });
        const occ = next.body.dispatched;
        if (!occ) break;
        const cand = byToken.get(occ.token);

        // "I'm on my way" tap — pure notification, harmless either way.
        if (cand) await req('POST', `/qr/acknowledge/${cand.qr}`, {});

        const outcome = Math.random() < 0.15 ? 'No_Show' : rand(OUTCOMES);
        if (outcome === 'No_Show') {
          const r = await req('POST', '/no-show', { token: adminToken, body: { token: occ.token, company_id: co.id } });
          check(`${cand ? cand.name : occ.token} @ ${co.name}: no-show recorded`, r.status === 200, JSON.stringify(r.body));
        } else {
          const confirm = await req('POST', '/queue/confirm-arrival', { token: adminToken, body: { token: occ.token, company_id: co.id } });
          check(`${cand ? cand.name : occ.token} @ ${co.name}: arrival confirmed`, confirm.status === 200, JSON.stringify(confirm.body));
          const result = await req('PUT', '/interview-result', {
            token: adminToken,
            body: { token: occ.token, company_id: co.id, status: outcome, ratings: {}, feedback_text: `Simulated ${outcome.toLowerCase()} outcome.` },
          });
          check(`${cand ? cand.name : occ.token} @ ${co.name}: result recorded (${outcome})`, result.status === 200, JSON.stringify(result.body));
        }
        co.results[outcome]++;
      }
      console.log(`  ${co.name}: drained after ${rounds - 1} dispatch(es) — ${JSON.stringify(co.results)}`);
    }

    console.log('\n--- Post-fair feedback: only candidates whose every booking has settled ---');
    let feedbackSubmitted = 0;
    for (const c of candidates) {
      if (!c.checkedIn) continue;
      const rows = await pool.query('SELECT status FROM candidate_company_status WHERE candidate_id = $1 AND deleted_at IS NULL', [c.id]);
      if (!rows.rows.length || !rows.rows.every((r) => DONE_STATUSES.includes(r.status))) continue;
      const r = await req('POST', `/qr/feedback/${c.qr}`, {
        body: {
          venue_rating: randInt(3, 5), process_rating: randInt(3, 5), staff_rating: randInt(3, 5), overall_rating: randInt(3, 5),
          interested_in_sdc: Math.random() < 0.5,
        },
      });
      check(`${c.name}: feedback submitted`, r.status === 200, JSON.stringify(r.body));
      if (r.status === 200) feedbackSubmitted++;
    }
    console.log(`  ${feedbackSubmitted} candidate(s) submitted feedback (every booking settled)`);

    console.log('\n--- Cross-check: computeInsights()/computeFloorStats() against what the run actually produced ---');
    const insights = await computeInsights({ centerId });
    const floor = await computeFloorStats({ centerId });

    check('floorStats.registered = 20', floor.registered === NUM_CANDIDATES, String(floor.registered));
    check('floorStats.companies has all 5 sim companies', floor.companies.length === companies.length, String(floor.companies.length));

    for (const co of companies) {
      const iRow = insights.companies.find((r) => r.id === co.id);
      const fRow = floor.companies.find((r) => r.id === co.id);
      check(`${co.name}: insights.selected matches tracked outcome`, iRow.selected === co.results.Selected, `got ${iRow.selected}, expected ${co.results.Selected}`);
      check(`${co.name}: insights.rejected matches tracked outcome`, iRow.rejected === co.results.Rejected, `got ${iRow.rejected}, expected ${co.results.Rejected}`);
      check(`${co.name}: insights.shortlisted matches tracked outcome`, iRow.shortlisted === co.results.Shortlisted, `got ${iRow.shortlisted}, expected ${co.results.Shortlisted}`);
      check(`${co.name}: insights.hold matches tracked outcome`, iRow.hold === co.results.Hold, `got ${iRow.hold}, expected ${co.results.Hold}`);
      check(`${co.name}: insights.no_show matches tracked outcome`, iRow.no_show === co.results.No_Show, `got ${iRow.no_show}, expected ${co.results.No_Show}`);
      check(`${co.name}: insights.pending is 0 after full drain`, iRow.pending === 0, `got ${iRow.pending}`);
      check(`${co.name}: insights.dispatched is 0 after full drain`, iRow.dispatched === 0, `got ${iRow.dispatched}`);
      check(`${co.name}: floorStats.completed matches (selected+rejected+shortlisted+hold)`, fRow.completed === co.results.Selected + co.results.Rejected + co.results.Shortlisted + co.results.Hold, `got ${fRow.completed}`);
      check(`${co.name}: floorStats.remaining is just the waitlist (no Pending/Dispatched left)`, fRow.remaining === iRow.waitlisted, `remaining=${fRow.remaining} waitlisted=${iRow.waitlisted}`);
    }

    console.log('\n--- Cross-check: the same numbers over real HTTP, as admin (not just the direct compute functions) ---');
    const httpFloor = await req('GET', `/floor-stats?center_id=${centerId}`, { token: adminToken });
    check('GET /floor-stats (HTTP) matches computeFloorStats() directly', httpFloor.status === 200 && httpFloor.body.registered === floor.registered && httpFloor.body.companies.length === floor.companies.length, JSON.stringify(httpFloor.body.registered));
    const httpInsights = await req('GET', `/insights?center_id=${centerId}`, { token: adminToken });
    check('GET /insights (HTTP) matches computeInsights() directly', httpInsights.status === 200 && httpInsights.body.totals.assigned === insights.totals.assigned, JSON.stringify(httpInsights.body.totals));

    console.log('\n--- End of cycle: end the fair, then archive it ---');
    const endRes = await req('PUT', `/fair-settings/${fairId}`, { token: adminToken, body: { is_active: false } });
    check('fair ended (is_active -> false)', endRes.status === 200 && endRes.body.is_active === false, JSON.stringify(endRes.body));
    const archiveRes = await req('POST', `/fair-settings/${fairId}/archive`, { token: adminToken });
    check(`archive purged all ${NUM_CANDIDATES} candidates`, archiveRes.status === 200 && archiveRes.body.archived === NUM_CANDIDATES, JSON.stringify(archiveRes.body));
    const postArchive = await pool.query('SELECT COUNT(*)::int AS n FROM candidates WHERE fair_settings_id = $1', [fairId]);
    check('candidates table actually empty for this fair post-archive', postArchive.rows[0].n === 0, String(postArchive.rows[0].n));

    console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  } finally {
    // Archive should have already purged candidates/bookings — this is a
    // defensive backstop in case an earlier assertion threw before that step.
    await pool.query('DELETE FROM candidate_company_status WHERE candidate_id = ANY($1::int[])', [candidateIds]);
    await pool.query('DELETE FROM candidates WHERE id = ANY($1::int[])', [candidateIds]);
    await pool.query('DELETE FROM users WHERE id = $1', [regUserId]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::int[])', [companies.map((c) => c.id)]);
    await pool.query('DELETE FROM fair_batches WHERE fair_settings_id = $1', [fairId]);
    await pool.query('DELETE FROM fair_settings WHERE id = $1', [fairId]);
    await pool.query('DELETE FROM centers WHERE id = $1', [centerId]);
    for (const co of companies) {
      await redis.del('queue:' + co.id, 'drain:' + co.id, 'waiting_desks:' + co.id);
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
