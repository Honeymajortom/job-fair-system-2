import { useEffect, useState } from 'react';
import { api } from '../api';

const MAX_COMPANIES = 3;
const REMOVABLE_STATUSES = ['Pending', 'Waitlisted'];

// Extracted out of CandidateAdmin.jsx (2026-07-26) so the same tool can also
// render on the Gate page — staff manning the entrance need candidate lookup
// immediately, not just from the Users tab. `initialToken`, combined with the
// parent giving this a fresh `key` per registration, lets CandidateAdmin.jsx
// still chain straight from "just registered" into this view without owning
// any of the lookup state itself.
export default function CandidateLookup({ initialToken = '' }) {
  const [lookupToken, setLookupToken] = useState(initialToken);
  const [candidate, setCandidate] = useState(null);
  const [lookupError, setLookupError] = useState(null);
  const [looking, setLooking] = useState(false);

  const [companies, setCompanies] = useState([]);
  const [toAdd, setToAdd] = useState([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => { api.getCompanies().then(setCompanies).catch(() => {}); }, []);

  function showToast(text, isErr) {
    setToast({ text, isErr });
    setTimeout(() => setToast(null), 2500);
  }

  async function lookup(e, tokenOverride) {
    if (e) e.preventDefault();
    const token = (tokenOverride || lookupToken).trim();
    if (!token) return;
    setLooking(true);
    setLookupError(null);
    try {
      const result = await api.getCandidate(token);
      setCandidate(result);
      setToAdd([]);
    } catch (err) {
      setCandidate(null);
      setLookupError(err.message);
    } finally {
      setLooking(false);
    }
  }

  useEffect(() => {
    if (initialToken) lookup(null, initialToken);
    // Mount-only: the parent forces a remount (via `key`) whenever it wants
    // this to fire again for a new token, rather than this effect re-running
    // on every initialToken change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function removeCompany(companyId) {
    if (!candidate) return;
    setBusy(true);
    try {
      await api.removeCandidateCompany(candidate.id, companyId);
      showToast('Company removed');
      await lookup(null, candidate.token_no);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function addCompanies() {
    if (!candidate || !toAdd.length) return;
    setBusy(true);
    try {
      const result = await api.addCandidateCompanies(candidate.id, toAdd);
      if (result.waitlisted.length) {
        showToast(`Added — ${result.waitlisted.map((w) => w.company_name).join(', ')} waitlisted (full)`);
      } else {
        showToast('Companies added');
      }
      await lookup(null, candidate.token_no);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  function toggleAdd(id) {
    setToAdd((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      const activeCount = candidate ? candidate.companies.length : 0;
      if (activeCount + prev.length >= MAX_COMPANIES) return prev;
      return [...prev, id];
    });
  }

  const activeCompanyIds = candidate ? new Set(candidate.companies.map((c) => c.company_id)) : new Set();
  const availableToAdd = companies.filter((c) => !activeCompanyIds.has(c.id));
  const atCap = candidate && candidate.companies.length >= MAX_COMPANIES;

  return (
    <div>
      <div className="sec-label" style={{ marginBottom: 10 }}>Look up / manage candidate</div>
      <form onSubmit={lookup} style={{ display: 'flex', gap: 8, alignItems: 'end', marginBottom: 14 }}>
        <div className="field" style={{ maxWidth: 200 }}>
          <label>Token (e.g. A-42)</label>
          <input value={lookupToken} onChange={(e) => setLookupToken(e.target.value)} />
        </div>
        <button className="btn ghost" style={{ width: 'auto', padding: '11px 18px' }} type="submit" disabled={looking}>
          {looking ? 'Looking up…' : 'Look up'}
        </button>
      </form>
      {lookupError && <div className="error-note">{lookupError}</div>}

      {candidate && (
        <div style={{ maxWidth: 560 }}>
          <p className="save-note" style={{ marginTop: 0 }}>
            <b>{candidate.name}</b> · {candidate.token_no} · {candidate.checked_in_at ? 'checked in' : 'not checked in'}
          </p>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Company</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {candidate.companies.map((c) => (
                  <tr key={c.company_id}>
                    <td>{c.company_name}</td>
                    <td><span className={`role-chip`}>{c.status}</span></td>
                    <td>
                      {REMOVABLE_STATUSES.includes(c.status) && (
                        <button
                          className="btn ghost"
                          style={{ width: 'auto', padding: '6px 12px', color: 'var(--st-rejected)' }}
                          disabled={busy}
                          onClick={() => removeCompany(c.company_id)}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {!candidate.companies.length && (
                  <tr><td colSpan={3} className="save-note">No companies selected yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="sec-label" style={{ marginTop: 16, marginBottom: 8 }}>
            Add companies {atCap && '— at the 3-company limit'}
          </div>
          {!atCap && (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                {availableToAdd.map((c) => {
                  const sel = toAdd.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={`tile${sel ? ' sel' : ''}`}
                      style={{ minWidth: 140 }}
                      onClick={() => toggleAdd(c.id)}
                    >
                      {sel && <span className="tick">✓</span>}
                      <div className="co">{c.company_name}</div>
                    </button>
                  );
                })}
              </div>
              <button className="btn" style={{ width: 'auto', padding: '10px 16px' }} disabled={!toAdd.length || busy} onClick={addCompanies}>
                {busy ? 'Saving…' : `Add ${toAdd.length || ''} compan${toAdd.length === 1 ? 'y' : 'ies'}`}
              </button>
            </>
          )}
        </div>
      )}

      {toast && <div className={`toast${toast.isErr ? ' err' : ''}`}>{toast.text}</div>}
    </div>
  );
}
