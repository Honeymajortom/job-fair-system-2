// Phase 3 exit criteria (new_architecture_rollout_plan.md): "a locked
// candidate who doesn't scan within the timer window decays in rank and the
// desk gets reassigned; one who scans clears the timer and the interview
// proceeds — both curl/socket-log verifiable." Part A drives that directly
// against the lib modules + a live workers/noShowWorker.js process. Part B
// needs a live server (Socket.io) to prove per-desk room isolation, so it
// talks HTTP + socket.io-client to a running `node server.js`.
require('dotenv').config();
const pool = require('../db');
const redis = require('../lib/redisClient');
const store = require('../lib/queueStore');
const dispatcher = require('../lib/queueDispatcher');
const noShowTimer = require('../lib/noShowTimer');
const { io: ioClient } = require('socket.io-client');

const API = 'http://localhost:3000';
let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '  — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeCompany(name) {
  const r = await pool.query(
    `INSERT INTO companies (company_name, location) VALUES ($1, 'Test Hall')
     ON CONFLICT (company_name) DO UPDATE SET location = EXCLUDED.location RETURNING id`,
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

async function bookCandidate(candidateId, companyId, serial) {
  const r = await pool.query(
    `INSERT INTO candidate_company_status (candidate_id, company_id, status, serial)
     VALUES ($1, $2, 'Pending', $3) RETURNING id`,
    [candidateId, companyId, serial]
  );
  await store.enqueue(companyId, candidateId, serial);
  return r.rows[0].id;
}

async function ccsRow(ccsId) {
  const r = await pool.query('SELECT status, misses, dispatched_at FROM candidate_company_status WHERE id = $1', [ccsId]);
  return r.rows[0];
}

async function partA() {
  console.log('=== Part A: no-show timer (rank decay) + confirm-arrival (timer cleared) ===\n');

  const companyId = await makeCompany('__test_desk_co');
  const c1 = await makeCandidate('__test desk c1');
  const c2 = await makeCandidate('__test desk c2');
  const ccs1 = await bookCandidate(c1.id, companyId, 1);
  const ccs2 = await bookCandidate(c2.id, companyId, 2);

  console.log('--- scenario: candidate misses the call -> rank decays, desk backfills ---');
  const d1 = await dispatcher.dispatch(companyId, 'deskP3-1');
  check('c1 dispatched', d1 && d1.candidateId === c1.id);
  const beforeMiss = await ccsRow(ccs1);
  check('dispatched_at set', !!beforeMiss.dispatched_at);

  // Real timer is 90s (§6.1) — too long for a test. Cancel it and re-arm the
  // same jobId with a short override, exactly mirroring what dispatch()
  // already armed, so the worker fires against the same real state.
  await noShowTimer.clearNoShowTimer(c1.id, companyId);
  await noShowTimer.armNoShowTimer({ candidateId: c1.id, companyId, deskId: 'deskP3-1', ccsId: ccs1, delayMsOverride: 400 });
  await sleep(1500); // give workers/noShowWorker.js (already running) time to pick it up

  const afterMiss = await ccsRow(ccs1);
  check('ccs reverted to Pending after miss', afterMiss.status === 'Pending', afterMiss.status);
  check('misses incremented to 1', afterMiss.misses === 1, String(afterMiss.misses));
  check('dispatched_at cleared', afterMiss.dispatched_at === null);
  check('c1 lock released', !(await store.isLocked(c1.id)));
  const score = await redis.zscore(`queue:${companyId}`, c1.id);
  check('c1 rank decayed +10 in the live queue (score=11: serial 1 + 10 miss)', Number(score) === 11, String(score));

  const afterBackfill = await ccsRow(ccs2);
  check('desk backfilled to c2 after the miss', afterBackfill.status === 'Dispatched');

  console.log('\n--- scenario: candidate scans in on time -> confirm-arrival clears the timer, no miss ---');
  // c2 is already dispatched (from the backfill above) — confirm arrival for it.
  const armedJob = await noShowTimer.noShowQueue.getJob(`noshow:${c2.id}:${companyId}`);
  check('no-show timer is armed for c2', !!armedJob);
  const cleared = await noShowTimer.clearNoShowTimer(c2.id, companyId);
  check('confirm-arrival cleared the timer', cleared === true);
  const stillThere = await noShowTimer.noShowQueue.getJob(`noshow:${c2.id}:${companyId}`);
  check('timer job no longer exists', !stillThere);
  await sleep(300);
  const c2AfterWait = await ccsRow(ccs2);
  check('c2 still Dispatched (no miss fired)', c2AfterWait.status === 'Dispatched');

  // cleanup
  await pool.query('DELETE FROM candidate_company_status WHERE candidate_id = ANY($1::int[])', [[c1.id, c2.id]]);
  await pool.query('DELETE FROM candidates WHERE id = ANY($1::int[])', [[c1.id, c2.id]]);
  await pool.query('DELETE FROM companies WHERE id = $1', [companyId]);
  await redis.del(`queue:${companyId}`, `drain:${companyId}`, `waiting_desks:${companyId}`, `lock:${c1.id}`, `lock:${c2.id}`);
}

function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(API, { auth: { token }, transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

async function partB() {
  console.log('\n=== Part B: desk-room-scoped Socket.io push (needs a live server) ===\n');

  const loginRes = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const login = await loginRes.json();
  check('logged in as admin for HTTP + socket auth', loginRes.status === 200 && !!login.token, JSON.stringify(login));
  const token = login.token;

  const companyId = await makeCompany('__test_room_co');
  const c1 = await makeCandidate('__test room c1');
  await bookCandidate(c1.id, companyId, 1);

  const rightSocket = await connectSocket(token);
  const wrongSocket = await connectSocket(token);
  rightSocket.emit('join-desk', { companyId, deskId: 'deskP3-right' });
  wrongSocket.emit('join-desk', { companyId, deskId: 'deskP3-wrong' });
  await sleep(200); // let the join land server-side before we trigger dispatch

  let rightGot = null, wrongGot = null;
  rightSocket.on('desk_incoming', (payload) => { rightGot = payload; });
  wrongSocket.on('desk_incoming', (payload) => { wrongGot = payload; });

  const dispatchRes = await fetch(`${API}/api/queue/desk/next`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ company_id: companyId, desk_id: 'deskP3-right' }),
  });
  const dispatchBody = await dispatchRes.json();
  check('POST /queue/desk/next dispatched c1', dispatchRes.status === 200 && dispatchBody.dispatched && dispatchBody.dispatched.candidateId === c1.id, JSON.stringify(dispatchBody));

  await sleep(400);
  check('the joined desk room received desk_incoming', rightGot && rightGot.token === c1.token, JSON.stringify(rightGot));
  check('a different desk room received nothing (room isolation)', wrongGot === null, JSON.stringify(wrongGot));

  rightSocket.close();
  wrongSocket.close();

  // cleanup
  await pool.query('DELETE FROM candidate_company_status WHERE candidate_id = $1', [c1.id]);
  await pool.query('DELETE FROM candidates WHERE id = $1', [c1.id]);
  await pool.query('DELETE FROM companies WHERE id = $1', [companyId]);
  await redis.del(`queue:${companyId}`, `drain:${companyId}`, `waiting_desks:${companyId}`, `lock:${c1.id}`);
  await noShowTimer.clearNoShowTimer(c1.id, companyId);
}

async function main() {
  await partA();
  await partB();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  await pool.end();
  redis.disconnect();
  await noShowTimer.noShowQueue.close();
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Fixture crashed:', err);
  process.exit(1);
});
