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
// While paused (Company HR's Pause button, DeskTablet.jsx), the underlying
// BullMQ job has been removed server-side (lib/noShowTimer.js) — the ring
// just freezes on the remaining time it was told about at pause time instead
// of ticking down against a deadline that no longer means anything.
export default function CountdownRing({ expiresAt, totalMs, paused, pausedRemainingMs }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [paused]);

  if (!expiresAt && !paused) {
    return (
      <div className="ring-wrap">
        <div className="ring"><div className="face"><span className="mm-ss">--:--</span></div></div>
        <div className="ring-label">Time to arrive</div>
      </div>
    );
  }

  const remaining = paused ? pausedRemainingMs : new Date(expiresAt).getTime() - now;
  const pct = Math.max(0, Math.min(100, (remaining / totalMs) * 100));
  const warn = !paused && remaining <= WARN_THRESHOLD_MS;

  return (
    <div className="ring-wrap">
      <div className={`ring${warn ? ' warn' : ''}${paused ? ' paused' : ''}`} style={{ '--pct': pct }}>
        <div className="face"><span className="mm-ss">{format(remaining)}</span></div>
      </div>
      <div className="ring-label">{paused ? 'Paused' : 'Time to arrive'}</div>
    </div>
  );
}
