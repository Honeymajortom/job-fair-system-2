import { useState } from 'react';
import { api } from '../api';
import { useAuth } from './AuthContext';
import { useCenter } from './CenterContext';

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
  const [form, setForm] = useState({ name: '', mobile: '', age: '', qualification: '', gender: '', is_sdc: '', travel_time_minutes: '' });
  // Only shown/required when the Nav switcher is on "All centers" and 2+
  // Centers exist — fair_cycle_isolation_plan.md Phase 5 follow-up:
  // registerCandidate() needs to know which Center's active fair to book
  // into whenever more than one could apply.
  const [centerId, setCenterId] = useState('');
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState(null);
  const [toast, setToast] = useState(null);

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
        center_id: selectedCenterId || centerId || undefined,
      });
      showToast(`Registered ${result.token} — check them in and assign companies on the Gate tab`);
      setForm({ name: '', mobile: '', age: '', qualification: '', gender: '', is_sdc: '', travel_time_minutes: '' });
    } catch (err) {
      setRegisterError(err.message);
    } finally {
      setRegistering(false);
    }
  }

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

      {toast && <div className={`toast${toast.isErr ? ' err' : ''}`}>{toast.text}</div>}
    </div>
  );
}
