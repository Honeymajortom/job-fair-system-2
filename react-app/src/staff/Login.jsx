import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  // Set by api.js's onUnauthorized callback (AuthContext.jsx) when a staff
  // action 401s mid-session — a one-shot flag so this reads once, then
  // clears, rather than reappearing on every future visit to this screen.
  const [expired] = useState(() => {
    const flag = sessionStorage.getItem('session_expired');
    if (flag) sessionStorage.removeItem('session_expired');
    return !!flag;
  });

  async function submit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(username, password);
      navigate('/staff/desk');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="s-shell">
      <div className="s-body" style={{ maxWidth: 360 }}>
        <h2 className="screen-title">Staff login</h2>
        {expired && <div className="error-note" style={{ marginBottom: 8 }}>Your session expired — please sign in again.</div>}
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="field">
            <label>Username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} required />
          </div>
          <div className="field">
            <label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <div className="error-note">{error}</div>}
          <button className="btn" type="submit" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
