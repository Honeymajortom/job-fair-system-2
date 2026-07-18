import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { m } from 'framer-motion';
import { api } from '../api';
import SiteCredit from './SiteCredit.jsx';

// Lost-device recovery (QRLanding.jsx links here). Requires the same fair-QR
// JWT registration does — stashed in sessionStorage by QRLanding when the
// candidate scans the entrance code — so this only works for someone who
// actually rescanned at the venue, not a cold guess of someone else's mobile
// number from anywhere on the internet. See routes/public.js POST /qr/recover.
export default function RecoverToken() {
  const navigate = useNavigate();
  const [mobile, setMobile] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const qrToken = sessionStorage.getItem('fair_qr_token');

  async function submit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.recoverToken({ qr_token: qrToken, mobile });
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
        <div className="fair">Find my queue</div>
        <div className="sub">Already registered? Get your token page back</div>
      </div>
      <m.form
        className="m-body"
        onSubmit={submit}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
      >
        {!qrToken && (
          <p className="error-note">
            Please scan the entrance QR code first, then come back to this page.
          </p>
        )}
        <div className="field">
          <label>Mobile number you registered with</label>
          <input
            required
            inputMode="numeric"
            autoFocus
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
          />
        </div>
        {error && <div className="error-note">{error}</div>}
        <div className="sticky-cta" style={{ padding: 0, border: 'none', marginTop: 8 }}>
          <button className="btn" type="submit" disabled={submitting || !qrToken}>
            {submitting ? 'Looking…' : 'Get my token page'}
          </button>
        </div>
        <p className="save-note" style={{ marginTop: 14 }}>
          Not registered yet? <Link to="/register">Start registration</Link>
        </p>
      </m.form>
      <SiteCredit />
    </div>
  );
}
