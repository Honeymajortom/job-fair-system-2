const pool = require('../db');
const { signToken } = require('./checkinSig');
const queueStore = require('./queueStore');
const { getOrCreateAvailableBatch } = require('./batchAssignment');
const { assignCompanies, MAX_COMPANIES } = require('./companyAssignment');
const { normalizeMobile, isValidMobile } = require('./mobile');
const { emit } = require('./events');
const { DONE_STATUSES } = require('./pingLadder');

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
  // Company selection is optional at registration time (new_architecture.md's
  // Gate-flow candidate journey: pick companies after checking in at the Gate,
  // not before) — an omitted/empty list just means Gate 2 below is skipped and
  // the candidate picks later via POST /qr/select-companies/:qr. Staff manual
  // registration (or any caller that still wants to pick up front) keeps
  // working unchanged if it passes company_ids.
  const companyIds = Array.isArray(company_ids) ? company_ids : [];
  if (companyIds.length > MAX_COMPANIES) {
    return { status: 400, body: { error: `Select at most ${MAX_COMPANIES} companies` } };
  }
  // Mobile is optional here (staff manual entry, flow D, can omit it) but if
  // one is given it has to be a real 10-digit number — the re-registration
  // guard below is keyed entirely on mobile, so an unvalidated format
  // ("1", "2", "3"...) made that guard trivial to defeat by incrementing a
  // fake digit each time. Checked before opening a DB connection — a format
  // error never needs one.
  if (mobile && !isValidMobile(mobile)) {
    return { status: 400, body: { error: 'Enter a valid 10-digit mobile number' } };
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
    // seats left, auto-creating the next one on the fly if every existing batch
    // is full or closed — staff never have to press "Generate batch" for
    // registration to keep working (see lib/batchAssignment.js). No active fair
    // configured at all → batch stays null and Gate 2 doesn't floor the slots
    // (prototype-friendly: stage 1/2 curl flows keep working).
    const fairRes = await client.query(
      `SELECT to_char(fair_date, 'YYYY-MM-DD') AS fair_date, fair_hours, batch_size, batch_interval_minutes
       FROM fair_settings WHERE is_active = true ORDER BY fair_date DESC LIMIT 1`
    );
    const fair = fairRes.rows[0] || null;
    if (fair) {
      batch = await getOrCreateAvailableBatch(client, fair);
    }

    const candidateRes = await client.query(
      `INSERT INTO candidates (token_no, name, mobile, age, qualification, field, employment_status, batch_id, checkin_sig, travel_time_minutes, gender, is_sdc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, token_no`,
      [tokenNo, name.trim(), normMobile, age || null, qualification || null, field || null, status, batch ? batch.id : null, signToken(tokenNo), travelTimeMinutes, genderValue, isSdc]
    );
    candidateId = candidateRes.rows[0].id;

    // Gate 2 (new_architecture.md §3.1/§4), skipped entirely when no companies
    // were picked at registration time (the new Gate-flow candidate journey —
    // see the companyIds comment above). lib/companyAssignment.js's
    // assignCompanies() is the same booking-cap logic POST
    // /qr/select-companies/:qr runs later, standalone, once the candidate
    // does pick.
    const fairHours = fair ? Number(fair.fair_hours) : 8;
    if (companyIds.length) {
      const result = await assignCompanies(client, { candidateId, company_ids: companyIds, fairHours });
      assigned.push(...result.assigned);
      waitlisted.push(...result.waitlisted);
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
