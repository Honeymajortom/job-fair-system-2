import { useEffect, useState } from 'react';
import { api } from '../api';

const MAX_COMPANIES = 3;

// Rendered inline by LivePosition.jsx once a candidate is checked in but
// hasn't picked companies yet (data.checked_in && data.slots.length === 0) —
// not its own route. Adapted from the old CompanyTiles.jsx (v1's pre-check-in
// registration step), now moved to run after the Gate check-in instead of
// before it, per the new candidate journey. Booking-cap enforcement
// (new_architecture.md §3.1) still happens server-side, not here — a pick
// past the cap comes back Waitlisted rather than the tile being pre-disabled.
export default function SelectCompanies({ qr, onDone }) {
  const [companies, setCompanies] = useState(null);
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.qrCompanies().then(setCompanies).catch((err) => setError(err.message));
  }, []);

  function toggle(id) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_COMPANIES) return prev;
      return [...prev, id];
    });
  }

  async function submit() {
    if (!selected.length || !qr) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.selectCompanies(qr, selected);
      onDone();
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <>
      <p className="desk-call-note calm" style={{ marginTop: 0 }}>
        You're checked in! Now pick up to {MAX_COMPANIES} companies to join the queue for.
      </p>
      {error && <div className="error-note">{error}</div>}
      {!companies && !error && <div className="save-note">Loading companies…</div>}
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
              {c.location ? `${c.location} · ` : ''}
              {c.floor_number != null ? `Floor ${c.floor_number} · ` : ''}
              {c.field}
            </div>
          </button>
        );
      })}
      <div className="sticky-cta">
        <button className="btn" disabled={selected.length === 0 || submitting} onClick={submit}>
          {submitting ? 'Joining…' : `Join the queue · ${selected.length} of ${MAX_COMPANIES} selected`}
        </button>
      </div>
    </>
  );
}
