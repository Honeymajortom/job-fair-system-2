import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api';
import SiteCredit from './SiteCredit.jsx';

const MAX_COMPANIES = 3;

// new_architecture_uiux_spec.html §01 step 2. open_slots is known-stale for
// the new capacity-gate model (still reads v1's interview_slots) — queue_depth
// (live ZCARD) is what actually reflects "how many people are ahead of you".
export default function CompanyTiles() {
  const [companies, setCompanies] = useState(null);
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.qrCompanies().then(setCompanies).catch((err) => setError(err.message));
  }, []);

  // LivePosition's history-trap only buffers one back-press at a time — a
  // fast burst (mobile hardware/gesture back is the common case) can outrun
  // the popstate handler and land here anyway. This is the second line of
  // defense: if this session already registered, bounce forward immediately
  // instead of letting a slipped-through back-press re-open the form. Checked
  // after all hooks are declared so hook order stays unconditional.
  const registeredToken = sessionStorage.getItem('registered_token');
  if (registeredToken) return <Navigate to={`/schedule/${registeredToken}`} replace />;

  function toggle(id) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_COMPANIES) return prev;
      return [...prev, id];
    });
  }

  function continueToDetails() {
    navigate('/register/details', { state: { company_ids: selected } });
  }

  return (
    <div className="m-shell">
      <div className="app-head">
        <div className="fair">Pick companies</div>
        <div className="sub">UP TO 3 · SPOTS ARE LIMITED</div>
      </div>
      <div className="m-body">
        {error && <div className="error-note">{error}</div>}
        {!companies && !error && <div className="save-note">Loading companies…</div>}
        {/* Booking-cap enforcement (new_architecture.md §3.1) happens at
            registration time, not here — a pick past the cap comes back
            Waitlisted rather than the tile being pre-disabled. open_slots
            (v1's interview_slots-derived field) is known-stale for the new
            model, so it's deliberately not used to gate selection; queue_depth
            (live) is shown as an informational badge only. */}
        {companies && companies.map((c) => {
          const sel = selected.includes(c.id);
          return (
            <button
              key={c.id}
              className={`tile${sel ? ' sel' : ''}`}
              onClick={() => toggle(c.id)}
              type="button"
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
      </div>
      <div className="sticky-cta">
        <button className="btn" disabled={selected.length === 0} onClick={continueToDetails}>
          Continue · {selected.length} of {MAX_COMPANIES} selected
        </button>
      </div>
      <SiteCredit />
    </div>
  );
}
