import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';

const TRAVEL_PRESETS = [10, 25, 45, 60];
const RESUME_MAX_BYTES = 5 * 1024 * 1024; // matches the server's multer limit — catch it client-side first

function formatBytes(n) {
  return n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// new_architecture_uiux_spec.html §01 step 3. travel_time_minutes is the one
// field this form has that v1's DetailsForm didn't — it's what lets the ping
// ladder (Phase 4) ever reach the "come now" rung instead of only position-
// based staging/gate.
export default function DetailsForm() {
  const location = useLocation();
  const navigate = useNavigate();
  const companyIds = location.state?.company_ids || [];

  const [form, setForm] = useState({ name: '', mobile: '', age: '', qualification: '', travel_time_minutes: '', gender: '', is_sdc: '' });
  const [resumeFile, setResumeFile] = useState(null);
  const [resumeError, setResumeError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef(null);

  function set(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  // Client-side mirror of the server's own checks (PDF-only, 5MB cap) — same
  // reasoning as elsewhere in this app: catch it before a wasted round trip,
  // not instead of the server check (the server never trusts this).
  function handleResumeFile(file) {
    if (!file) return;
    if (file.type !== 'application/pdf' || !file.name.toLowerCase().endsWith('.pdf')) {
      setResumeError('Only PDF files are accepted.');
      return;
    }
    if (file.size > RESUME_MAX_BYTES) {
      setResumeError(`That file is ${formatBytes(file.size)} — the limit is 5 MB.`);
      return;
    }
    setResumeError(null);
    setResumeFile(file);
  }

  function clearResume() {
    setResumeFile(null);
    setResumeError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
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
      // Resume is optional and orthogonal to registration — a failed upload
      // should never block a candidate who's already registered, so this is
      // fire-and-forget: no re-throw, just move on to the schedule page.
      if (resumeFile && result.qr) {
        try {
          await api.uploadResume(result.qr, resumeFile);
        } catch { /* candidate is already registered; they can't retry from here anyway */ }
      }
      // replace, not push: once registered, back must not return to this form
      // (LivePosition.jsx also traps back navigation once the candidate lands there)
      navigate(`/schedule/${result.token}`, { replace: true });
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
        <div className="field resume-field">
          <label>Resume — optional, skip if you don't have one handy</label>
          {!resumeFile ? (
            <div
              className={`resume-drop${dragOver ? ' over' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                handleResumeFile(e.dataTransfer.files[0]);
              }}
            >
              <span className="ic">📄</span>
              <span className="txt">Tap to choose a PDF, or drag one here</span>
              <span className="hint">Optional — you can skip this and still register</span>
            </div>
          ) : (
            <div className="resume-chip">
              <span className="ic">📄</span>
              <div className="meta">
                <span className="name">{resumeFile.name}</span>
                <span className="size">{formatBytes(resumeFile.size)}</span>
              </div>
              <button type="button" className="rm" onClick={clearResume} aria-label="Remove resume">✕</button>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            style={{ display: 'none' }}
            onChange={(e) => handleResumeFile(e.target.files[0])}
          />
        </div>
        {resumeError && <div className="error-note">{resumeError}</div>}
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
