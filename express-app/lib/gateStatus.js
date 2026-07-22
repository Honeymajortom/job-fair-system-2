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
//
// Waiting room is per-floor, not one fair-wide pool (superseded fair_settings.
// waiting_room_location/floor_number the same day it shipped — see
// db/schema.sql's waiting_rooms table comment): each waiting-room candidate
// is bucketed by the floor_number of whichever company their most-urgent
// booking is for, since that's the desk they'll actually be walking to.
const pool = require('../db');
const { resolveRung, DONE_STATUSES } = require('./pingLadder');

const WAITING_ROOM_MAX = 40; // new_architecture_uiux_spec.html §03's mockup value — no venue-capacity column exists to derive this from yet
const STAGING_MAX = 3;

const RUNG_RANK = { desk_call: 0, staging: 1, gate: 2, warm: 3, far: 4 };

async function computeGateStatus() {
  const rows = await pool.query(
    `SELECT cd.id AS candidate_id, cd.token_no, cd.travel_time_minutes,
            ccs.company_id, ccs.status, c.seats, c.interview_minutes, c.floor_number
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
    floorNumber: row.floor_number,
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

  let calledToDesk = 0;
  const stagingCandidates = [];
  const waitingByFloor = new Map(); // floor_number (or null) -> count
  for (const r of byCandidate.values()) {
    if (r.rung === 'desk_call') calledToDesk++;
    else if (r.rung === 'staging') stagingCandidates.push(r);
    else waitingByFloor.set(r.floorNumber, (waitingByFloor.get(r.floorNumber) || 0) + 1); // gate, warm, far — all still "general holding"
  }
  stagingCandidates.sort((a, b) => a.eta_minutes - b.eta_minutes);

  const roomsRes = await pool.query('SELECT floor_number, location FROM waiting_rooms ORDER BY floor_number');
  const locationByFloor = new Map(roomsRes.rows.map((r) => [r.floor_number, r.location]));
  // Every floor that either has waiting candidates or a configured room shows
  // up — an admin-configured-but-currently-empty room is still worth
  // displaying on the entrance board, and a floor with waiters but no
  // configured room yet still needs to show its count somewhere.
  const allFloors = new Set([...waitingByFloor.keys(), ...locationByFloor.keys()]);
  const waitingRooms = [...allFloors].sort((a, b) => (a ?? Infinity) - (b ?? Infinity)).map((floorNumber) => ({
    floor_number: floorNumber,
    location: locationByFloor.get(floorNumber) ?? null,
    count: waitingByFloor.get(floorNumber) || 0,
  }));

  return {
    waiting_rooms: waitingRooms,
    waiting_room_total: [...waitingByFloor.values()].reduce((a, b) => a + b, 0),
    waiting_room_max: WAITING_ROOM_MAX,
    staging: stagingCandidates.slice(0, STAGING_MAX).map((r) => r.token),
    staging_max: STAGING_MAX,
    staging_overflow: Math.max(0, stagingCandidates.length - STAGING_MAX),
    called_to_desk: calledToDesk,
  };
}

module.exports = { computeGateStatus, WAITING_ROOM_MAX, STAGING_MAX };
