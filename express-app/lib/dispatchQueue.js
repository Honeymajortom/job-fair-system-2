require('dotenv').config();
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// maxRetriesPerRequest: null is required by BullMQ; enableOfflineQueue: false
// makes enqueue fail fast instead of buffering forever when Redis is down.
const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableOfflineQueue: false,
});
connection.on('error', (err) => console.error('[dispatchQueue] Redis error:', err.message));

const dispatchQueue = new Queue('dispatch', { connection });

// v3.0 §4: one delayed job per company assignment, fired at slot_start − 2min.
// jobId is the idempotency key — reassignment enqueues dispatch:ccs:newSlot and
// the stale job no-ops at fire time because its slot_id no longer matches.
//
// Called AFTER the registration transaction commits, so a Redis outage must
// never turn a successful registration into a 500 — log and move on; the
// 30s reconcile poll (stage 5) and manual dispatch cover the gap.
async function enqueueDispatch({ ccsId, candidateId, companyId, slotId, slotStart }) {
  try {
    await dispatchQueue.add('dispatch', { ccsId, candidateId, companyId, slotId }, {
      jobId: `dispatch:${ccsId}:${slotId}`,
      delay: Math.max(0, new Date(slotStart).getTime() - Date.now() - 2 * 60 * 1000),
      removeOnComplete: true,
      removeOnFail: 100,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
  } catch (err) {
    console.error(`[dispatchQueue] enqueue failed for ccs ${ccsId} slot ${slotId}:`, err.message);
  }
}

module.exports = { dispatchQueue, enqueueDispatch };
