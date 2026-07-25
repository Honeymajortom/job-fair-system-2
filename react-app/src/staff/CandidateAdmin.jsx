import { useEffect, useState } from 'react';
import { api } from '../api';

const MAX_COMPANIES = 3;
const REMOVABLE_STATUSES = ['Pending', 'Waitlisted'];
const GENDERS = ['Male', 'Female', 'Other'];

// Two tools in one section, admin + registration_staff (see StaffApp.jsx/
// UserAdmin.jsx): manual registration (the QR-failure exception path, "flow
// D" — POST /api/register already existed and was already tested, it just
// had no frontend caller until now) and company reassignment (the staff
// override for the candidate self-service pick, which is one-shot by design
// — see SelectCompanies.jsx/routes/public.js's select-companies route).
// Registration deliberately collects no company_ids — company assignment
// always goes through the "look up / manage" tool below, either by staff
// right here or later by the candidate themselves once checked in.
export default function CandidateAdmin() {
  const [form, setForm] = useState({ name: '', mobile: '', age: '', qualification: '', gender: '', is_sdc: '', travel_time_minutes: '' });
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState(null);

  const [lookupToken, setLookupToken] = useState('');
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

  function set(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function register(e) {
    e.preventDefault();
    setRegistering(true);
    setRegisterError(null);
    try {
      const result = await api.register({
        name: form.name,
        mobile: form.mobile || undefined,
        age: form.age ? Number(form.age) : undefined,
        qualification: form.qualification || undefined,
        gender: form.gender || undefined,
        is_sdc: form.is_sdc === '' ? undefined : form.is_sdc === 'yes',
        travel_time_minutes: form.travel_time_minutes ? Number(form.travel_time_minutes) : undefined,
      });
      showToast(`Registered ${result.token} — check them in on the Gate tab, or assign companies below`);
      setForm({ name: '', mobile: '', age: '', qualification: '', gender: '', is_sdc: '', travel_time_minutes: '' });
      // Chain straight into the lookup tool below with the new token, since
      // register-then-manage-companies is the realistic single motion here.
      setLookupToken(result.token);
      lookup(null, result.token);
    } catch (err) {
      setRegisterError(err.message);
    } finally {
      setRegistering(false);
    }
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
    <div style={{ marginTop: 28 }}>
      <div className="sec-label" style={{ marginBottom: 10 }}>Register new candidate</div>
      <form onSubmit={register} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
        <div className="field" style={{ maxWidth: 200 }}>
          <label>Full name</label>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} required />
        </div>
        <div className="field" style={{ maxWidth: 180 }}>
          <label>Mobile (optional)</label>
          <input
            inputMode="numeric"
            value={form.mobile}
            onChange={(e) => set('mobile', e.target.value.replace(/\D/g, '').slice(0, 10))}
          />
        </div>
        <div className="field" style={{ maxWidth: 100 }}>
          <label>Age</label>
          <input type="number" value={form.age} onChange={(e) => set('age', e.target.value)} />
        </div>
        <div className="field" style={{ maxWidth: 180 }}>
          <label>Qualification</label>
          <input value={form.qualification} onChange={(e) => set('qualification', e.target.value)} />
        </div>
        <div className="field" style={{ maxWidth: 160 }}>
          <label>Gender</label>
          <select value={form.gender} onChange={(e) => set('gender', e.target.value)}>
            <option value="">Prefer not to say</option>
            {GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
        <div className="field" style={{ maxWidth: 160 }}>
          <label>SDC candidate?</label>
          <select value={form.is_sdc} onChange={(e) => set('is_sdc', e.target.value)}>
            <option value="">Not sure</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </div>
        <div className="field" style={{ maxWidth: 140 }}>
          <label>Travel time (min)</label>
          <input type="number" value={form.travel_time_minutes} onChange={(e) => set('travel_time_minutes', e.target.value)} />
        </div>
        <button className="btn" style={{ width: 'auto', padding: '11px 18px' }} type="submit" disabled={registering}>
          {registering ? 'Registering…' : '+ Register'}
        </button>
      </form>
      {registerError && <div className="error-note" style={{ marginTop: 8 }}>{registerError}</div>}

      <div className="sec-label" style={{ marginTop: 28, marginBottom: 10 }}>Look up / manage candidate</div>
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
