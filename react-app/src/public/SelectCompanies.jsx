import { useEffect, useState } from 'react';
import { api } from '../api';

// Rendered inline by LivePosition.jsx once a candidate is checked in but
// hasn't picked companies yet (data.checked_in && data.slots.length === 0) —
// not its own route. Adapted from the old CompanyTiles.jsx (v1's pre-check-in
// registration step), now moved to run after the Gate check-in instead of
// before it, per the new candidate journey. Booking-cap enforcement
// (new_architecture.md §3.1) still happens server-side, not here — a pick
// past the cap comes back Waitlisted rather than the tile being pre-disabled.
// candidate_and_desk_improvements_plan.md §A: the cap is admin-configurable
// per fair cycle now (fair_settings.max_companies_per_candidate) — read off
// GET /qr/companies's response instead of a hardcoded constant, defaulting to
// 3 only for the brief moment before that response lands.
export default function SelectCompanies({ qr, onDone }) {
  const [companies, setCompanies] = useState(null);
  const [maxCompanies, setMaxCompanies] = useState(3);
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.qrCompanies(qr)
      .then((res) => {
        setCompanies(res.companies);
        setMaxCompanies(res.max_companies_per_candidate);
      })
      .catch((err) => setError(err.message));
  }, [qr]);

  function toggle(id) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= maxCompanies) return prev;
      return [...prev, id];
    });
  }

  async function submit() {
    if (!selected.length) return;
    // A candidate who recovered their session on a different device
    // (RecoverToken.jsx) never has this device's checkin_qr in localStorage
    // — same gap FeedbackForm.jsx guards against. Previously this just
    // silently returned with no feedback, leaving the candidate stuck
    // staring at a button that does nothing.
    if (!qr) {
      setError('This needs the device you registered on — please ask staff for help.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.selectCompanies(qr, selected);
      // assignCompanies() silently skips a requested company that isn't on
      // this cycle's roster anymore (closed/removed in the gap between this
      // screen's fetch and submit) — company_ids picked but absent from
      // both assigned and waitlisted never got a booking row at all. Tell
      // the candidate rather than letting them vanish with no explanation.
      const returnedIds = new Set([...res.assigned, ...res.waitlisted].map((c) => c.company_id));
      const droppedNames = companies
        .filter((c) => selected.includes(c.id) && !returnedIds.has(c.id))
        .map((c) => c.company_name);
      await onDone(droppedNames);
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <>
      <p className="desk-call-note calm" style={{ marginTop: 0 }}>
        You're checked in! Now pick up to {maxCompanies} companies to join the queue for.
      </p>
      {!qr && (
        <div className="error-note">This needs the device you registered on — please ask staff for help.</div>
      )}
      {error && <div className="error-note">{error}</div>}
      {!companies && !error && <div className="save-note">Loading companies…</div>}
      {companies && companies.length === 0 && (
        <p className="save-note">No companies are open for registration right now — check with staff.</p>
      )}
      {companies && companies.map((c) => {
        const sel = selected.includes(c.id);
        return (
          <button
            key={c.id}
            className={`tile${sel ? ' sel' : ''}`}
            onClick={() => toggle(c.id)}
            type="button"
            disabled={submitting}
          >
            {sel && <span className="tick">✓</span>}
            <span className="slots">{c.queue_depth} ahead</span>
            <div className="co">{c.company_name}</div>
            <div className="loc">
              {[c.location, c.floor_number != null ? `Floor ${c.floor_number}` : null, c.field].filter(Boolean).join(' · ')}
            </div>
          </button>
        );
      })}
      <div className="sticky-cta">
        <button className="btn" disabled={selected.length === 0 || submitting || !qr} onClick={submit}>
          {submitting ? 'Joining…' : `Join the queue · ${selected.length} of ${maxCompanies} selected`}
        </button>
      </div>
    </>
  );
}
