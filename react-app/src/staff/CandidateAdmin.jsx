import { useState } from 'react';
import { api } from '../api';
import { useAuth } from './AuthContext';
import { useCenter } from './CenterContext';
import WorkExperienceFields from '../common/WorkExperienceFields';

const GENDERS = ['Male', 'Female', 'Other'];

// Registration half of the admin/registration_staff candidate tools (see
// StaffApp.jsx/UserAdmin.jsx): manual registration (the QR-failure exception
// path, "flow D" — POST /api/register already existed and was already
// tested, it just had no frontend caller until now). Registration
// deliberately collects no company_ids — company assignment goes through
// CandidateLookup on the Gate page instead, either by staff there or later
// by the candidate themselves once checked in.
export default function CandidateAdmin() {
  const { user } = useAuth();
  const { centers, selectedCenterId } = useCenter();
  const [form, setForm] = useState({ name: '', mobile: '', age: '', qualification: '', gender: '', is_sdc: '', travel_time_minutes: '', employment_status: '' });
  const [workExperience, setWorkExperience] = useState([]);
  // candidate_and_desk_improvements_plan.md §B — same condition as DetailsForm.jsx
  const showWorkExperience = form.employment_status === 'Working' || form.employment_status === 'Experienced';
  // Only shown/required when the Nav switcher is on "All centers" and 2+
  // Centers exist — fair_cycle_isolation_plan.md Phase 5 follow-up:
  // registerCandidate() needs to know which Center's active fair to book
  // into whenever more than one could apply.
  const [centerId, setCenterId] = useState('');
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState(null);
  const [toast, setToast] = useState(null);

  // Delete Candidate: search by mobile (dedup is per-fair-cycle now, so the
  // same number can genuinely match more than one candidate — same
  // disambiguation shape as CandidateLookup.jsx's mobile lookup), then delete
  // whichever match staff mean. DELETE /candidates/:id itself decides soft
  // vs hard delete server-side depending on whether a fair is currently
  // active.
  const [delMobile, setDelMobile] = useState('');
  const [delMatches, setDelMatches] = useState(null);
  const [delSearching, setDelSearching] = useState(false);
  const [delError, setDelError] = useState(null);
  const [delBusyId, setDelBusyId] = useState(null);

  function showToast(text, isErr) {
    setToast({ text, isErr });
    setTimeout(() => setToast(null), 2500);
  }

  function set(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function register(e) {
    e.preventDefault();
    if (user.role === 'admin' && !selectedCenterId && centers.length > 1 && !centerId) {
      setRegisterError('Pick a center');
      return;
    }
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
        employment_status: form.employment_status || undefined,
        work_experience: showWorkExperience ? workExperience.filter((e) => e.company_name.trim()) : undefined,
        center_id: selectedCenterId || centerId || undefined,
      });
      showToast(`Registered ${result.token} — check them in and assign companies on the Gate tab`);
      setForm({ name: '', mobile: '', age: '', qualification: '', gender: '', is_sdc: '', travel_time_minutes: '', employment_status: '' });
      setWorkExperience([]);
    } catch (err) {
      setRegisterError(err.message);
    } finally {
      setRegistering(false);
    }
  }

  async function searchToDelete(e) {
    e.preventDefault();
    const mobile = delMobile.trim();
    if (!mobile) return;
    setDelSearching(true);
    setDelError(null);
    setDelMatches(null);
    try {
      const matches = await api.listCandidates(undefined, undefined, mobile);
      if (!matches.length) setDelError('No candidate found with that mobile number');
      else setDelMatches(matches);
    } catch (err) {
      setDelError(err.message);
    } finally {
      setDelSearching(false);
    }
  }

  async function deleteCandidate(c) {
    if (!window.confirm(`Delete ${c.name} (${c.token_no})? This can't be undone.`)) return;
    setDelBusyId(c.id);
    try {
      const result = await api.deleteCandidate(c.id);
      showToast(result.deleted === 'soft' ? `${c.token_no} removed` : `${c.token_no} permanently deleted`);
      setDelMatches((prev) => prev.filter((m) => m.id !== c.id));
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setDelBusyId(null);
    }
  }

  return (
    <>
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
          <input type="number" value={form.age} onChange={(e) => set('age', e.target.value)} required />
        </div>
        <div className="field" style={{ maxWidth: 180 }}>
          <label>Qualification</label>
          <input value={form.qualification} onChange={(e) => set('qualification', e.target.value)} required />
        </div>
        <div className="field" style={{ maxWidth: 160 }}>
          <label>Gender</label>
          <select value={form.gender} onChange={(e) => set('gender', e.target.value)} required>
            <option value="" disabled>Select…</option>
            {GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
        <div className="field" style={{ maxWidth: 160 }}>
          <label>SDC candidate?</label>
          <select value={form.is_sdc} onChange={(e) => set('is_sdc', e.target.value)} required>
            <option value="" disabled>Select…</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </div>
        <div className="field" style={{ maxWidth: 140 }}>
          <label>Travel time (min)</label>
          <input type="number" value={form.travel_time_minutes} onChange={(e) => set('travel_time_minutes', e.target.value)} />
        </div>
        <div className="field" style={{ maxWidth: 160 }}>
          <label>Employment status</label>
          <select value={form.employment_status} onChange={(e) => set('employment_status', e.target.value)} required>
            <option value="" disabled>Select…</option>
            <option value="Fresher">Fresher</option>
            <option value="Studying">Studying</option>
            <option value="Working">Working</option>
            <option value="Experienced">Experienced</option>
          </select>
        </div>
        {showWorkExperience && (
          <div style={{ flexBasis: '100%' }}>
            <WorkExperienceFields entries={workExperience} onChange={setWorkExperience} />
          </div>
        )}
        {user.role === 'admin' && !selectedCenterId && centers.length > 1 && (
          <div className="field" style={{ maxWidth: 160 }}>
            <label>Center</label>
            <select value={centerId} onChange={(e) => setCenterId(e.target.value)} required>
              <option value="" disabled>Select…</option>
              {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <button className="btn" style={{ width: 'auto', padding: '11px 18px' }} type="submit" disabled={registering}>
          {registering ? 'Registering…' : '+ Register'}
        </button>
      </form>
      {registerError && <div className="error-note" style={{ marginTop: 8 }}>{registerError}</div>}
    </div>

    <div style={{ marginTop: 28 }}>
      <div className="sec-label" style={{ marginBottom: 10 }}>Delete Candidate</div>
      <form onSubmit={searchToDelete} style={{ display: 'flex', gap: 8, alignItems: 'end', marginBottom: 14 }}>
        <div className="field" style={{ maxWidth: 200 }}>
          <label>Mobile number</label>
          <input
            inputMode="numeric"
            value={delMobile}
            onChange={(e) => setDelMobile(e.target.value.replace(/\D/g, '').slice(0, 10))}
          />
        </div>
        <button className="btn ghost" style={{ width: 'auto', padding: '11px 18px' }} type="submit" disabled={delSearching}>
          {delSearching ? 'Searching…' : 'Search'}
        </button>
      </form>
      {delError && <div className="error-note">{delError}</div>}
      {delMatches && (
        <div className="table-wrap" style={{ maxWidth: 560 }}>
          <table className="data-table">
            <thead><tr><th>Name</th><th>Token</th><th>Registered</th><th></th></tr></thead>
            <tbody>
              {delMatches.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="mono">{c.token_no}</td>
                  <td>{new Date(c.registered_at).toLocaleDateString([], { dateStyle: 'medium' })}</td>
                  <td>
                    <button
                      className="btn ghost"
                      style={{ width: 'auto', padding: '6px 12px', color: 'var(--st-rejected)' }}
                      disabled={delBusyId === c.id}
                      onClick={() => deleteCandidate(c)}
                    >
                      {delBusyId === c.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </td>
                </tr>
              ))}
              {!delMatches.length && (
                <tr><td colSpan={4} className="save-note">No candidates left matching that number.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>

    {toast && <div className={`toast${toast.isErr ? ' err' : ''}`}>{toast.text}</div>}
    </>
  );
}
