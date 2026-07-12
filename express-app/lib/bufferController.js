// Queue-system Phase 5's closed-loop half (new_architecture.md §6.2 /
// new_architecture_rollout_plan.md's Phase 5). lib/floorStats.js computes
// B_j* for display only;
// this module is the loop that actually acts on it, per the spec: "widen/
// narrow the ping window to hold B_j >= B_j*". The ping window is
// lib/pingLadder.js's "warm" rung: ping when ETA <= travel_time + beta.
// Widening beta (more lead time) pulls people in earlier when on-hand stock
// is below target; narrowing it holds people back when stock is already
// ample. sim/jobfair_sim.py's fixed BETA=15 is the un-tuned baseline this
// retunes away from per company.
const pool = require('../db');
const store = require('./queueStore');
const { MIN_DRAIN_RATE, DEFAULT_BETA } = require('./pingLadder');
const { getTravelBuffer } = require('./travelBuffer');

const MIN_BETA = 5;
const MAX_BETA = 45;

// Same on-hand definition as lib/floorStats.js: checked-in candidates still
// Pending at this company (i.e. arrived but not yet called to a desk).
async function getOnHand(companyId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM candidate_company_status ccs
       JOIN candidates cd ON cd.id = ccs.candidate_id AND cd.deleted_at IS NULL
      WHERE ccs.company_id = $1 AND ccs.status = 'Pending'
        AND cd.checked_in_at IS NOT NULL AND ccs.deleted_at IS NULL`,
    [companyId]
  );
  return r.rows[0].n;
}

// Proportional (s, S) control: beta scales inversely with on_hand/target, so
// a company running below its buffer target gets a wider come-now window
// (more lead time, more candidates enter "warm") and one sitting above
// target gets narrowed back toward the baseline. Called after every
// completeInterview() — the natural point where both drain rate (supply) and
// on-hand (stock) have just moved.
async function retunePingBuffer(companyId) {
  const companyRes = await pool.query(
    `SELECT seats, interview_minutes FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!companyRes.rows.length) return null;
  const { seats, interview_minutes } = companyRes.rows[0];

  const [onHand, drainRate, travelBuffer] = await Promise.all([
    getOnHand(companyId),
    store.getDrainRate(companyId),
    getTravelBuffer(),
  ]);

  const rate = Math.max(drainRate || (seats / interview_minutes), MIN_DRAIN_RATE);
  const target = rate * travelBuffer; // B_j*, same formula lib/floorStats.js displays

  const beta = target > 0
    ? Math.min(MAX_BETA, Math.max(MIN_BETA, Math.round(DEFAULT_BETA * (target / Math.max(onHand, 1)))))
    : DEFAULT_BETA;

  await store.setPingBuffer(companyId, beta);
  return beta;
}

module.exports = { retunePingBuffer, MIN_BETA, MAX_BETA };
