import { useEffect, useState } from 'react';
import { api } from '../api';
import SiteCredit from './SiteCredit.jsx';

// Entrance Gate + Staging board (new_architecture_uiux_spec.html §03) — meant
// for a monitor mounted at the venue entrance, not a candidate's own phone,
// so this deliberately doesn't reuse the candidate flow's .m-shell phone
// frame. No auth (public route, matches the spec's read-only markup — no
// scan/action controls here, that's GateCheckIn.jsx). Poll interval matches
// the server's 10s cache TTL (GET /api/gate-status).
const POLL_MS = 10000;

export default function GateBoard() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    function load() { api.getGateStatus().then(setStatus).catch(() => {}); }
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '32px 24px', minHeight: '100dvh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 28 }}>
        <div style={{ fontFamily: 'var(--disp)', fontWeight: 800, fontStretch: '85%', fontSize: 30 }}>SDC Job Fair — Entrance</div>
        <span className="live-tag"><span className="pulse-dot live" />LIVE</span>
      </div>

      {status && (
        <div className="gate-strip">
          <div className="gate-card">
            <div className="n">{status.waiting_room_total}<span style={{ fontSize: 16, color: 'var(--ink-60)' }}> / {status.waiting_room_max}</span></div>
            <div className="l" style={{ marginBottom: 6 }}>Waiting rooms, by floor</div>
            {status.waiting_rooms.map((r) => (
              <div key={r.floor_number ?? 'unassigned'} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
                <span>{r.floor_number != null ? `Floor ${r.floor_number}` : 'Floor TBD'}{r.location ? ` · ${r.location}` : ''}</span>
                <span className="mono">{r.count}</span>
              </div>
            ))}
            {!status.waiting_rooms.length && <p className="save-note" style={{ marginTop: 0 }}>No one waiting right now.</p>}
          </div>
          <div className="gate-card">
            <div className="l" style={{ marginBottom: 6 }}>Staging queue (max {status.staging_max})</div>
            <div className="stage-slots">
              {Array.from({ length: status.staging_max }).map((_, i) => (
                <div key={i} className={`stage-slot${status.staging[i] ? ' on' : ''}`}>{status.staging[i] || '—'}</div>
              ))}
            </div>
            {status.staging_overflow > 0 && (
              <div className="save-note" style={{ marginTop: 8 }}>+{status.staging_overflow} more approaching</div>
            )}
          </div>
          <div className="gate-card">
            <div className="n" style={{ color: 'var(--st-selected)' }}>{status.called_to_desk}</div>
            <div className="l">Called to desk right now</div>
          </div>
        </div>
      )}

      <p className="save-note" style={{ marginTop: 20, textAlign: 'center' }}>
        Each floor has its own waiting room — your phone tells you which one, matched to whichever company calls you next.
      </p>
      <div style={{ marginTop: 24 }}><SiteCredit /></div>
    </div>
  );
}
