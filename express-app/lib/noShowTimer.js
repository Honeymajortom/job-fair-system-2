// Queue-system Phase 3 (new_architecture.md §3.4/§6.1) — the no-show timer.
// Separate BullMQ queue from lib/dispatchQueue.js's 'dispatch' queue (that
// one is v1's fixed-slot-time model, untouched until the Phase 6 cutover).
//
// Floor-awareness simplification: §6.1 specifies 90s same-floor / 180s
// cross-floor, but nothing in this schema tracks which floor a candidate or
// desk is on yet (waiting-room-per-floor infra isn't built). Every timer
// below arms at the same-floor duration unless a caller explicitly passes
// sameFloor: false — the hook is real, the floor data behind it isn't yet.
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

module.exports = { noShowQueue, armNoShowTimer, clearNoShowTimer, SAME_FLOOR_MS, CROSS_FLOOR_MS };
