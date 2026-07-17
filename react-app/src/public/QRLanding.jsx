import { m } from 'framer-motion';
import { Link, useSearchParams } from 'react-router-dom';
import { useEffect } from 'react';

// Public entry point (v1's flow A, kept per new_architecture_uiux_spec.html
// §01 step 1 — only steps underneath it change). `/qr?token=` stashes the
// fair-QR JWT minted at the entrance so /register's POST can prove it scanned
// a real gate code, not a screenshot passed hand to hand.
export default function QRLanding() {
  const [params] = useSearchParams();

  useEffect(() => {
    const token = params.get('token');
    if (token) sessionStorage.setItem('fair_qr_token', token);
  }, [params]);

  return (
    <div className="m-shell">
      <div className="app-head">
        <div className="fair">QueueOps</div>
        <div className="sub">Smart Job Fair Crowd & Interview Management System</div>
      </div>
      <m.div
        className="m-body"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
      >
        <div style={{ marginTop: 24 }}>
          <div className="token-label">Join the queue in</div>
          <div className="token-big" style={{ fontSize: 40 }}>2 minutes</div>
        </div>
        <ol style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20 }}>
          <li className="slot-row"><span className="c"><b>① Fill your details once</b></span></li>
          <li className="slot-row"><span className="c"><b>② Pick up to 3 companies</b></span></li>
          <li className="slot-row"><span className="c"><b>③ Track your live position</b></span></li>
        </ol>
        <p className="save-note" style={{ marginTop: 16 }}>No fixed time · come when we call you</p>
      </m.div>
      <div className="sticky-cta">
        <Link className="btn" to="/register">Start registration</Link>
        <p className="save-note" style={{ marginTop: 10, textAlign: 'center' }}>
          Already registered? <Link to="/recover">Find my queue</Link>
        </p>
      </div>
    </div>
  );
}
