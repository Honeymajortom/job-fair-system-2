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
  return (
    <div className="s-body">
      <h2 className="screen-title">Reports</h2>
      <p className="sec-label" style={{ marginBottom: 16 }}>Six exports · CSV · live off the current fair's data</p>
      <div className="report-grid">
        {REPORTS.map((r) => (
          <div key={r.slug} className="report-card">
            <div>
              <h3>{r.title}</h3>
              <p>{r.desc}</p>
            </div>
            <a className="dl-btn" href={`/api${r.path}?format=csv`} download={`${r.slug}.csv`}>
              <DownloadIcon />
              Download CSV
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
