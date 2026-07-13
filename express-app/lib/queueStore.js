// Queue-system Phase 1 (new_architecture.md §7.1) — Redis primitives for the
// per-company virtual queue and the candidate lock. Postgres stays the system
// of record (candidate_company_status.serial/misses); this module is the live,
// ephemeral view the dispatcher actually reads and writes.
const redis = require('./redisClient');

const EMA_ALPHA = 0.2; // matches sim/jobfair_sim.py — same constant, same formula

const queueKey = (companyId) => `queue:${companyId}`;
const lockKey = (candidateId) => `lock:${candidateId}`;
const drainKey = (companyId) => `drain:${companyId}`;
const pingBufferKey = (companyId) => `pingbuf:${companyId}`;
const waitingDesksKey = (companyId) => `waiting_desks:${companyId}`;

// Add a candidate to company j's queue at their booking-order rank. Score =
// serial; recordMiss() bumps it +10 per missed call without ever removing
// the member, so "skip ≠ drop" (§3.2) holds by construction.
async function enqueue(companyId, candidateId, serial) {
  await redis.zadd(queueKey(companyId), serial, candidateId);
}

// Candidate is done with company j (interviewed, or removed pre-interview) —
// the only operation that actually drops them from this company's queue.
async function remove(companyId, candidateId) {
  await redis.zrem(queueKey(companyId), candidateId);
}

async function recordMiss(companyId, candidateId) {
  await redis.zincrby(queueKey(companyId), 10, candidateId);
}

// Ascending score order = rank order (lowest serial+misses first). Bounded
// scan per §7.2's sketch — we don't need the whole queue, just enough to find
// the first eligible (onsite, unlocked) candidate.
async function topCandidates(companyId, limit = 20) {
  const ids = await redis.zrange(queueKey(companyId), 0, limit - 1);
  return ids.map(Number);
}

async function queueSize(companyId) {
  return redis.zcard(queueKey(companyId));
}

// Queue-system Phase 4 (new_architecture.md §3.3) — 0-based rank among this
// company's still-queued members, or null if the candidate isn't a member
// (waitlisted, or already finished/removed via completeInterview()'s
// store.remove()). Dispatched-but-not-yet-completed candidates are still
// members here (dispatch() doesn't remove them, only completeInterview()
// does) — callers that need to distinguish "waiting" from "already called to
// a desk" should check candidate_company_status.status themselves, since
// that's the authoritative signal, not this rank.
async function getPosition(companyId, candidateId) {
  const rank = await redis.zrank(queueKey(companyId), candidateId);
  return rank === null ? null : rank;
}

// The candidate-level lock (§3.2): one desk at a time, enforced atomically.
// TTL is a safety net (a crashed desk process can't hold a candidate forever),
// not the no-show timer itself — that's Phase 3.
async function acquireLock(candidateId, deskId, ttlMs = 15 * 60 * 1000) {
  const res = await redis.set(lockKey(candidateId), deskId, 'PX', ttlMs, 'NX');
  return res === 'OK';
}

async function releaseLock(candidateId) {
  await redis.del(lockKey(candidateId));
}

async function isLocked(candidateId) {
  return (await redis.exists(lockKey(candidateId))) === 1;
}

// The desk id a candidate's lock currently points to, or null if unlocked.
// Reverse-lookup helper for "who's at desk X" — there's no desk-keyed index,
// only this candidate-keyed one, so callers scan candidates and check this.
async function getLockDesk(candidateId) {
  return redis.get(lockKey(candidateId));
}

// EMA over observed interview durations, converted to a per-minute drain
// rate — new_architecture.md §4: mu_hat <- alpha*(1/s_last) + (1-alpha)*mu_hat.
// Stored directly as the rate (not the raw EMA term) so readers don't need to
// know the formula; ETA consumers (Phase 4) just do position / drainRate.
async function updateDrainRate(companyId, serviceMinutes) {
  const key = drainKey(companyId);
  const prev = parseFloat(await redis.get(key)) || 1 / serviceMinutes;
  const next = EMA_ALPHA * (1 / serviceMinutes) + (1 - EMA_ALPHA) * prev;
  await redis.set(key, next);
  return next;
}

async function getDrainRate(companyId) {
  const v = await redis.get(drainKey(companyId));
  return v ? parseFloat(v) : null;
}

// Queue-system Phase 5's closed-loop half (new_architecture.md §6.2) — the ping-window buffer
// (beta minutes) pingLadder.js's "warm" rung uses, retuned per company by
// lib/bufferController.js. Absent until the first retune runs for a company
// (cold start); pingLadder.js falls back to its fixed default until then.
async function getPingBuffer(companyId) {
  const v = await redis.get(pingBufferKey(companyId));
  return v ? parseFloat(v) : null;
}

async function setPingBuffer(companyId, minutes) {
  await redis.set(pingBufferKey(companyId), minutes);
}

// A desk that scanned the queue and found nobody eligible sits here, idle,
// until either its own company's queue gains an eligible candidate (next
// dispatch() call for this company will pop it) or a candidate finishing
// elsewhere gets raced into it (completeInterview()'s "race other queues").
async function markDeskWaiting(companyId, deskId) {
  await redis.sadd(waitingDesksKey(companyId), deskId);
}

async function popWaitingDesk(companyId) {
  return redis.spop(waitingDesksKey(companyId));
}

async function clearDeskWaiting(companyId, deskId) {
  await redis.srem(waitingDesksKey(companyId), deskId);
}

module.exports = {
  enqueue, remove, recordMiss, topCandidates, queueSize, getPosition,
  acquireLock, releaseLock, isLocked, getLockDesk,
  updateDrainRate, getDrainRate,
  getPingBuffer, setPingBuffer,
  markDeskWaiting, popWaitingDesk, clearDeskWaiting,
};
