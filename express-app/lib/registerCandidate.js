const pool = require('../db');
const { signToken } = require('./checkinSig');
const queueStore = require('./queueStore');
const { normalizeMobile } = require('./mobile');
const { emit } = require('./events');
const { DONE_STATUSES } = require('./pingLadder');

const MAX_COMPANIES = 3;
const EMPLOYMENT_STATUSES = ['Studying', 'Working', 'Fresher', 'Other'];
const GENDERS = ['Male', 'Female', 'Other'];

// Shared registration core — the one atomic transaction behind both the staff
// path (POST /api/register) and the public QR path (POST /api/qr/register).
// Gate 1 (batch capacity, unchanged since v1) + Gate 2 (per-company booking
// cap, new_architecture.md §3.1 — replaces v1's slot-timing gate) are
// resolved inside the transaction (intertwine 1); checkin_sig is set at
// insert; successful bookings are pushed onto the live Redis queue only
// after COMMIT.
// Returns { status, body } — the caller just forwards it to res.
async function registerCandidate({ name, mobile, age, qualification, field, employment_status, company_ids, travel_time_minutes, gender, is_sdc }) {
  if (!name || !name.trim()) return { status: 400, body: { error: 'name is required' } };
  if (!Array.isArray(company_ids) || company_ids.length === 0) {
    return { status: 400, body: { error: 'Select at least one company' } };
  }
  if (company_ids.length > MAX_COMPANIES) {
    return { status: 400, body: { error: `Select at most ${MAX_COMPANIES} companies` } };
  }
  // Queue-system Phase 4 (new_architecture.md §3.3): feeds the "come now"
  // threshold (ETA <= travel time + 15min). Optional — an unset value just
  // means this candidate's ping ladder never reaches the "warm" rung early,
  // it still reaches gate/staging/desk_call from position alone.
  let travelTimeMinutes = null;
  if (travel_time_minutes != null) {
    const n = Number(travel_time_minutes);
    if (!Number.isFinite(n) || n < 0 || n > 180) {
      return { status: 400, body: { error: 'travel_time_minutes must be between 0 and 180' } };
    }
    travelTimeMinutes = Math.round(n);
  }
  const status = employment_status && EMPLOYMENT_STATUSES.includes(employment_status) ? employment_status : 'Fresher';
  // Both optional (Insights dashboard fields) — an unrecognized/omitted value
  // just stores NULL ("Unknown") rather than failing the whole registration.
  const genderValue = GENDERS.includes(gender) ? gender : null;
  const isSdc = typeof is_sdc === 'boolean' ? is_sdc : null;
  // Store the canonical form so dedup and the partial unique index can't be
  // sidestepped by formatting ("+91 99999 04001" vs "9999904001").
  const normMobile = normalizeMobile(mobile);

  const client = await pool.connect();
  let tokenNo;
  let batch = null;
  let candidateId;
  const assigned = [];
  const waitlisted = [];
  try {
    await client.query('BEGIN');

    if (normMobile) {
      const dup = await client.query('SELECT id FROM candidates WHERE mobile = $1', [normMobile]);
      if (dup.rows.length) {
        await client.query('ROLLBACK');
        // A repeat mobile is always blocked (idx_candidates_mobile), but the
        // message should actually tell them what to do: if their prior visit
        // fully wrapped up (every booking settled) and they never submitted
        // feedback, that's the real reason, not "already registered".
        const existingId = dup.rows[0].id;
        const feedbackRes = await client.query('SELECT 1 FROM candidate_feedback WHERE candidate_id = $1', [existingId]);
        if (!feedbackRes.rows.length) {
          const openRes = await client.query(
            `SELECT 1 FROM candidate_company_status WHERE candidate_id = $1 AND deleted_at IS NULL
               AND status != ALL($2::varchar[]) LIMIT 1`,
            [existingId, DONE_STATUSES]
          );
          if (!openRes.rows.length) {
            return { status: 409, body: { error: 'Please submit your feedback from your last visit before registering again — open your previous token page to do that.' } };
          }
        }
        return { status: 409, body: { error: 'This mobile number is already registered' } };
      }
    }

    const tokenRes = await client.query("SELECT nextval('token_seq') AS n");
    tokenNo = `A-${tokenRes.rows[0].n}`;

    // Gate 1 (batch capacity): earliest non-closed batch of the active fair with
    // seats left. Rows are locked FOR UPDATE first, then occupancy is counted in
    // a separate statement (fresh snapshot) so two concurrent registrations
    // can't both take the last seat. Capacity stays fixed (the "18/25" display);
    // occupancy is the count of live candidates assigned to the batch.
    // No batches generated yet → batch_id stays NULL and Gate 2 doesn't floor
    // the slots (prototype-friendly: stage 1/2 curl flows keep working).
    const batchesRes = await client.query(
      `SELECT b.id, b.arrival_time, b.capacity
       FROM fair_batches b
       JOIN fair_settings fs ON fs.fair_date = b.fair_date AND fs.is_active = true
       WHERE b.status != 'closed'
       ORDER BY b.arrival_time ASC
       FOR UPDATE OF b`
    );
    for (const b of batchesRes.rows) {
      const occ = await client.query(
        'SELECT COUNT(*)::int AS n FROM candidates WHERE batch_id = $1 AND deleted_at IS NULL',
        [b.id]
      );
      if (occ.rows[0].n < b.capacity) {
        batch = b;
        break;
      }
    }
    if (!batch) {
      const anyBatch = await client.query(
        `SELECT 1 FROM fair_batches b
         JOIN fair_settings fs ON fs.fair_date = b.fair_date AND fs.is_active = true
         LIMIT 1`
      );
      if (anyBatch.rows.length) {
        await client.query('ROLLBACK');
        return { status: 409, body: { error: 'All arrival batches are full or closed' } };
      }
    }

    const candidateRes = await client.query(
      `INSERT INTO candidates (token_no, name, mobile, age, qualification, field, employment_status, batch_id, checkin_sig, travel_time_minutes, gender, is_sdc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, token_no`,
      [tokenNo, name.trim(), normMobile, age || null, qualification || null, field || null, status, batch ? batch.id : null, signToken(tokenNo), travelTimeMinutes, genderValue, isSdc]
    );
    candidateId = candidateRes.rows[0].id;

    // Gate 2 replacement (new_architecture.md §3.1/§4): a booking cap per
    // company — 90% of the day's capacity_j = seats * (60/interview_minutes)
    // * fair_hours — replaces per-slot-time capacity. A pick past the cap
    // doesn't fail the whole registration; it's recorded as Waitlisted (real
    // inventory for Phase 5's fall-through) instead of Pending, and never
    // reaches the live Redis queue.
    //
    // Advisory locks are acquired for every requested company up front, in a
    // fixed ascending-id order, before any booking work below — so two
    // candidates registering for the same two companies in opposite
    // preference order can never deadlock waiting on each other's locks.
    const fairRes = await client.query(
      `SELECT fair_hours FROM fair_settings WHERE is_active = true ORDER BY fair_date DESC LIMIT 1`
    );
    const fairHours = fairRes.rows.length ? Number(fairRes.rows[0].fair_hours) : 8;

    const lockOrder = [...new Set(company_ids.map(Number))].sort((a, b) => a - b);
    for (const cid of lockOrder) {
      await client.query('SELECT pg_advisory_xact_lock($1)', [cid]);
    }

    for (const companyId of company_ids) {
      const companyRes = await client.query(
        'SELECT id, company_name, location, seats, interview_minutes FROM companies WHERE id = $1',
        [companyId]
      );
      if (!companyRes.rows.length) continue;
      const company = companyRes.rows[0];

      const capacity = company.seats * (60 / company.interview_minutes) * fairHours;
      const capSold = Math.floor(0.9 * capacity);

      const bookedRes = await client.query(
        `SELECT COUNT(*)::int AS n FROM candidate_company_status
         WHERE company_id = $1 AND status != 'Waitlisted' AND deleted_at IS NULL`,
        [companyId]
      );
      const isWaitlisted = bookedRes.rows[0].n >= capSold;
      const serial = isWaitlisted ? null : bookedRes.rows[0].n + 1;

      const ccsRes = await client.query(
        `INSERT INTO candidate_company_status (candidate_id, company_id, status, serial)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (candidate_id, company_id) DO NOTHING
         RETURNING id`,
        [candidateId, companyId, isWaitlisted ? 'Waitlisted' : 'Pending', serial]
      );
      if (!ccsRes.rows.length) continue; // conflict — duplicate company id in the request

      const entry = {
        ccs_id: ccsRes.rows[0].id,
        company_id: companyId,
        company_name: company.company_name,
        location: company.location,
        serial,
      };
      if (isWaitlisted) waitlisted.push(entry);
      else assigned.push(entry);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Push onto the live Redis queue AFTER commit — same reasoning as v1's
  // enqueueDispatch: a Redis outage must never turn an already-committed
  // booking into a failed registration. Waitlisted picks never reach here —
  // they have no serial and aren't part of any company's live queue yet.
  for (const a of assigned) {
    try {
      await queueStore.enqueue(a.company_id, candidateId, a.serial);
    } catch (err) {
      console.error(`[registerCandidate] queue enqueue failed for candidate ${candidateId} company ${a.company_id}:`, err.message);
    }
  }

  // v3.0 §8 pattern, carried into the new model: delta payloads so clients
  // increment local counters instead of refetching.
  emit('candidate_registered', {
    token: tokenNo,
    name: name.trim(),
    batch_id: batch ? batch.id : null,
    statsDelta: { registered: 1 },
  });
  if (assigned.length) {
    emit('queue_joined', {
      token: tokenNo,
      companies: assigned.map((a) => ({ company_id: a.company_id, company_name: a.company_name, serial: a.serial })),
      statsDelta: { queued: assigned.length },
    });
  }
  if (waitlisted.length) {
    emit('candidate_waitlisted', {
      token: tokenNo,
      companies: waitlisted.map((a) => ({ company_id: a.company_id, company_name: a.company_name })),
      statsDelta: { waitlisted: waitlisted.length },
    });
  }

  return {
    status: 201,
    body: {
      token: tokenNo,
      qr: `${tokenNo}.${signToken(tokenNo)}`, // schedule-card QR payload (v3.0 §6)
      batch_id: batch ? batch.id : null,
      schedule_url: `/qr/schedule/${tokenNo}`, // bookmarkable live schedule (v3.0 §7)
      assigned: assigned.map(({ ccs_id, ...rest }) => rest),
      waitlisted: waitlisted.map(({ ccs_id, ...rest }) => rest),
    },
  };
}

module.exports = registerCandidate;
