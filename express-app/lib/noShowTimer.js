// Queue-system Phase 3 (new_architecture.md §3.4/§6.1) — the no-show timer.
// Separate BullMQ queue from lib/dispatchQueue.js's 'dispatch' queue (that
// one is v1's fixed-slot-time model, untouched until the Phase 6 cutover).
//
// §6.1 specifies 90s same-floor / 180s cross-floor. companies.floor_number
// is the floor data; lib/queueDispatcher.js's resolveSameFloor() derives the
// candidate's current floor from their most recently completed interview and
// passes the real sameFloor in here. A caller that omits it (fixtures, or a
// company/candidate with no floor history yet) gets the same-floor default.
require('dotenv').config();
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, enableOfflineQueue: false });
connection.on('error', (err) => console.error('[noShowTimer] Redis error:', err.message));

const noShowQueue = new Queue('noshow', { connection });

const SAME_FLOOR_MS = 90 * 1000;
const CROSS_FLOOR_MS = 180 * 1000;

const jobId = (candidateId, companyId) => `noshow:${candidateId}:${companyId}`;

// Called by dispatch() the instant a candidate is locked to a desk.
// delayMsOverride exists only for fixture tests — production callers should
// never pass it (90s/180s is the spec).
async function armNoShowTimer({ candidateId, companyId, deskId, ccsId, sameFloor = true, delayMsOverride }) {
  const delay = delayMsOverride != null ? delayMsOverride : (sameFloor ? SAME_FLOOR_MS : CROSS_FLOOR_MS);
  try {
    await noShowQueue.add('noshow', { candidateId, companyId, deskId, ccsId }, {
      jobId: jobId(candidateId, companyId),
      delay,
      removeOnComplete: true,
      removeOnFail: 100,
      attempts: 1,
    });
  } catch (err) {
    console.error(`[noShowTimer] arm failed for candidate ${candidateId} company ${companyId}:`, err.message);
  }
}

// Called on desk-QR-scan arrival confirmation — the candidate showed up
// before the timer fired, so the miss never happened. Idempotent: a job
// that already fired (or was already cleared) just isn't found.
async function clearNoShowTimer(candidateId, companyId) {
  try {
    const job = await noShowQueue.getJob(jobId(candidateId, companyId));
    if (job) await job.remove();
    return !!job;
  } catch (err) {
    console.error(`[noShowTimer] clear failed for candidate ${candidateId} company ${companyId}:`, err.message);
    return false;
  }
}

const pausedKey = (candidateId, companyId) => `noshow:paused:${candidateId}:${companyId}`;

// Company HR's Pause button (DeskTablet.jsx) — removes the armed job and
// hands back how much time was left, rather than just leaving it running
// underneath a frozen-looking UI. Stored in Redis (not Postgres) since it's
// as ephemeral as the timer job itself; a generous 1h TTL is just a safety
// net against a paused-and-forgotten key outliving the fair day.
async function pauseNoShowTimer(candidateId, companyId) {
  const job = await noShowQueue.getJob(jobId(candidateId, companyId));
  if (!job) return null;
  const remaining = Math.max(1000, job.timestamp + job.opts.delay - Date.now());
  await job.remove();
  // Total delay (job.opts.delay — the original 90s/180s this job was armed
  // with) is stored alongside remaining, not just remaining alone, so a
  // reader (getArrivalStatus below) can still compute a correct progress
  // fraction while paused, without having to re-derive same-floor/cross-floor
  // from scratch.
  await connection.set(pausedKey(candidateId, companyId), JSON.stringify({ remaining, total: job.opts.delay }), 'EX', 3600);
  return remaining;
}

// Re-arms with exactly the remaining time captured at pause — the candidate
// doesn't lose or gain arrival-window time just because it was paused.
async function resumeNoShowTimer({ candidateId, companyId, deskId, ccsId, sameFloor }) {
  const key = pausedKey(candidateId, companyId);
  const raw = await connection.get(key);
  if (raw == null) return null;
  await connection.del(key);
  const { remaining } = JSON.parse(raw);
  await armNoShowTimer({ candidateId, companyId, deskId, ccsId, sameFloor, delayMsOverride: remaining });
  return remaining;
}

// Read-only — the same arrival deadline the desk tablet's CountdownRing
// shows Company HR, exposed for the candidate's own schedule page
// (lib/pingLadder.js's 'desk_call' rung) to show the identical countdown on
// their side. Never arms/clears/mutates anything, safe to call on every
// schedule poll. Three possible shapes: actively armed (expiresAt + totalMs,
// same as queueDispatcher.js's dispatch() response), paused (pausedRemainingMs
// + totalMs, no expiresAt — there's no live deadline to count down against),
// or neither (not currently dispatched / already arrived, in which case the
// caller shouldn't render a ring at all).
async function getArrivalStatus(candidateId, companyId) {
  const job = await noShowQueue.getJob(jobId(candidateId, companyId));
  if (job) {
    return { expiresAt: new Date(job.timestamp + job.opts.delay).toISOString(), totalMs: job.opts.delay };
  }
  const raw = await connection.get(pausedKey(candidateId, companyId));
  if (raw != null) {
    const { remaining, total } = JSON.parse(raw);
    return { paused: true, pausedRemainingMs: remaining, totalMs: total };
  }
  return null;
}

module.exports = {
  noShowQueue, armNoShowTimer, clearNoShowTimer, pauseNoShowTimer, resumeNoShowTimer, getArrivalStatus, SAME_FLOOR_MS, CROSS_FLOOR_MS,
};
