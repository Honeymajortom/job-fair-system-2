import { useEffect, useState } from 'react';
import { api } from '../api';
import { useSocketEvent } from './SocketContext';

const POLL_MS = 20000;
const RECENT_LIMIT = 20;

const alertMessage = (a) =>
  `${a.remaining} people still waiting, won't all get seen before closing at this pace. ` +
  `Reach out now: offer a transfer, a priority slot tomorrow, or a virtual interview.`;

export default function FloorMonitor() {
  const [stats, setStats] = useState(null);
  const [recent, setRecent] = useState(null);

  function load() {
    api.getFloorStats().then(setStats).catch(() => {});
    api.listCandidates().then((rows) => setRecent(rows.slice(0, RECENT_LIMIT))).catch(() => {});
  }

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, []);

  // Live-ish without full local delta application (v1's FloorMonitor did
  // that; this pass just re-fetches on the events that would move a number).
  useSocketEvent('candidate_registered', load);
  useSocketEvent('candidate_dispatched', load);
  useSocketEvent('interview_processed', load);
  useSocketEvent('no_show_marked', load);

  return (
    <div className="s-body">
      <h2 className="screen-title">Floor</h2>

      {stats && (
        <>
          <div className="stats-row">
            <div className="stat"><div className="n">{stats.registered}</div><div className="l">Registered</div></div>
            <div className="stat hot"><div className="n">{stats.at_desk}</div><div className="l">At desk now</div></div>
            <div className="stat"><div className="n">{stats.completed}</div><div className="l">Completed</div></div>
            <div className="stat"><div className="n">{stats.waitlisted}</div><div className="l">On the waitlist</div></div>
            <div className="stat hot"><div className="n">{stats.needs_attention}</div><div className="l">Needs attention</div></div>
          </div>

          <div className="sec-label" style={{ margin: '18px 0 10px' }}>People on hand, per company</div>
          <div className="buffer-list">
            {stats.companies.map((c) => {
              // Fill and target tick share one scale (the larger of the two,
              // plus headroom) so "fill reaches the tick" reads as "at target"
              // regardless of whether on_hand or target happens to be bigger.
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

          <div className="sec-label" style={{ margin: '18px 0 10px' }}>Now serving</div>
          <div className="now-board">
            {stats.now_serving.map((r) => (
              <div key={r.token} className="now-tok"><b>{r.token}</b><span>→ {r.company_name} · Desk {r.desk_id}</span></div>
            ))}
            {!stats.now_serving.length && <p className="save-note">Nobody at a desk right now.</p>}
          </div>

          <div className="sec-label" style={{ margin: '18px 0 10px' }}>Won't finish in time — rechecked every 30 min</div>
          <div className="alert-list">
            {stats.alerts.map((a) => (
              <div key={a.company_id} className="alert"><b>{a.company_name}</b> — {alertMessage(a)}</div>
            ))}
            {!stats.alerts.length && <p className="save-note">No companies at risk right now.</p>}
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
            {recent && recent.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.token_no}</td>
                <td>{c.name}</td>
                <td>{c.qualification || '—'}</td>
                <td className="mono">{new Date(c.registered_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                <td>{c.checked_in_at ? 'Yes' : '—'}</td>
              </tr>
            ))}
            {recent && !recent.length && (
              <tr><td colSpan={5} className="save-note">No candidates registered yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
