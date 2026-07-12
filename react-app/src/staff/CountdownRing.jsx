import { useEffect, useState } from 'react';

const WARN_THRESHOLD_MS = 20 * 1000; // spec table says "under 20s"; the doc's own demo used 30s — table wins (see new_architecture_uiux_spec.html §05 discrepancy note)

function format(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

// Pure client-side ticker against a server-provided deadline (expiresAt) —
// the actual no-show reversion is server-authoritative (workers/noShowWorker.js);
// this ring never fires anything itself, it just visualizes the same deadline.
export default function CountdownRing({ expiresAt, totalMs }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!expiresAt) {
    return (
      <div className="ring-wrap">
        <div className="ring"><div className="face"><span className="mm-ss">--:--</span></div></div>
        <div className="ring-label">Time to arrive</div>
      </div>
    );
  }

  const remaining = new Date(expiresAt).getTime() - now;
  const pct = Math.max(0, Math.min(100, (remaining / totalMs) * 100));
  const warn = remaining <= WARN_THRESHOLD_MS;

  return (
    <div className="ring-wrap">
      <div className={`ring${warn ? ' warn' : ''}`} style={{ '--pct': pct }}>
        <div className="face"><span className="mm-ss">{format(remaining)}</span></div>
      </div>
      <div className="ring-label">Time to arrive</div>
    </div>
  );
}
