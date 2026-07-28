import { useEffect, useState } from 'react';
import { api } from '../api';

const MAX_COMPANIES = 3;
const REMOVABLE_STATUSES = ['Pending', 'Waitlisted'];
// "Done with interviews" for the reassurance note below — mirrors
// lib/pingLadder.js's DONE_STATUSES, minus the need to import a backend file
// into a frontend component.
const SETTLED_STATUSES = ['Selected', 'Rejected', 'Hold', 'Shortlisted', 'No_Show'];

function fmtDateTime(iso) {
  return iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

// Extracted out of CandidateAdmin.jsx (2026-07-26) so the same tool can also
// render on the Gate page — staff manning the entrance need candidate lookup
// immediately, not just from the Users tab. `initialToken`, combined with the
// parent giving this a fresh `key` per registration, lets CandidateAdmin.jsx
// still chain straight from "just registered" into this view without owning
// any of the lookup state itself.
export default function CandidateLookup({ initialToken = '' }) {
  const [lookupToken, setLookupToken] = useState(initialToken);
  const [lookupMobile, setLookupMobile] = useState('');
  const [candidate, setCandidate] = useState(null);
  const [mobileMatches, setMobileMatches] = useState(null);
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

  async function lookupByToken(e, tokenOverride) {
    if (e) e.preventDefault();
    const token = (tokenOverride || lookupToken).trim();
    if (!token) return;
    setLooking(true);
    setLookupError(null);
    setMobileMatches(null);
    try {
      const result = await api.getCandidate(token);
      setCandidate(result);
      setLookupToken(token);
      setToAdd([]);
    } catch (err) {
      setCandidate(null);
      setLookupError(err.message);
    } finally {
      setLooking(false);
    }
  }

  // Mobile dedup is per-fair-cycle now, not global (fair_cycle_isolation_
  // plan.md Phase 2) — the same person can have more than one candidate row
  // across different cycles, so this can legitimately need a disambiguation
  // step rather than always resolving to exactly one record.
  async function lookupByMobile(e) {
    e.preventDefault();
    const mobile = lookupMobile.trim();
    if (!mobile) return;
    setLooking(true);
    setLookupError(null);
    setCandidate(null);
    setMobileMatches(null);
    try {
      const matches = await api.listCandidates(undefined, undefined, mobile);
      if (!matches.length) {
        setLookupError('No candidate found with that mobile number');
      } else if (matches.length === 1) {
        await lookupByToken(null, matches[0].token_no);
      } else {
        setMobileMatches(matches);
      }
    } catch (err) {
      setLookupError(err.message);
    } finally {
      setLooking(false);
    }
  }

  useEffect(() => {
    if (initialToken) lookupByToken(null, initialToken);
    // Mount-only: the parent forces a remount (via `key`) whenever it wants
    // this to fire again for a new token, rather than this effect re-running
    // on every initialToken change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Optimistic: the row disappears the instant staff click Remove, instead of
  // waiting on the round trip + a full re-lookup — reconciliation is a no-op
  // on success (the row's already gone), and a failure re-inserts it at its
  // original position and surfaces an error toast so staff aren't misled into
  // thinking a company got removed when it didn't.
  async function removeCompany(companyId) {
    if (!candidate) return;
    const index = candidate.companies.findIndex((c) => c.company_id === companyId);
    const removed = candidate.companies[index];
    setCandidate((cur) => ({ ...cur, companies: cur.companies.filter((c) => c.company_id !== companyId) }));
    setBusy(true);
    try {
      await api.removeCandidateCompany(candidate.id, companyId);
      showToast('Company removed');
    } catch (err) {
      setCandidate((cur) => {
        const companies = [...cur.companies];
        companies.splice(index, 0, removed);
        return { ...cur, companies };
      });
      showToast(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  // Re-looks-up on success rather than patching optimistically — unlike
  // remove (a simple row disappearance), this changes the row's status,
  // serial, and queue position all at once, so a full refresh is simpler and
  // safer than reconstructing the new row shape client-side.
  async function reactivateCompany(companyId) {
    if (!candidate) return;
    setBusy(true);
    try {
      const result = await api.reactivateCandidateCompany(candidate.id, companyId);
      showToast(result.status === 'Waitlisted' ? 'Reactivated — waitlisted (company full)' : 'Reactivated — back in the queue');
      await lookupByToken(null, candidate.token_no);
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
      setToAdd([]);
      await lookupByToken(null, candidate.token_no);
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
  const settledCount = candidate ? candidate.companies.filter((c) => SETTLED_STATUSES.includes(c.status)).length : 0;

  return (
    <div>
      <div className="sec-label" style={{ marginBottom: 10 }}>Look up / manage candidate</div>

      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 14 }}>
        <form onSubmit={lookupByToken} style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
          <div className="field" style={{ maxWidth: 180 }}>
            <label>Token (e.g. A-42)</label>
            <input value={lookupToken} onChange={(e) => setLookupToken(e.target.value)} />
          </div>
          <button className="btn ghost" style={{ width: 'auto', padding: '11px 18px' }} type="submit" disabled={looking}>
            {looking ? 'Looking up…' : 'Look up'}
          </button>
        </form>

        <form onSubmit={lookupByMobile} style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
          <div className="field" style={{ maxWidth: 180 }}>
            <label>Mobile number</label>
            <input value={lookupMobile} onChange={(e) => setLookupMobile(e.target.value)} />
          </div>
          <button className="btn ghost" style={{ width: 'auto', padding: '11px 18px' }} type="submit" disabled={looking}>
            {looking ? 'Looking up…' : 'Look up'}
          </button>
        </form>
      </div>

      {lookupError && <div className="error-note">{lookupError}</div>}

      {mobileMatches && (
        <div style={{ maxWidth: 560, marginBottom: 14 }}>
          <p className="save-note" style={{ marginTop: 0 }}>
            {mobileMatches.length} candidates match that mobile number — pick one:
          </p>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Name</th><th>Token</th><th>Registered</th><th></th></tr></thead>
              <tbody>
                {mobileMatches.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td className="mono">{m.token_no}</td>
                    <td>{fmtDateTime(m.registered_at)}</td>
                    <td>
                      <button
                        className="btn ghost"
                        style={{ width: 'auto', padding: '6px 12px' }}
                        onClick={() => lookupByToken(null, m.token_no)}
                      >
                        Select
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {candidate && (
        <div style={{ maxWidth: 620 }}>
          <div className="candidate-detail-card">
            <div className="kv-grid">
              <div><span className="kv-label">Name</span><span className="kv-val">{candidate.name}</span></div>
              <div><span className="kv-label">Token</span><span className="kv-val mono">{candidate.token_no}</span></div>
              <div><span className="kv-label">Mobile</span><span className="kv-val">{candidate.mobile || '—'}</span></div>
              <div><span className="kv-label">Age</span><span className="kv-val">{candidate.age ?? '—'}</span></div>
              <div><span className="kv-label">Qualification</span><span className="kv-val">{candidate.qualification || '—'}</span></div>
              <div><span className="kv-label">Field</span><span className="kv-val">{candidate.field || '—'}</span></div>
              <div><span className="kv-label">Gender</span><span className="kv-val">{candidate.gender || '—'}</span></div>
              <div>
                <span className="kv-label">SDC candidate</span>
                <span className="kv-val">{candidate.is_sdc == null ? '—' : (candidate.is_sdc ? 'Yes' : 'No')}</span>
              </div>
              <div>
                <span className="kv-label">Travel time</span>
                <span className="kv-val">{candidate.travel_time_minutes != null ? `${candidate.travel_time_minutes} min` : '—'}</span>
              </div>
              <div><span className="kv-label">Batch</span><span className="kv-val">{candidate.batch_id ? `#${candidate.batch_id}` : '—'}</span></div>
              <div><span className="kv-label">Registered</span><span className="kv-val">{fmtDateTime(candidate.registered_at)}</span></div>
              <div>
                <span className="kv-label">Checked in</span>
                <span className="kv-val">{candidate.checked_in_at ? fmtDateTime(candidate.checked_in_at) : 'Not checked in'}</span>
              </div>
              <div><span className="kv-label">Resume</span><span className="kv-val">{candidate.resume_uploaded_at ? 'Uploaded' : 'Not uploaded'}</span></div>
            </div>
          </div>

          <div className="manage-companies-panel">
            <div className="sec-label" style={{ marginBottom: 8 }}>Companies</div>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>Company</th><th>Status</th><th>Details</th><th></th></tr></thead>
                <tbody>
                  {candidate.companies.map((c) => (
                    <tr key={c.company_id}>
                      <td>{c.company_name}</td>
                      <td><span className={`chip-st ${c.status.toLowerCase()}`}>{c.status}</span></td>
                      <td className="save-note" style={{ fontSize: 11.5, textAlign: 'left' }}>
                        {c.serial != null && <>Serial #{c.serial}<br /></>}
                        {c.dispatched_at && <>Dispatched {fmtDateTime(c.dispatched_at)}<br /></>}
                        {c.interview_started_at && <>Started {fmtDateTime(c.interview_started_at)}<br /></>}
                        {c.misses > 0 && <>{c.misses} missed call{c.misses === 1 ? '' : 's'}</>}
                      </td>
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
                        {c.status === 'No_Show' && (
                          <button
                            className="btn ghost"
                            style={{ width: 'auto', padding: '6px 12px', color: 'var(--st-selected)' }}
                            disabled={busy}
                            onClick={() => reactivateCompany(c.company_id)}
                          >
                            Reactivate
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!candidate.companies.length && (
                    <tr><td colSpan={4} className="save-note">No companies selected yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="sec-label" style={{ marginTop: 16, marginBottom: 8 }}>
              Add companies {atCap && '— at the 3-company limit'}
            </div>
            {settledCount > 0 && !atCap && (
              <p className="save-note" style={{ marginTop: 0, marginBottom: 10, textAlign: 'left' }}>
                This candidate has completed interviews at {settledCount} compan{settledCount === 1 ? 'y' : 'ies'} — you can still add another company below.
              </p>
            )}
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
        </div>
      )}

      {toast && <div className={`toast${toast.isErr ? ' err' : ''}`}>{toast.text}</div>}
    </div>
  );
}
