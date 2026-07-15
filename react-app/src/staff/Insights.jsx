import { useEffect, useState } from 'react';
import { api } from '../api';

// Cross-cutting inference over registration + interview-outcome data — not a
// live-ops control surface like Floor, a computed summary (lib/insights.js)
// scoped to one registration day at a time. 20s poll matches the server-side
// cache TTL (routes/reports.js's GET /insights).
const POLL_MS = 20000;

// Outcome segments for the per-company stacked bar — same 5 buckets and
// colors as the existing detail table's cells (status is a fixed, reserved
// palette app-wide, not a re-picked categorical one). "Other" folds in
// Dispatched/Waitlisted/No_Show so segment widths always sum to `assigned`
// exactly — bar length stays a truthful headcount, not a lie.
const OUTCOME_SEGMENTS = [
  { key: 'selected', label: 'Selected', color: 'var(--st-selected)' },
  { key: 'shortlisted', label: 'Shortlisted', color: 'var(--st-short)' },
  { key: 'hold', label: 'Hold', color: 'var(--st-hold)' },
  { key: 'rejected', label: 'Rejected', color: 'var(--st-rejected)' },
  { key: 'pending', label: 'Pending', color: 'var(--st-pending)' },
  { key: 'other', label: 'In queue / no-show', color: 'var(--ink-30)' },
];

// Chart-only categorical trio (candidate purple / live coral / a chroma-
// boosted teal — #0E8F8C's own chroma sits just under the CVD floor) for the
// two demographic donuts. Validated: node scripts/validate_palette.js
// "#5B4BC4,#E4573D,#029C97" --mode light — all six checks pass.
const GENDER_SEGMENTS = (t) => [
  { key: 'male', label: 'Male', value: t.male, color: '#5B4BC4' },
  { key: 'female', label: 'Female', value: t.female, color: '#E4573D' },
  { key: 'other', label: 'Other', value: t.other_gender, color: '#029C97' },
  { key: 'unknown', label: 'Unknown', value: t.gender_unknown, color: 'var(--ink-30)' },
].filter((s) => s.value > 0);

const SDC_SEGMENTS = (t) => [
  { key: 'sdc', label: 'SDC', value: t.sdc, color: '#029C97' },
  { key: 'non_sdc', label: 'Non-SDC', value: t.non_sdc, color: '#5B4BC4' },
  { key: 'unknown', label: 'Unknown', value: t.sdc_unknown, color: 'var(--ink-30)' },
].filter((s) => s.value > 0);

function fmtDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function HBar({ label, pct, displayValue, color }) {
  return (
    <div className="ins-hbar">
      <div className="ins-hbar-label" title={label}>{label}</div>
      <div className="ins-hbar-track">
        <div className="ins-hbar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="ins-hbar-value">{displayValue}</div>
    </div>
  );
}

function StackedBar({ label, total, segments, widthPct }) {
  return (
    <div className="ins-stack-row">
      <div className="ins-stack-label" title={label}>
        <span className="t">{label}</span>
        <span className="n">{total}</span>
      </div>
      <div className="ins-stack-track" style={{ width: `${widthPct}%` }}>
        {segments.filter((s) => s.value > 0).map((s) => (
          <div key={s.key} className="ins-stack-seg" style={{ flexGrow: s.value, background: s.color }} title={`${s.label}: ${s.value}`} />
        ))}
      </div>
    </div>
  );
}

function Donut({ segments, size = 128 }) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  let acc = 0;
  const stops = segments.map((s) => {
    const start = (acc / total) * 100;
    acc += s.value;
    const end = (acc / total) * 100;
    return `${s.color} ${start}% ${end}%`;
  }).join(', ');
  return (
    <div className="ins-donut" style={{ width: size, height: size, background: `conic-gradient(${stops})` }}>
      <div className="ins-donut-hole">
        <b>{total}</b>
        <span>total</span>
      </div>
    </div>
  );
}

function DonutBlock({ title, segments }) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  return (
    <div className="ins-donut-block">
      <Donut segments={segments} />
      <div className="ins-donut-legend">
        <div className="sec-label" style={{ marginBottom: 2 }}>{title}</div>
        {segments.map((s) => (
          <div key={s.key} className="row">
            <i style={{ background: s.color }} />
            {s.label}
            <b>{s.value} · {Math.round((s.value / total) * 100)}%</b>
          </div>
        ))}
      </div>
    </div>
  );
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
  const companies = data?.companies || [];
  const rateRows = [...companies].filter((c) => c.fill_rate !== null).sort((a, b) => b.fill_rate - a.fill_rate);
  const maxAssigned = Math.max(1, ...companies.map((c) => c.assigned));

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

          <div className="sec-label" style={{ margin: '22px 0 10px' }}>Fill rate by company</div>
          <div className="ins-chart-card">
            {rateRows.length ? rateRows.map((c) => (
              <HBar key={c.id} label={c.company_name} pct={Math.min(100, c.fill_rate)} displayValue={`${c.fill_rate}%`} color="var(--system)" />
            )) : <p className="save-note">No vacancy data yet.</p>}
          </div>

          <div className="sec-label" style={{ margin: '22px 0 10px' }}>Outcomes by company</div>
          <div className="ins-chart-card">
            <div className="ins-legend">
              {OUTCOME_SEGMENTS.map((s) => (
                <span key={s.key} className="ins-legend-item"><i style={{ background: s.color }} />{s.label}</span>
              ))}
            </div>
            {companies.length ? companies.map((c) => {
              const other = c.dispatched + c.waitlisted + c.no_show;
              const segments = OUTCOME_SEGMENTS.map((s) => ({ ...s, value: s.key === 'other' ? other : c[s.key] }));
              return (
                <StackedBar
                  key={c.id}
                  label={c.company_name}
                  total={c.assigned}
                  segments={segments}
                  widthPct={c.assigned > 0 ? Math.max(3, (c.assigned / maxAssigned) * 100) : 0}
                />
              );
            }) : <p className="save-note">No companies yet.</p>}
          </div>

          <div className="sec-label" style={{ margin: '22px 0 10px' }}>Candidate demographics</div>
          <div className="ins-chart-card ins-donut-row">
            <DonutBlock title="Gender" segments={GENDER_SEGMENTS(t)} />
            <DonutBlock title="SDC status" segments={SDC_SEGMENTS(t)} />
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
