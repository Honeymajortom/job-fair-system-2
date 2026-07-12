// Queue-system Phase 3 — the no-show timer's consumer half (producer is
// lib/noShowTimer.js). Separate process from workers/slotDispatcher.js (v1's
// worker, untouched): npm run worker:noshow.
//
// A fired job means confirm-arrival never cleared it in time. §3.4: "Missed
// call → rank decays +10 positions (the slot survives, only priority
// degrades)" — this worker un-dispatches the candidate back to Pending with
// the decay applied, releases the desk lock, and immediately re-dispatches
// the same desk so the miss doesn't leave it idle.
require('dotenv').config();
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const pool = require('../db');
const store = require('../lib/queueStore');
const dispatcher = require('../lib/queueDispatcher');
const { emit } = require('../lib/events');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
connection.on('error', (err) => console.error('[noshow-worker] Redis error:', err.message));

const worker = new Worker('noshow', async (job) => {
  const { candidateId, companyId, deskId, ccsId } = job.data;

  // Stale-timer guard: if the lock has already moved on (arrival was
  // confirmed, or the interview finished and completeInterview() cleared it
  // just as this job was firing), this is a no-op — not a miss.
  const currentLockValue = await connection.get(`lock:${candidateId}`);
  if (currentLockValue !== deskId) {
    console.log(`[noshow-worker] job for candidate ${candidateId} company ${companyId} is stale (lock=${currentLockValue}) — skipping`);
    return;
  }

  const result = await pool.query(
    `UPDATE candidate_company_status
        SET status = 'Pending', dispatched_at = NULL, misses = misses + 1
      WHERE id = $1 AND status = 'Dispatched' AND deleted_at IS NULL
      RETURNING candidate_id, company_id`,
    [ccsId]
  );
  if (!result.rows.length) {
    console.log(`[noshow-worker] ccs ${ccsId} no longer Dispatched — skipping`);
    return;
  }

  await store.recordMiss(companyId, candidateId);   // ZSET score +10 — rank decays, stays in queue
  await store.releaseLock(candidateId);

  emit('queue_miss', {
    candidateId,
    companyId,
    statsDelta: { atDesk: -1, pending: 1 },
  });
  console.log(`[noshow-worker] candidate ${candidateId} missed the call at company ${companyId} desk ${deskId} — rank decayed, desk backfilling`);

  await dispatcher.dispatch(companyId, deskId);      // don't leave the desk idle on a miss
}, { connection, concurrency: 10 });

worker.on('failed', (job, err) => {
  console.error(`[noshow-worker] job ${job && job.id} failed:`, err.message);
});

console.log('[noshow-worker] up — waiting on delayed no-show jobs');
