// candidate_and_desk_improvements_plan.md §A: the "pick up to N companies" cap
// used to live here as a bare MAX_COMPANIES constant, duplicated across every
// caller. It's now per-fair-cycle (fair_settings.max_companies_per_candidate,
// admin-configurable) — each caller below fetches it from the relevant
// fair_settings row itself and enforces it before calling assignCompanies(),
// which only ever handled per-company capacity/waitlist, never the candidate-
// wide "how many companies total" cap.

// Extracted from registerCandidate.js's Gate 2 (new_architecture.md §3.1/§4) so
// it can run either inside registration's own transaction (company_ids picked
// at registration time, staff/legacy path) or standalone, in its own
// transaction, once a candidate picks companies after checking in at the Gate
// (routes/public.js's POST /qr/select-companies/:qr). Same booking-cap logic
// either way: 90% of the day's capacity_j = seats * (60/interview_minutes) *
// fair_hours; a pick past the cap lands Waitlisted instead of failing.
//
// Advisory locks are acquired for every requested company up front, in a
// fixed ascending-id order, before any booking work — so two callers
// (candidates) registering for the same two companies in opposite preference
// order can never deadlock waiting on each other's locks. Caller is
// responsible for running this inside an open transaction (`client`) and
// committing/rolling back around it.
async function assignCompanies(client, { candidateId, company_ids, fairHours, fairSettingsId }) {
  const assigned = [];
  const waitlisted = [];

  const lockOrder = [...new Set(company_ids.map(Number))].sort((a, b) => a - b);
  for (const cid of lockOrder) {
    await client.query('SELECT pg_advisory_xact_lock($1)', [cid]);
  }

  for (const companyId of company_ids) {
    // Company lookup + booked-count merged into one round trip (was two
    // sequential queries) — cuts the time spent under this company's
    // advisory lock roughly in half per requested company.
    // company_roster_plan.md: seats/interview_minutes now come from this
    // specific cycle's roster row, not the company's own (now-legacy)
    // columns — a company with no roster row for fairSettingsId isn't
    // actually part of this cycle, so it's skipped exactly like "company not
    // found" already was.
    const companyRes = await client.query(
      `SELECT c.id, c.company_name, c.location, r.seats, r.interview_minutes,
              (SELECT COUNT(*)::int FROM candidate_company_status ccs
                WHERE ccs.company_id = c.id AND ccs.status != 'Waitlisted' AND ccs.deleted_at IS NULL) AS booked
       FROM companies c
       JOIN fair_company_roster r ON r.company_id = c.id AND r.fair_settings_id = $2
       WHERE c.id = $1`,
      [companyId, fairSettingsId]
    );
    if (!companyRes.rows.length) continue;
    const company = companyRes.rows[0];

    const capacity = company.seats * (60 / company.interview_minutes) * fairHours;
    const capSold = Math.floor(0.9 * capacity);

    const isWaitlisted = company.booked >= capSold;
    const serial = isWaitlisted ? null : company.booked + 1;

    // ON CONFLICT is an upsert, not a plain skip, so a company a staff member
    // previously removed for this candidate (routes/candidates.js's DELETE
    // /candidates/:id/companies/:companyId — soft-delete, not a hard row
    // delete, since UNIQUE(candidate_id, company_id) means the row has to
    // stick around) can be cleanly re-added: the WHERE clause only fires the
    // update when the existing row is soft-deleted, resurrecting it fresh
    // (clearing any stale ratings/timestamps from before). A genuine
    // duplicate company id *within the same call* hits an already-live row
    // (deleted_at IS NULL), so the WHERE clause blocks the update and this
    // still no-ops exactly like the old ON CONFLICT DO NOTHING did.
    const ccsRes = await client.query(
      `INSERT INTO candidate_company_status (candidate_id, company_id, status, serial)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (candidate_id, company_id) DO UPDATE SET
         status = EXCLUDED.status, serial = EXCLUDED.serial, deleted_at = NULL,
         ratings = NULL, feedback_text = NULL, processed_at = NULL,
         interview_started_at = NULL, dispatched_at = NULL, misses = 0
       WHERE candidate_company_status.deleted_at IS NOT NULL
       RETURNING id`,
      [candidateId, companyId, isWaitlisted ? 'Waitlisted' : 'Pending', serial]
    );
    if (!ccsRes.rows.length) continue; // conflict — duplicate company id in the request, or already active

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

  return { assigned, waitlisted };
}

module.exports = { assignCompanies };
