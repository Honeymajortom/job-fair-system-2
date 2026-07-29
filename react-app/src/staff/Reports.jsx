import { useEffect, useState } from 'react';
import { api } from '../api';
import { useCenter } from './CenterContext';

function fmtDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// Local date parts, not toISOString() — the same UTC-round-trip shift
// lib/floorStats.js/lib/insights.js's own comments warn about (this session
// runs IST, +5:30; toISOString() would silently report yesterday for part of
// the day). Staff are physically at the venue, same timezone as the server.
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const REPORTS = [
  { path: '/candidate-summary', slug: 'candidate-summary', title: 'Candidate summary', desc: 'One row per candidate — companies assigned, interviews done, selections, no-shows.' },
  { path: '/master-report', slug: 'master-report', title: 'Master report', desc: 'Full export — one row per candidate × company assignment, with ratings and feedback.' },
  { path: '/company-stats', slug: 'company-stats', title: 'Company stats', desc: 'Per-company funnel: assigned, pending, at desk, completed, selected, no-shows.' },
  { path: '/rating-report', slug: 'rating-report', title: 'Rating report', desc: 'Average star rating per company × evaluation parameter.' },
  { path: '/qual-distribution', slug: 'qual-distribution', title: 'Qualification distribution', desc: 'Registered candidates grouped by highest qualification.' },
  { path: '/field-distribution', slug: 'field-distribution', title: 'Field distribution', desc: 'Registered candidates grouped by field of study.' },
];

function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 1.5V10M8 10L4.5 6.5M8 10L11.5 6.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 12.5V13.5C2 13.7761 2.22386 14 2.5 14H13.5C13.7761 14 14 13.7761 14 13.5V12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Reports() {
  // fair_cycle_isolation_plan.md Phase 4: these are plain <a href> downloads
  // (not api.js fetch calls), so the Nav switcher's Center scoping has to be
  // appended to the query string directly here rather than through a
  // wrapper function.
  const { effectiveCenterId } = useCenter();
  // '' (the default) means "every day" — unlike Insights' Day picker, which
  // defaults to showing nothing until a day is chosen, a report is an
  // explicit, deliberate download: staff often want the full export, not
  // just today's slice, so unscoped stays the default here rather than
  // forcing a pick first.
  const [date, setDate] = useState('');
  const [availableDates, setAvailableDates] = useState([]);

  // Piggybacks GET /insights purely for its available_dates list — same
  // trick Insights.jsx itself uses — rather than adding a second endpoint
  // whose only job is to enumerate registration days.
  useEffect(() => {
    api.getInsights(undefined, effectiveCenterId).then((d) => setAvailableDates(d.available_dates || [])).catch(() => {});
  }, [effectiveCenterId]);

  return (
    <>
      <p className="sec-label" style={{ marginBottom: 16 }}>Six exports · CSV · scoped to the current Center, optionally to one day</p>
      <div className="field" style={{ maxWidth: 260, marginBottom: 16 }}>
        <label>Day</label>
        <select value={date} onChange={(e) => setDate(e.target.value)}>
          <option value="">All time</option>
          {availableDates.map((d) => <option key={d} value={d}>{fmtDate(d)}</option>)}
        </select>
      </div>
      <div className="report-grid">
        {(() => {
          // Falls back to real today when no Day is picked above (the
          // original "one click, today only" behavior); once a Day is
          // selected, this card downloads that day's master data instead,
          // so the Center/Date pickers actually control what "Today's
          // Master Data" means rather than being silently ignored.
          const masterDate = date || todayStr();
          return (
            <div className="report-card" style={{ borderColor: 'var(--system)' }}>
              <div>
                <h3>Today's Master Data</h3>
                <p>
                  Master report for {date ? fmtDate(masterDate) : 'today'} — one click
                  {date ? '' : ', regardless of whatever the Day filter above is set to'}.
                </p>
              </div>
              <a
                className="dl-btn"
                href={`/api/master-report?format=csv${effectiveCenterId ? `&center_id=${effectiveCenterId}` : ''}&date=${masterDate}`}
                download={`${masterDate} Master Data.csv`}
              >
                <DownloadIcon />
                Download CSV
              </a>
            </div>
          );
        })()}
        {REPORTS.map((r) => (
          <div key={r.slug} className="report-card">
            <div>
              <h3>{r.title}</h3>
              <p>{r.desc}</p>
            </div>
            <a
              className="dl-btn"
              href={`/api${r.path}?format=csv${effectiveCenterId ? `&center_id=${effectiveCenterId}` : ''}${date ? `&date=${date}` : ''}`}
              download={`${r.slug}${date ? `-${date}` : ''}.csv`}
            >
              <DownloadIcon />
              Download CSV
            </a>
          </div>
        ))}
      </div>
    </>
  );
}
