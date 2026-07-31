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
const { invalidateFloorStats } = require('../lib/floorStats');
const { invalidateReportsCache } = require('../lib/reportsCache');
const { resolveCompanyCenterId } = require('../lib/centerScope');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
connection.on('error', (err) => console.error('[noshow-worker] Redis error:', err.message));

// A candidate who never shows up after this many missed calls is dropped
// from the queue entirely (No_Show) instead of decaying indefinitely — see
// routes/queue.js's manual /no-show for the same terminal-state cleanup this
// mirrors (release lock, leave the queue, don't leave the desk idle).
const MISS_LIMIT = 5;

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
        SET status = CASE WHEN misses + 1 >= $2 THEN 'No_Show' ELSE 'Pending' END,
            dispatched_at = NULL,
            processed_at = CASE WHEN misses + 1 >= $2 THEN now() ELSE processed_at END,
            misses = misses + 1
      WHERE id = $1 AND status = 'Dispatched' AND deleted_at IS NULL
      RETURNING candidate_id, company_id, misses, status`,
    [ccsId, MISS_LIMIT]
  );
  if (!result.rows.length) {
    console.log(`[noshow-worker] ccs ${ccsId} no longer Dispatched — skipping`);
    return;
  }
  const { misses, status } = result.rows[0];

  await store.releaseLock(candidateId);
  await invalidateFloorStats();
  await invalidateReportsCache();
  // STAFF_INCONSISTENCY_REPORT.md S11 — same reasoning as the manual
  // /no-show route's identical event.
  const centerId = await resolveCompanyCenterId(companyId);

  if (status === 'No_Show') {
    // 5th miss — stop decaying the rank and drop them from the queue for
    // good, same cleanup routes/queue.js's manual /no-show does.
    await store.remove(companyId, candidateId);
    emit('no_show_marked', {
      candidateId,
      company_id: companyId,
      centerId,
      statsDelta: { atDesk: -1, noShows: 1 },
    });
    console.log(`[noshow-worker] candidate ${candidateId} hit ${misses} missed calls at company ${companyId} — marked No_Show, desk backfilling`);
  } else {
    await store.recordMiss(companyId, candidateId);   // ZSET score +10 — rank decays, stays in queue
    emit('queue_miss', {
      candidateId,
      companyId,
      centerId,
      statsDelta: { atDesk: -1, pending: 1 },
    });
    console.log(`[noshow-worker] candidate ${candidateId} missed the call at company ${companyId} desk ${deskId} — rank decayed (${misses}/${MISS_LIMIT}), desk backfilling`);
  }

  await dispatcher.dispatch(companyId, deskId);      // don't leave the desk idle on a miss
}, { connection, concurrency: 10 });

worker.on('failed', (job, err) => {
  console.error(`[noshow-worker] job ${job && job.id} failed:`, err.message);
});

console.log('[noshow-worker] up — waiting on delayed no-show jobs');
