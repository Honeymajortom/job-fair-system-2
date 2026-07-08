require('dotenv').config();
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const pool = require('../db');
const { emit } = require('../lib/events');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
connection.on('error', (err) => console.error('[slot-dispatcher] Redis error:', err.message));

// v3.0 §4 — BullMQ Worker, no cron, no polling. Sleeps until a delayed job's
// timer expires. Runs as its own process (PM2 fork in prod): node workers/slotDispatcher.js
//
// The conditional UPDATE is the whole integrity story: status must still be
// Pending AND the slot must still be the one this job was enqueued for. Any
// reassign / no-show / soft-delete between enqueue and fire makes it a no-op,
// and a BullMQ retry after a crash is idempotent for the same reason.
const worker = new Worker('dispatch', async (job) => {
  const { ccsId, slotId } = job.data;

  const dispatched = await pool.query(
    `UPDATE candidate_company_status ccs
        SET status = 'Dispatched'
       FROM candidates cd
      WHERE ccs.id = $1 AND ccs.slot_id = $2 AND ccs.status = 'Pending'
        AND ccs.deleted_at IS NULL
        AND cd.id = ccs.candidate_id AND cd.deleted_at IS NULL
        AND cd.checked_in_at IS NOT NULL
      RETURNING ccs.id, ccs.company_id, cd.token_no`,
    [ccsId, slotId]
  );
  if (dispatched.rows.length) {
    const row = dispatched.rows[0];
    // v3.0 §8: delta + cell coords so FloorMonitor paints one cell, no refetch.
    emit('candidate_dispatched', {
      token: row.token_no,
      companyId: row.company_id,
      slotId,
      statsDelta: { atDesk: 1, pending: -1 },
    });
    console.log(`[slot-dispatcher] dispatched ccs ${ccsId} (slot ${slotId})`);
    return;
  }

  // v3.0 §4 edge case "batch closed, candidate never checked in": if the row is
  // still Pending but the candidate isn't through the gate and their batch has
  // closed, auto-mark No_Show instead of dispatching a ghost. Every other
  // rowCount-0 reason (reassigned, already processed, soft-deleted) is a no-op.
  const noShow = await pool.query(
    `UPDATE candidate_company_status ccs
        SET status = 'No_Show', processed_at = now()
       FROM candidates cd
       JOIN fair_batches b ON b.id = cd.batch_id
      WHERE ccs.id = $1 AND ccs.slot_id = $2 AND ccs.status = 'Pending'
        AND ccs.deleted_at IS NULL
        AND cd.id = ccs.candidate_id AND cd.deleted_at IS NULL
        AND cd.checked_in_at IS NULL AND b.status = 'closed'
      RETURNING ccs.id, ccs.company_id, cd.token_no`,
    [ccsId, slotId]
  );
  if (noShow.rows.length) {
    const row = noShow.rows[0];
    emit('no_show_marked', {
      token: row.token_no,
      company_id: row.company_id,
      slot_id: slotId,
      statsDelta: { noShows: 1, pending: -1 },
    });
    console.log(`[slot-dispatcher] no-show ccs ${ccsId} (batch closed, never checked in)`);
  }
}, { connection, concurrency: 10 });

worker.on('failed', (job, err) => {
  console.error(`[slot-dispatcher] job ${job && job.id} failed:`, err.message);
});

console.log('[slot-dispatcher] worker up — waiting on delayed dispatch jobs');
