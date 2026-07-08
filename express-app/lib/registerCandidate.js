const pool = require('../db');
const { signToken } = require('./checkinSig');
const { enqueueDispatch } = require('./dispatchQueue');
const { normalizeMobile } = require('./mobile');
const { emit } = require('./events');

const MAX_COMPANIES = 3;
const EMPLOYMENT_STATUSES = ['Studying', 'Working', 'Fresher', 'Other'];

// Shared registration core — the one atomic transaction behind both the staff
// path (POST /api/register) and the public QR path (POST /api/qr/register).
// Gate 1 (batch capacity) + Gate 2 (slot timing floored at batch arrival) are
// resolved inside the transaction (intertwine 1); checkin_sig is set at
// insert; delayed dispatch jobs are enqueued only after COMMIT.
// Returns { status, body } — the caller just forwards it to res.
async function registerCandidate({ name, mobile, age, qualification, field, employment_status, company_ids }) {
  if (!name || !name.trim()) return { status: 400, body: { error: 'name is required' } };
  if (!Array.isArray(company_ids) || company_ids.length === 0) {
    return { status: 400, body: { error: 'Select at least one company' } };
  }
  if (company_ids.length > MAX_COMPANIES) {
    return { status: 400, body: { error: `Select at most ${MAX_COMPANIES} companies` } };
  }
  const status = employment_status && EMPLOYMENT_STATUSES.includes(employment_status) ? employment_status : 'Fresher';
  // Store the canonical form so dedup and the partial unique index can't be
  // sidestepped by formatting ("+91 99999 04001" vs "9999904001").
  const normMobile = normalizeMobile(mobile);

  const client = await pool.connect();
  let tokenNo;
  let batch = null;
  let candidateId;
  const assigned = [];
  try {
    await client.query('BEGIN');

    if (normMobile) {
      const dup = await client.query('SELECT 1 FROM candidates WHERE mobile = $1', [normMobile]);
      if (dup.rows.length) {
        await client.query('ROLLBACK');
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
      `INSERT INTO candidates (token_no, name, mobile, age, qualification, field, employment_status, batch_id, checkin_sig)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, token_no`,
      [tokenNo, name.trim(), normMobile, age || null, qualification || null, field || null, status, batch ? batch.id : null, signToken(tokenNo)]
    );
    candidateId = candidateRes.rows[0].id;

    for (const companyId of company_ids) {
      const companyRes = await client.query('SELECT id, company_name, location FROM companies WHERE id = $1', [companyId]);
      if (!companyRes.rows.length) continue;

      // Lock this company's slots for the duration of the transaction so two
      // concurrent registrations can never both land on the same slot.
      // Gate 2 (slot timing): a candidate can never get a slot earlier than
      // their batch's arrival time — enforced here, inside the same transaction
      // that assigned the batch (intertwine 1).
      const slotsRes = await client.query(
        `SELECT id, slot_start, capacity FROM interview_slots
         WHERE company_id = $1 AND ($2::timestamptz IS NULL OR slot_start >= $2)
         ORDER BY slot_start ASC FOR UPDATE`,
        [companyId, batch ? batch.arrival_time : null]
      );

      let chosenSlot = null;
      for (const slot of slotsRes.rows) {
        const takenRes = await client.query(
          'SELECT COUNT(*)::int AS taken FROM candidate_company_status WHERE slot_id = $1 AND deleted_at IS NULL',
          [slot.id]
        );
        if (takenRes.rows[0].taken < slot.capacity) {
          chosenSlot = slot;
          break;
        }
      }

      if (!chosenSlot) continue; // company fully booked — skip silently, reflected in confirmation screen

      const ccsRes = await client.query(
        `INSERT INTO candidate_company_status (candidate_id, company_id, slot_id, status)
         VALUES ($1,$2,$3,'Pending')
         ON CONFLICT (candidate_id, company_id) DO NOTHING
         RETURNING id`,
        [candidateId, companyId, chosenSlot.id]
      );
      if (!ccsRes.rows.length) continue; // conflict — duplicate company id in the request

      assigned.push({
        ccs_id: ccsRes.rows[0].id,
        company_id: companyId,
        company_name: companyRes.rows[0].company_name,
        location: companyRes.rows[0].location,
        slot_id: chosenSlot.id,
        slot_start: chosenSlot.slot_start,
      });
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // v3.0 §4: enqueue AFTER commit — one delayed dispatch job per assignment,
  // fired at slot_start − 2min. enqueueDispatch never throws (Redis outage
  // must not 500 an already-committed registration).
  for (const a of assigned) {
    await enqueueDispatch({
      ccsId: a.ccs_id,
      candidateId,
      companyId: a.company_id,
      slotId: a.slot_id,
      slotStart: a.slot_start,
    });
  }

  // v3.0 §8: delta payloads — clients increment local counters, no refetch.
  emit('candidate_registered', {
    token: tokenNo,
    name: name.trim(),
    batch_id: batch ? batch.id : null,
    statsDelta: { registered: 1 },
  });
  if (assigned.length) {
    emit('slot_assigned', {
      token: tokenNo,
      slots: assigned.map((a) => ({ company_id: a.company_id, company_name: a.company_name, slot_id: a.slot_id, slot_start: a.slot_start })),
      statsDelta: { openSlots: -assigned.length },
    });
  }

  return {
    status: 201,
    body: {
      token: tokenNo,
      qr: `${tokenNo}.${signToken(tokenNo)}`, // schedule-card QR payload (v3.0 §6)
      batch_id: batch ? batch.id : null,
      schedule_url: `/qr/schedule/${tokenNo}`, // bookmarkable live schedule (v3.0 §7)
      assigned: assigned.map(({ ccs_id, slot_id, ...rest }) => rest),
    },
  };
}

module.exports = registerCandidate;
