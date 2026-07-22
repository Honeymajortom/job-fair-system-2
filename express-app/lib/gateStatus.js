// Entrance Gate + Staging aggregate display (new_architecture_uiux_spec.html
// §03) — the one wireframe from that spec never built. Read-only: the section
// has no scan/action controls in its markup, so this is purely a computed
// snapshot off existing state, the same way lib/floorStats.js and
// lib/insights.js are — no new interactive "mark as arrived" flow.
//
// pingLadder.js's resolveRung() is per (candidate, company) booking; a
// candidate tracking 3 companies gets 3 rungs. Physically they're in one
// place, so this reduces each checked-in candidate down to their single
// most-urgent rung across all active bookings and buckets them into the
// three cards the spec shows: waiting room (general holding — gate/warm/far),
// staging (the ~3-person physical staging area — rung 'staging'), and called
// to desk right now (rung 'desk_call').
const pool = require('../db');
const { resolveRung, DONE_STATUSES } = require('./pingLadder');

const WAITING_ROOM_MAX = 40; // new_architecture_uiux_spec.html §03's mockup value — no venue-capacity column exists to derive this from yet
const STAGING_MAX = 3;

const RUNG_RANK = { desk_call: 0, staging: 1, gate: 2, warm: 3, far: 4 };

async function computeGateStatus() {
  const rows = await pool.query(
    `SELECT cd.id AS candidate_id, cd.token_no, cd.travel_time_minutes,
            ccs.company_id, ccs.status, c.seats, c.interview_minutes
       FROM candidates cd
       JOIN candidate_company_status ccs ON ccs.candidate_id = cd.id AND ccs.deleted_at IS NULL
       JOIN companies c ON c.id = ccs.company_id
      WHERE cd.checked_in_at IS NOT NULL AND cd.deleted_at IS NULL
        AND ccs.status != ALL($1::varchar[])`,
    [[...DONE_STATUSES, 'Waitlisted']] // waitlisted bookings never entered the live queue — resolving one would misreport 'far'
  );

  const resolved = await Promise.all(rows.rows.map(async (row) => ({
    candidateId: row.candidate_id,
    token: row.token_no,
    ...(await resolveRung({
      status: row.status,
      companyId: row.company_id,
      candidateId: row.candidate_id,
      travelTimeMinutes: row.travel_time_minutes,
      seats: row.seats,
      interviewMinutes: row.interview_minutes,
    })),
  })));

  // Reduce every candidate's bookings down to their single most-urgent rung.
  const byCandidate = new Map();
  for (const r of resolved) {
    const cur = byCandidate.get(r.candidateId);
    if (!cur || RUNG_RANK[r.rung] < RUNG_RANK[cur.rung]) byCandidate.set(r.candidateId, r);
  }

  let waitingRoom = 0;
  let calledToDesk = 0;
  const stagingCandidates = [];
  for (const r of byCandidate.values()) {
    if (r.rung === 'desk_call') calledToDesk++;
    else if (r.rung === 'staging') stagingCandidates.push(r);
    else waitingRoom++; // gate, warm, far — all still "general holding"
  }
  stagingCandidates.sort((a, b) => a.eta_minutes - b.eta_minutes);

  const fairRes = await pool.query(
    'SELECT waiting_room_location, waiting_room_floor_number FROM fair_settings WHERE is_active = true ORDER BY fair_date DESC LIMIT 1'
  );
  const fair = fairRes.rows[0];

  return {
    waiting_room: waitingRoom,
    waiting_room_max: WAITING_ROOM_MAX,
    waiting_room_location: fair ? fair.waiting_room_location : null,
    waiting_room_floor_number: fair ? fair.waiting_room_floor_number : null,
    staging: stagingCandidates.slice(0, STAGING_MAX).map((r) => r.token),
    staging_max: STAGING_MAX,
    staging_overflow: Math.max(0, stagingCandidates.length - STAGING_MAX),
    called_to_desk: calledToDesk,
  };
}

module.exports = { computeGateStatus, WAITING_ROOM_MAX, STAGING_MAX };
