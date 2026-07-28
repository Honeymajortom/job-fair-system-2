import { useEffect, useState } from 'react';
import { api } from '../api';
import { useSocketEvent } from './SocketContext';
import { useCenter } from './CenterContext';
import OfflineBanner from '../common/OfflineBanner';
import Spinner from '../common/Spinner';
import EmptyState from '../common/EmptyState';
import './Floor.css';

const POLL_MS = 20000;
const MAX_SLOTS = 6;

function fmtDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function initialsFor(name) {
  const caps = name.split(' ').filter((w) => /^[A-Z]/.test(w)).slice(0, 2).map((w) => w[0]).join('');
  return caps || name.slice(0, 2).toUpperCase();
}

// Pace signal, distinct from `low` (buffer sufficiency — do they have enough
// people checked in and waiting). This is about whether a company is
// actually getting through the people it has: real completed/remaining
// counts from lib/floorStats.js, not a display-only guess.
function anomalyFor(c) {
  const total = c.completed + c.remaining;
  if (total === 0 || c.remaining === 0) return null;
  if (c.completed === 0) return 'No progress yet';
  if (c.completed / total < 0.05) return 'Falling behind';
  return null;
}

// settings_tab_plan.md (2026-07-28): this used to also carry the Start/End
// job fair control + Past-fairs archive list — both moved to Settings → Fair,
// which has permanent room for them and doesn't need the "hide it from
// floor_manager" guard this screen had to apply inline (Settings is already
// admin-gated at the route level). Floor is now purely the live dashboard.
export default function FloorMonitor() {
  const { effectiveCenterId } = useCenter();
  // Each fair day is its own fresh session now — '' means "nothing picked
  // yet", not "all time" (that all-time aggregate used to be the default
  // view, which read as stale/misleading once multiple fair days piled up).
  const [date, setDate] = useState('');
  const [stats, setStats] = useState(null);
  const [availableDates, setAvailableDates] = useState([]);

  function load(d) {
    if (!d) { setStats(null); return; }
    api.getFloorStats(d, effectiveCenterId).then(setStats).catch(() => {});
  }

  // GET /floor-stats returns available_dates alongside the all-time numbers
  // regardless of ?date= — fetched once, unscoped, purely to populate the Day
  // dropdown's option list; the all-time numbers themselves are discarded,
  // never assigned to `stats`, so nothing renders from this call.
  // active_fair_date (the currently-active fair for this Center, folded into
  // available_dates even before anyone's registered) is auto-selected so
  // Floor shows live data on load instead of sitting on the blank "No day
  // selected" state — a floor_manager has no other way to know the date to
  // pick, since GET /fair-settings is admin/registration_staff only.
  useEffect(() => {
    setDate('');
    api.getFloorStats(undefined, effectiveCenterId).then((s) => {
      setAvailableDates(s.available_dates || []);
      if (s.active_fair_date) setDate(s.active_fair_date);
    }).catch(() => {});
  }, [effectiveCenterId]);

  useEffect(() => {
    // load(date) itself clears stats back to null when date is '' — that
    // branch was previously skipped entirely, so re-selecting "Select a
    // day…" after viewing a real day left the last day's stats (and tile
    // grid) rendered underneath the "No day selected" empty state.
    load(date);
    if (!date) return undefined;
    const t = setInterval(() => load(date), POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, effectiveCenterId]);

  // Live-ish without full local delta application (v1's FloorMonitor did
  // that; this pass just re-fetches on the events that would move a number).
  // A no-op while date is blank — load() itself guards that.
  useSocketEvent('candidate_registered', () => load(date));
  useSocketEvent('candidate_dispatched', () => load(date));
  useSocketEvent('interview_processed', () => load(date));
  useSocketEvent('no_show_marked', () => load(date));

  // now_serving/alerts are always live (no historical record to scope by
  // day, see lib/floorStats.js) — everything else respects the dropdown.
  const servingCompanyIds = stats ? new Set(stats.now_serving.map((r) => r.company_id)) : new Set();
  const sortedCompanies = stats ? [...stats.companies].sort((a, b) => (a.low === b.low ? 0 : a.low ? -1 : 1)) : [];
  const sortedAlerts = stats ? [...stats.alerts].sort((a, b) => b.remaining - a.remaining) : [];

  return (
    <div className="s-body industry-v2 floor-v2">
      <OfflineBanner />

      <div className="fv-header">
        <div className="fv-header-left">
          <h2 className="screen-title">Floor</h2>
          <div className="fv-controls">
            <div className="field" style={{ maxWidth: 260, marginBottom: 0 }}>
              <label>Day</label>
              <select value={date} onChange={(e) => setDate(e.target.value)}>
                <option value="">Select a day…</option>
                {availableDates.map((d) => <option key={d} value={d}>{fmtDate(d)}</option>)}
              </select>
            </div>
          </div>

          {stats && (
            <div className="pill-row">
              <div className="stat pill"><span className="n">{stats.registered}</span><span className="l">Total registered</span></div>
              <div className="stat pill hot"><span className="n">{stats.at_desk}</span><span className="l">At desk now</span></div>
              <div className="stat pill"><span className="n">{stats.waitlisted}</span><span className="l">Currently waitlisted</span></div>
              <div className="stat pill hot"><span className="n">{stats.needs_attention}</span><span className="l">Needs attention</span></div>
              <div className="stat pill"><span className="n" style={{ color: 'var(--st-selected)' }}>{stats.selected}</span><span className="l">Selected</span></div>
              <div className="stat pill"><span className="n" style={{ color: 'var(--st-short)' }}>{stats.shortlisted}</span><span className="l">Shortlisted</span></div>
              <div className="stat pill"><span className="n" style={{ color: 'var(--st-hold)' }}>{stats.hold}</span><span className="l">Hold</span></div>
              <div className="stat pill"><span className="n" style={{ color: 'var(--st-rejected)' }}>{stats.rejected}</span><span className="l">Rejected</span></div>
              <div className="stat pill"><span className="n">{stats.completed}</span><span className="l">Completed (all outcomes)</span></div>
            </div>
          )}
        </div>

        {stats && (
          <div className="bp-card attn-card">
            <div className="card-kicker">Won't finish in time — rechecked every 30 min</div>
            <div className="attn-list">
              {sortedAlerts.length ? sortedAlerts.map((a) => (
                <div key={a.company_id} className="attn-item"><b>{a.company_name}</b><span>{a.remaining} waiting</span></div>
              )) : <p className="save-note" style={{ textAlign: 'left' }}>No companies at risk right now.</p>}
            </div>
          </div>
        )}
      </div>

      {!date && <EmptyState icon="📅" title="No day selected" hint="Pick a day above to see Floor data." />}
      {date && !stats && <Spinner label="Loading Floor data…" />}

      {stats && (
        <>
          <h3 className="section-title">People on hand, per company</h3>
          <div className="co-tiles">
            {sortedCompanies.map((c) => {
              const anomaly = anomalyFor(c);
              const live = servingCompanyIds.has(c.id);
              const overflow = c.on_hand - MAX_SLOTS;
              return (
                <div key={c.id} className={`bp-card co-tile${c.low ? ' low' : ''}`}>
                  <div className="co-head">
                    <div className="co-avatar">{initialsFor(c.name)}</div>
                    <div className="co-name">{c.name}</div>
                  </div>
                  {anomaly && <div className="anomaly"><span className="dt"></span>{anomaly}</div>}
                  <div className="co-row">
                    <div className="slot-group">
                      {c.on_hand_tokens.map((token) => <span key={token} className="slot">{token}</span>)}
                      {overflow > 0 && <span className="overflow-label">+{overflow}</span>}
                      {!c.on_hand && <span className="overflow-label">No one waiting</span>}
                    </div>
                    <div className="connector"></div>
                    <div className={`desk-dot-ring${live ? ' live' : ''}`}><span className="desk-dot"></span></div>
                    <div className="connector short"></div>
                    <div className="done-count">{c.completed}</div>
                  </div>
                  <div className="co-labels"><span>Queue</span><span>Desk</span><span>Done</span></div>
                </div>
              );
            })}
            {!sortedCompanies.length && <p className="save-note">No companies yet.</p>}
          </div>
        </>
      )}
    </div>
  );
}
