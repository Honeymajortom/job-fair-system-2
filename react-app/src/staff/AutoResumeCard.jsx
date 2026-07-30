// candidate_and_desk_improvements_plan.md §C: shown in place of "No resume"
// when a candidate has no uploaded file — a structured summary of the same
// fields already collected at registration, laid out to read as a resume
// rather than a raw field list. Sits in the exact visual slot the real
// resume iframe would occupy (IncomingCard.jsx's .resume-box), just with
// labeled rows instead of an embedded document.
export default function AutoResumeCard({ candidate }) {
  const experienceLine = candidate.employmentStatus === 'Working' || candidate.employmentStatus === 'Experienced'
    ? candidate.employmentStatus
    : candidate.employmentStatus || null;

  return (
    <div className="auto-resume">
      <div className="ar-name">{candidate.name}</div>
      <div className="cand-fields" style={{ marginTop: 8 }}>
        {[
          ['Qualification', candidate.qualification || '—'],
          ['Age', candidate.age ?? '—'],
          ['Gender', candidate.gender || '—'],
          ['SDC candidate', candidate.isSdc == null ? '—' : (candidate.isSdc ? 'Yes' : 'No')],
          ['Travel time', candidate.travelTimeMinutes != null ? `${candidate.travelTimeMinutes} min` : '—'],
          ['Employment status', experienceLine || '—'],
        ].map(([label, value]) => (
          <div key={label}>
            <div className="cf-label">{label}</div>
            <div className="cf-val">{value}</div>
          </div>
        ))}
      </div>
      {(candidate.employmentStatus === 'Working' || candidate.employmentStatus === 'Experienced') && (
        <div style={{ marginTop: 10 }}>
          <div className="cf-label">Work experience</div>
          {candidate.workExperience && candidate.workExperience.length ? (
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, textAlign: 'left' }}>
              {candidate.workExperience.map((w) => (
                <li key={w.id} className="cf-val">{w.company_name} — {w.years}y {w.months}m</li>
              ))}
            </ul>
          ) : (
            <p className="save-note" style={{ textAlign: 'left', margin: '4px 0 0' }}>None listed</p>
          )}
        </div>
      )}
    </div>
  );
}
