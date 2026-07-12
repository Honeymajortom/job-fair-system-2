// Queue-system Phase 1 (new_architecture.md §3.2/§3.4/§7.2) — replaces
// lib/dispatchQueue.js + workers/slotDispatcher.js's fixed-slot-time model.
// No delayed jobs, no slot_id: a desk asks for a candidate the instant it's
// free, the dispatcher answers from live Redis queue state.
// Phase 3 additions: dispatched_at timestamp, no-show timer arm/clear, and a
// per-desk socket room push (candidate-side push is still Phase 4 — staff
// sockets are the only ones that exist right now, see lib/io.js).
const pool = require('../db');
const store = require('./queueStore');
const { emit, emitToRoom } = require('./events');
const { armNoShowTimer, clearNoShowTimer, SAME_FLOOR_MS } = require('./noShowTimer');
const { retunePingBuffer } = require('./bufferController');

// Company j's desk `deskId` just freed. Scan the queue in rank order, skip
// anyone not onsite or already locked elsewhere ("skip, don't drop" — §3.2),
// lock + dispatch the first eligible candidate. If nobody's eligible right
// now, the desk goes on the waiting list — completeInterview() elsewhere can
// still fill it later (§7.2 "race their other queues").
async function dispatch(companyId, deskId) {
  const candidateIds = await store.topCandidates(companyId, 20);
  if (!candidateIds.length) {
    await store.markDeskWaiting(companyId, deskId);
    return null;
  }

  const eligible = await pool.query(
    `SELECT ccs.id AS ccs_id, ccs.candidate_id, cd.token_no
       FROM candidate_company_status ccs
       JOIN candidates cd ON cd.id = ccs.candidate_id
      WHERE ccs.company_id = $1 AND ccs.candidate_id = ANY($2::int[])
        AND ccs.status = 'Pending' AND ccs.deleted_at IS NULL
        AND cd.deleted_at IS NULL AND cd.checked_in_at IS NOT NULL`,
    [companyId, candidateIds]
  );
  const byCandidate = new Map(eligible.rows.map((r) => [r.candidate_id, r]));

  for (const candidateId of candidateIds) {
    const row = byCandidate.get(candidateId);
    if (!row) continue;                              // not onsite / not pending here — skip, don't drop
    if (await store.isLocked(candidateId)) continue;  // busy at another desk

    const locked = await store.acquireLock(candidateId, deskId);
    if (!locked) continue;                            // lost a race to a concurrent dispatch() call

    await pool.query(`UPDATE candidate_company_status SET status = 'Dispatched', dispatched_at = now() WHERE id = $1`, [row.ccs_id]);
    await store.clearDeskWaiting(companyId, deskId);
    await armNoShowTimer({ candidateId, companyId, deskId, ccsId: row.ccs_id });
    // armNoShowTimer defaults sameFloor:true (see noShowTimer.js's floor-
    // awareness note) — mirror that here so the deadline we hand out matches
    // the timer we actually armed.
    const expiresAt = new Date(Date.now() + SAME_FLOOR_MS).toISOString();

    emit('candidate_dispatched', {
      token: row.token_no,
      companyId,
      deskId,
      expiresAt,
      statsDelta: { atDesk: 1, pending: -1 },
    });
    // Desk-tablet-scoped push — Phase 3's "Q-->>D: incoming · arm timer"
    // (new_architecture.md §3.4). The global emit above is what today's
    // (v1-era) dashboards already listen for; this is additive, not a
    // replacement.
    emitToRoom(`desk:${companyId}:${deskId}`, 'desk_incoming', {
      token: row.token_no,
      candidateId,
      ccsId: row.ccs_id,
      companyId,
      deskId,
      expiresAt,
    });
    console.log(`[queue-dispatcher] dispatched ${row.token_no} -> company ${companyId} desk ${deskId}`);
    return { candidateId, ccsId: row.ccs_id, companyId, deskId, token: row.token_no, expiresAt };
  }

  await store.markDeskWaiting(companyId, deskId);
  console.log(`[queue-dispatcher] desk ${deskId} at company ${companyId} waiting — no eligible candidate onsite`);
  return null;
}

// Equivalent of the sketch's `interviewQueue.on('completed', ...)` — called
// when a desk finishes with a candidate (Phase 3 wires this to the desk
// tablet's "done" tap; Phase 1 fixtures call it directly).
async function completeInterview({ candidateId, companyId, deskId, serviceMinutes }) {
  // Defensive, not load-bearing: confirm-arrival should already have cleared
  // this. Without it, a result recorded before arrival was ever confirmed
  // would leave a stale timer armed — and by the time it fired, the
  // candidate's lock could belong to a completely different company.
  await clearNoShowTimer(candidateId, companyId);
  await store.releaseLock(candidateId);               // release -> eligible elsewhere
  await store.updateDrainRate(companyId, serviceMinutes);
  await store.remove(companyId, candidateId);          // done with company j's queue

  await dispatch(companyId, deskId);                   // backfill this desk
  await retunePingBuffer(companyId);                    // §6.2: re-widen/narrow the ping window off the fresh on-hand/drain-rate

  const others = await pool.query(
    `SELECT company_id FROM candidate_company_status
      WHERE candidate_id = $1 AND status = 'Pending' AND deleted_at IS NULL`,
    [candidateId]
  );
  for (const { company_id: otherCompanyId } of others.rows) {
    const waitingDesk = await store.popWaitingDesk(otherCompanyId);
    if (waitingDesk) await dispatch(otherCompanyId, waitingDesk); // race their other queues
  }
}

module.exports = { dispatch, completeInterview };
