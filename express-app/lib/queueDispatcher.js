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
const { armNoShowTimer, clearNoShowTimer, SAME_FLOOR_MS, CROSS_FLOOR_MS } = require('./noShowTimer');
const { retunePingBuffer } = require('./bufferController');

// §6.1's 90s/180s split by companies.floor_number. "Where the candidate is
// right now" = the company of their most recently *completed* interview
// (processed_at IS NOT NULL) — a candidate is locked to at most one desk at a
// time, so this is stable to recompute even after a page reload (nothing else
// can complete for them while they're locked here). No completed interview
// yet (first dispatch of the day) or a company with no floor_number set both
// default to same-floor: there's no signal to say otherwise, and same-floor
// is the shorter, safer default — matches the timer's pre-floor-tracking behavior.
async function resolveSameFloor(candidateId, companyId) {
  const targetRes = await pool.query('SELECT floor_number FROM companies WHERE id = $1', [companyId]);
  const targetFloor = targetRes.rows[0]?.floor_number;
  if (targetFloor == null) return true;

  const lastRes = await pool.query(
    `SELECT c.floor_number
       FROM candidate_company_status ccs
       JOIN companies c ON c.id = ccs.company_id
      WHERE ccs.candidate_id = $1 AND ccs.processed_at IS NOT NULL AND ccs.deleted_at IS NULL
      ORDER BY ccs.processed_at DESC LIMIT 1`,
    [candidateId]
  );
  const lastFloor = lastRes.rows[0]?.floor_number;
  return lastFloor == null || lastFloor === targetFloor;
}

// Desk-level occupancy has no dedicated index — only the candidate-keyed
// lock (lock:{candidateId} -> deskId) exists. Find whoever's currently
// Dispatched at this company whose lock points at this desk, if anyone.
// Guards dispatch() below against double-dispatching a second candidate onto
// a desk that's still serving someone: the desk tablet has no "who's already
// here" state of its own, so a page reload or a stray double-tap of "Call
// first candidate" would otherwise call POST /queue/desk/next again while
// the first candidate's lock (and interview) is still live.
async function findDeskOccupant(companyId, deskId) {
  const dispatchedRes = await pool.query(
    `SELECT ccs.id AS ccs_id, ccs.candidate_id, ccs.dispatched_at, ccs.interview_started_at, cd.token_no
       FROM candidate_company_status ccs
       JOIN candidates cd ON cd.id = ccs.candidate_id
      WHERE ccs.company_id = $1 AND ccs.status = 'Dispatched' AND ccs.deleted_at IS NULL AND cd.deleted_at IS NULL`,
    [companyId]
  );
  if (!dispatchedRes.rows.length) return null;
  const desks = await Promise.all(dispatchedRes.rows.map((r) => store.getLockDesk(r.candidate_id)));
  const idx = desks.findIndex((d) => d === String(deskId));
  return idx === -1 ? null : dispatchedRes.rows[idx];
}

async function occupantPayload(companyId, deskId, occupant) {
  const sameFloor = await resolveSameFloor(occupant.candidate_id, companyId);
  const timerMs = sameFloor ? SAME_FLOOR_MS : CROSS_FLOOR_MS;
  return {
    candidateId: occupant.candidate_id,
    ccsId: occupant.ccs_id,
    companyId,
    deskId,
    token: occupant.token_no,
    sameFloor,
    expiresAt: new Date(new Date(occupant.dispatched_at).getTime() + timerMs).toISOString(),
    interviewStartedAt: occupant.interview_started_at,
  };
}

// Read-only "who's here" check — safe to call on every desk-tablet page load
// (or reload) with no dispatch side effect, unlike dispatch() below. This is
// what actually closes the "reload loses the incoming card" half of the
// double-dispatch bug: a mount-time call has to be side-effect-free, or
// simply opening the tablet would summon a real candidate before staff ever
// tap anything.
async function getDeskOccupant(companyId, deskId) {
  const occupant = await findDeskOccupant(companyId, deskId);
  return occupant ? await occupantPayload(companyId, deskId, occupant) : null;
}

// Company j's desk `deskId` just freed. Scan the queue in rank order, skip
// anyone not onsite or already locked elsewhere ("skip, don't drop" — §3.2),
// lock + dispatch the first eligible candidate. If nobody's eligible right
// now, the desk goes on the waiting list — completeInterview() elsewhere can
// still fill it later (§7.2 "race their other queues").
async function dispatch(companyId, deskId) {
  const occupant = await findDeskOccupant(companyId, deskId);
  if (occupant) {
    console.log(`[queue-dispatcher] desk ${deskId} at company ${companyId} already serving ${occupant.token_no} — returning existing occupant instead of double-dispatching`);
    return { ...(await occupantPayload(companyId, deskId, occupant)), alreadyDispatched: true };
  }

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

    // interview_started_at reset to NULL here — a stale value from a prior
    // dispatch cycle (e.g. a missed call that got redispatched) must not leak
    // into this cycle's "has the interview actually started" state.
    await pool.query(`UPDATE candidate_company_status SET status = 'Dispatched', dispatched_at = now(), interview_started_at = NULL WHERE id = $1`, [row.ccs_id]);
    await store.clearDeskWaiting(companyId, deskId);
    const sameFloor = await resolveSameFloor(candidateId, companyId);
    await armNoShowTimer({ candidateId, companyId, deskId, ccsId: row.ccs_id, sameFloor });
    const expiresAt = new Date(Date.now() + (sameFloor ? SAME_FLOOR_MS : CROSS_FLOOR_MS)).toISOString();

    emit('candidate_dispatched', {
      token: row.token_no,
      companyId,
      deskId,
      expiresAt,
      sameFloor,
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
      sameFloor,
    });
    console.log(`[queue-dispatcher] dispatched ${row.token_no} -> company ${companyId} desk ${deskId}`);
    return { candidateId, ccsId: row.ccs_id, companyId, deskId, token: row.token_no, expiresAt, sameFloor, interviewStartedAt: null };
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

module.exports = { dispatch, completeInterview, getDeskOccupant };
