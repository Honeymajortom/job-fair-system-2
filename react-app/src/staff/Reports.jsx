const REPORTS = [
  { path: '/candidate-summary', slug: 'candidate-summary', title: 'Candidate summary', desc: 'One row per candidate — companies assigned, interviews done, selections, no-shows.' },
  { path: '/master-report', slug: 'master-report', title: 'Master report', desc: 'Full export — one row per candidate × company assignment, with ratings and feedback.' },
  { path: '/company-stats', slug: 'company-stats', title: 'Company stats', desc: 'Per-company funnel: assigned, pending, at desk, completed, selected, no-shows.' },
  { path: '/rating-report', slug: 'rating-report', title: 'Rating report', desc: 'Average star rating per company × evaluation parameter.' },
  { path: '/qual-distribution', slug: 'qual-distribution', title: 'Qualification distribution', desc: 'Registered candidates grouped by highest qualification.' },
  { path: '/field-distribution', slug: 'field-distribution', title: 'Field distribution', desc: 'Registered candidates grouped by field of study.' },
];

export default function Reports() {
  return (
    <div className="s-body">
      <h2 className="screen-title">Reports</h2>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr><th>Report</th><th>Description</th><th></th></tr>
          </thead>
          <tbody>
            {REPORTS.map((r) => (
              <tr key={r.slug}>
                <td>{r.title}</td>
                <td>{r.desc}</td>
                <td>
                  <a
                    className="btn ghost"
                    style={{ width: 'auto', padding: '8px 12px', display: 'inline-block', textAlign: 'center' }}
                    href={`/api${r.path}?format=csv`}
                    download={`${r.slug}.csv`}
                  >
                    ⬇ CSV
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
