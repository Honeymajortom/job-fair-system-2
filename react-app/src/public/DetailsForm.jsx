import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';

const TRAVEL_PRESETS = [10, 25, 45, 60];

// new_architecture_uiux_spec.html §01 step 3. travel_time_minutes is the one
// field this form has that v1's DetailsForm didn't — it's what lets the ping
// ladder (Phase 4) ever reach the "come now" rung instead of only position-
// based staging/gate.
export default function DetailsForm() {
  const location = useLocation();
  const navigate = useNavigate();
  const companyIds = location.state?.company_ids || [];

  const [form, setForm] = useState({ name: '', mobile: '', age: '', qualification: '', travel_time_minutes: '', gender: '', is_sdc: '' });
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  function set(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(e) {
    e.preventDefault();
    if (!companyIds.length) {
      setError('No companies selected — go back and pick at least one.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const qr_token = sessionStorage.getItem('fair_qr_token');
      const result = await api.qrRegister({
        qr_token,
        name: form.name,
        mobile: form.mobile,
        age: form.age ? Number(form.age) : undefined,
        qualification: form.qualification || undefined,
        travel_time_minutes: form.travel_time_minutes ? Number(form.travel_time_minutes) : undefined,
        gender: form.gender || undefined,
        is_sdc: form.is_sdc === '' ? undefined : form.is_sdc === 'yes',
        company_ids: companyIds,
      });
      // The check-in QR is only ever handed out here, at registration — the
      // live schedule endpoint deliberately won't echo it back (red-team
      // finding C1: token_no is guessable, so resending the HMAC on every
      // poll would leak the gate check-in bypass to anyone who guesses it).
      if (result.qr) localStorage.setItem(`checkin_qr_${result.token}`, result.qr);
      navigate(`/schedule/${result.token}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="m-shell">
      <div className="app-head">
        <div className="fair">Your details</div>
        <div className="sub">ONE FORM · NO PASSWORD</div>
      </div>
      <form className="m-body" onSubmit={submit}>
        <div className="field">
          <label>Full name</label>
          <input required value={form.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="field">
          <label>Mobile (checked for duplicates)</label>
          <input required inputMode="numeric" value={form.mobile} onChange={(e) => set('mobile', e.target.value)} />
        </div>
        <div className="field">
          <label>Age</label>
          <input type="number" value={form.age} onChange={(e) => set('age', e.target.value)} />
        </div>
        <div className="field">
          <label>Qualification</label>
          <input value={form.qualification} onChange={(e) => set('qualification', e.target.value)} />
        </div>
        <div className="field">
          <label>Gender</label>
          <select value={form.gender} onChange={(e) => set('gender', e.target.value)}>
            <option value="">Prefer not to say</option>
            <option value="Male">Male</option>
            <option value="Female">Female</option>
            <option value="Other">Other</option>
          </select>
        </div>
        <div className="field">
          <label>SDC candidate?</label>
          <select value={form.is_sdc} onChange={(e) => set('is_sdc', e.target.value)}>
            <option value="">Not sure</option>
            <option value="yes">Yes — enrolled in the SDC program</option>
            <option value="no">No — general candidate</option>
          </select>
        </div>
        <div className="field">
          <label>Travel time to venue</label>
          <select value={form.travel_time_minutes} onChange={(e) => set('travel_time_minutes', e.target.value)}>
            <option value="">Not sure</option>
            {TRAVEL_PRESETS.map((m) => <option key={m} value={m}>~{m} min</option>)}
          </select>
        </div>
        {error && <div className="error-note">{error}</div>}
        <div className="sticky-cta" style={{ padding: 0, border: 'none', marginTop: 8 }}>
          <button className="btn" type="submit" disabled={submitting}>
            {submitting ? 'Joining…' : 'Join the queue'}
          </button>
        </div>
      </form>
    </div>
  );
}
