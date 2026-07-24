import { useEffect, useState } from 'react';
import { api } from '../api';
import { useSocketEvent } from './SocketContext';

const POLL_MS = 20000;
const RECENT_LIMIT = 20;

const alertMessage = (a) =>
  `${a.remaining} people still waiting, won't all get seen before closing at this pace. ` +
  `Reach out now: offer a transfer, a priority slot tomorrow, or a virtual interview.`;

function fmtDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function FloorMonitor() {
  const [date, setDate] = useState(''); // '' = all time, same convention as Insights
  const [stats, setStats] = useState(null);
  const [recent, setRecent] = useState(null);

  function load(d) {
    api.getFloorStats(d).then(setStats).catch(() => {});
    api.listCandidates(d).then(setRecent).catch(() => {});
  }

  useEffect(() => {
    load(date);
    const t = setInterval(() => load(date), POLL_MS);
    return () => clearInterval(t);
  }, [date]);

  // Live-ish without full local delta application (v1's FloorMonitor did
  // that; this pass just re-fetches on the events that would move a number).
  useSocketEvent('candidate_registered', () => load(date));
  useSocketEvent('candidate_dispatched', () => load(date));
  useSocketEvent('interview_processed', () => load(date));
  useSocketEvent('no_show_marked', () => load(date));

  // now_serving/alerts are always live (no historical record to scope by
  // day, see lib/floorStats.js) — everything else, including this list,
  // respects the dropdown via GET /candidates' optional ?date=.
  const recentScoped = recent ? recent.slice(0, RECENT_LIMIT) : null;

  return (
    <div className="s-body">
      <h2 className="screen-title">Floor</h2>

      <div className="field" style={{ maxWidth: 260, marginBottom: 16 }}>
        <label>Day</label>
        <select value={date} onChange={(e) => setDate(e.target.value)}>
          <option value="">All time</option>
          {stats && stats.available_dates.map((d) => <option key={d} value={d}>{fmtDate(d)}</option>)}
        </select>
      </div>

      {stats && (
        <>
          <div className="stats-row">
            <div className="stat"><div className="n">{stats.registered}</div><div className="l">Registered</div></div>
            <div className="stat hot"><div className="n">{stats.at_desk}</div><div className="l">At desk now</div></div>
            <div className="stat"><div className="n">{stats.completed}</div><div className="l">Completed</div></div>
            <div className="stat"><div className="n">{stats.waitlisted}</div><div className="l">On the waitlist</div></div>
            <div className="stat hot"><div className="n">{stats.needs_attention}</div><div className="l">Needs attention</div></div>
          </div>

          {/* Three independently-scrolling panels side by side instead of
              three full-width lists stacked and growing forever — with many
              companies, the old layout meant scrolling past "people on hand"
              and "now serving" just to reach the at-risk alerts. Sorting each
              list so the thing that needs attention is at the top means the
              urgent case is visible without any scrolling at all. */}
          <div className="floor-grid">
            <div className="floor-panel">
              <div className="sec-label">People on hand, per company</div>
              <div className="buffer-list">
                {[...stats.companies].sort((a, b) => (a.low === b.low ? 0 : a.low ? -1 : 1)).map((c) => {
                  // Fill and target tick share one scale (the larger of the
                  // two, plus headroom) so "fill reaches the tick" reads as
                  // "at target" regardless of which happens to be bigger.
                  const scaleMax = Math.max(c.on_hand, c.target, 1) * 1.15;
                  const fillPct = Math.round((c.on_hand / scaleMax) * 100);
                  const targetPct = Math.round((c.target / scaleMax) * 100);
                  return (
                    <div key={c.id} className={`buf-row${c.low ? ' low' : ''}`}>
                      <div className="co">{c.name}<small>{c.interviewers} interviewer{c.interviewers === 1 ? '' : 's'}</small></div>
                      <div className="buf-track">
                        <span className="buf-fill" style={{ width: `${fillPct}%` }} />
                        <span className="buf-target" style={{ left: `${targetPct}%` }} />
                      </div>
                      <div className="val">{c.on_hand}/{c.target}</div>
                    </div>
                  );
                })}
                {!stats.companies.length && <p className="save-note">No companies yet.</p>}
              </div>
            </div>

            <div className="floor-panel">
              <div className="sec-label">Now serving</div>
              <div className="now-board">
                {stats.now_serving.map((r) => (
                  <div key={r.token} className="now-tok"><b>{r.token}</b><span>→ {r.company_name} · Desk {r.desk_id}</span></div>
                ))}
                {!stats.now_serving.length && <p className="save-note">Nobody at a desk right now.</p>}
              </div>
            </div>

            <div className="floor-panel">
              <div className="sec-label">Won't finish in time — rechecked every 30 min</div>
              <div className="alert-list">
                {[...stats.alerts].sort((a, b) => b.remaining - a.remaining).map((a) => (
                  <div key={a.company_id} className="alert"><b>{a.company_name}</b> — {alertMessage(a)}</div>
                ))}
                {!stats.alerts.length && <p className="save-note">No companies at risk right now.</p>}
              </div>
            </div>
          </div>
        </>
      )}

      <div className="sec-label" style={{ margin: '18px 0 10px' }}>Recent registrations</div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr><th>Token</th><th>Name</th><th>Qualification</th><th>Registered at</th><th>Checked in</th></tr>
          </thead>
          <tbody>
            {recentScoped && recentScoped.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.token_no}</td>
                <td>{c.name}</td>
                <td>{c.qualification || '—'}</td>
                <td className="mono">{new Date(c.registered_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                <td>{c.checked_in_at ? 'Yes' : '—'}</td>
              </tr>
            ))}
            {recentScoped && !recentScoped.length && (
              <tr><td colSpan={5} className="save-note">No candidates registered yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
