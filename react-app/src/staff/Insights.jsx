import { useEffect, useState } from 'react';
import { api } from '../api';

// Cross-cutting inference over registration + interview-outcome data — not a
// live-ops control surface like Floor, a computed summary (lib/insights.js)
// scoped to one registration day at a time. 20s poll matches the server-side
// cache TTL (routes/reports.js's GET /insights).
const POLL_MS = 20000;

function fmtDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function Insights() {
  const [date, setDate] = useState(''); // '' = all time
  const [data, setData] = useState(null);

  function load(d) {
    api.getInsights(d || undefined).then(setData).catch(() => {});
  }

  useEffect(() => {
    load(date);
    const t = setInterval(() => load(date), POLL_MS);
    return () => clearInterval(t);
  }, [date]);

  const t = data?.totals;

  return (
    <div className="s-body">
      <h2 className="screen-title">Insights</h2>

      <div className="field" style={{ maxWidth: 260, marginBottom: 16 }}>
        <label>Day</label>
        <select value={date} onChange={(e) => setDate(e.target.value)}>
          <option value="">All time</option>
          {data && data.available_dates.map((d) => <option key={d} value={d}>{fmtDate(d)}</option>)}
        </select>
      </div>

      {t && (
        <>
          <div className="stats-row">
            <div className="stat"><div className="n">{t.vacancies}</div><div className="l">Vacancies</div></div>
            <div className="stat"><div className="n">{t.assigned}</div><div className="l">Assigned</div></div>
            <div className="stat"><div className="n">{t.done}</div><div className="l">Done</div></div>
            <div className="stat"><div className="n" style={{ color: 'var(--st-selected)' }}>{t.selected}</div><div className="l">Selected</div></div>
            <div className="stat hot"><div className="n">{t.fill_rate === null ? '—' : `${t.fill_rate}%`}</div><div className="l">Fill rate</div></div>
          </div>

          <div className="stats-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 10 }}>
            <div className="stat"><div className="n">{t.male}</div><div className="l">Male</div></div>
            <div className="stat"><div className="n">{t.female}</div><div className="l">Female</div></div>
            <div className="stat"><div className="n">{t.sdc}</div><div className="l">SDC candidates</div></div>
            <div className="stat"><div className="n">{t.non_sdc}</div><div className="l">Non-SDC candidates</div></div>
          </div>
        </>
      )}

      <div className="sec-label" style={{ margin: '18px 0 10px' }}>Per company — vacancies &amp; outcomes</div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Company</th><th>Vacancies</th><th>Assigned</th><th>Done</th>
              <th>Selected</th><th>Shortlist</th><th>Hold</th><th>Rejected</th><th>Pending</th><th>Fill rate</th>
            </tr>
          </thead>
          <tbody>
            {data && data.companies.map((c) => (
              <tr key={c.id}>
                <td>{c.company_name}</td>
                <td className="mono">{c.vacancies}</td>
                <td className="mono">{c.assigned}</td>
                <td className="mono">{c.done}</td>
                <td className="mono" style={{ color: 'var(--st-selected)' }}>{c.selected}</td>
                <td className="mono" style={{ color: 'var(--st-short)' }}>{c.shortlisted}</td>
                <td className="mono" style={{ color: 'var(--st-hold)' }}>{c.hold}</td>
                <td className="mono" style={{ color: 'var(--st-rejected)' }}>{c.rejected}</td>
                <td className="mono" style={{ color: 'var(--st-pending)' }}>{c.pending}</td>
                <td className="mono">{c.fill_rate === null ? '—' : `${c.fill_rate}%`}</td>
              </tr>
            ))}
            {data && !data.companies.length && (
              <tr><td colSpan={10} className="save-note">No companies yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="sec-label" style={{ margin: '18px 0 10px' }}>Per company — demographics</div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Company</th><th>Male</th><th>Female</th><th>Other</th><th>Gender unknown</th>
              <th>SDC</th><th>Non-SDC</th><th>SDC unknown</th>
            </tr>
          </thead>
          <tbody>
            {data && data.companies.map((c) => (
              <tr key={c.id}>
                <td>{c.company_name}</td>
                <td className="mono">{c.male}</td>
                <td className="mono">{c.female}</td>
                <td className="mono">{c.other_gender}</td>
                <td className="mono">{c.gender_unknown}</td>
                <td className="mono">{c.sdc}</td>
                <td className="mono">{c.non_sdc}</td>
                <td className="mono">{c.sdc_unknown}</td>
              </tr>
            ))}
            {data && !data.companies.length && (
              <tr><td colSpan={8} className="save-note">No companies yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
