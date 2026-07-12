// Queue-system Phase 4 (new_architecture.md §3.3) — resolves a candidate's
// position/ETA/rung for one company booking. Pulled out of routes/public.js
// so it's independently testable (scripts/phase4PositionFixture.js) and
// reusable if another surface ever needs the same ladder logic.
const store = require('./queueStore');

// Order matters: booking outcomes (done/desk_call) short-circuit before the
// position-based bands, and position bands (staging/gate) are checked before
// the ETA-based "warm" check so the "≈5" gate threshold never has to fight
// the staging one.
const DONE_STATUSES = ['Selected', 'Rejected', 'Shortlisted', 'Hold', 'No_Show'];
const MIN_DRAIN_RATE = 0.05; // floor so a cold/misconfigured company can't divide-by-near-zero into an infinite ETA
const DEFAULT_BETA = 15; // sim/jobfair_sim.py's fixed BETA — used until lib/bufferController.js has retuned this company at least once

async function resolveRung({ status, companyId, candidateId, travelTimeMinutes, seats, interviewMinutes }) {
  if (DONE_STATUSES.includes(status)) return { position: null, eta_minutes: null, rung: 'done' };
  if (status === 'Dispatched') return { position: 0, eta_minutes: 0, rung: 'desk_call' };

  const position = await store.getPosition(companyId, candidateId);
  if (position === null) return { position: null, eta_minutes: null, rung: 'far' };

  const [drainRate, pingBuffer] = await Promise.all([
    store.getDrainRate(companyId),
    store.getPingBuffer(companyId),
  ]);
  const rate = Math.max(drainRate || (seats / interviewMinutes), MIN_DRAIN_RATE);
  const eta_minutes = Math.ceil(position / rate);
  const beta = pingBuffer != null ? pingBuffer : DEFAULT_BETA;

  let rung = 'far';
  if (position <= 3) rung = 'staging';
  else if (position <= 5) rung = 'gate';
  else if (travelTimeMinutes != null && eta_minutes <= travelTimeMinutes + beta) rung = 'warm';

  return { position, eta_minutes, rung };
}

module.exports = { resolveRung, DONE_STATUSES, MIN_DRAIN_RATE, DEFAULT_BETA };
