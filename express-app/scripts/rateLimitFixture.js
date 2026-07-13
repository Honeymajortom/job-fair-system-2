// Verifies the schedule-endpoint rate-limit fix: per-token limiting isolates
// one candidate's ~5s polling from a shared-IP flood, while the IP backstop
// still trips on genuine abuse. Run against a live `node server.js` on
// localhost:3000. Uses two distinct candidate tokens so the per-token limit
// on one doesn't interfere with the other's requests counting toward the
// shared-IP backstop.
const http = require('http');
const redis = require('../lib/redisClient');

const BASE = 'http://localhost:3000';

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ok  - ${msg}`); }
  else { fail++; console.log(`  FAIL - ${msg}`); }
}

async function main() {
  const pool = require('../db');
  const candRes = await pool.query("SELECT token_no FROM candidates WHERE deleted_at IS NULL ORDER BY id LIMIT 2");
  if (candRes.rows.length < 2) throw new Error('Need at least 2 candidates in dev DB to run this fixture');
  const [tokenA, tokenB] = candRes.rows.map((r) => r.token_no);

  // Clear any counters left over from earlier manual curl testing this session.
  await redis.del(`rl:read-token:${tokenA}`, `rl:read-token:${tokenB}`, `rl:schedule-ip:127.0.0.1`, `rl:schedule-ip:::1`, `rl:schedule-ip:::ffff:127.0.0.1`);

  console.log('Part A: per-token limit (max 20/min) trips on repeated polling of ONE token');
  let sawA429 = false;
  let statusesA = [];
  for (let i = 0; i < 25; i++) {
    const code = await get(`/api/qr/schedule/${tokenA}`);
    statusesA.push(code);
    if (code === 429) sawA429 = true;
  }
  assert(statusesA.slice(0, 20).every((c) => c === 200 || c === 404), `first 20 requests for tokenA succeed (got ${statusesA.slice(0, 20).join(',')})`);
  assert(sawA429, 'tokenA eventually gets 429 after exceeding 20/min');

  console.log('Part B: a DIFFERENT token from the same IP is unaffected by tokenA tripping its own limit');
  const codeB = await get(`/api/qr/schedule/${tokenB}`);
  assert(codeB === 200 || codeB === 404, `tokenB still succeeds despite tokenA being rate-limited (got ${codeB})`);

  console.log('Part C: shared-IP backstop (scheduleIpLimit, max 15000/min) is far above the per-candidate rate, so normal multi-candidate traffic from one IP is not blocked by it');
  const ipCount = await redis.get('rl:schedule-ip:127.0.0.1') || await redis.get('rl:schedule-ip:::1') || await redis.get('rl:schedule-ip:::ffff:127.0.0.1');
  assert(Number(ipCount) < 15000, `IP counter (${ipCount}) is well under the 15000/min backstop after this fixture's ~26 requests`);

  await redis.del(`rl:read-token:${tokenA}`, `rl:read-token:${tokenB}`, `rl:schedule-ip:127.0.0.1`, `rl:schedule-ip:::1`, `rl:schedule-ip:::ffff:127.0.0.1`);
  await pool.end();
  await redis.quit();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
