// candidate_and_desk_improvements_plan.md §B: the repeatable "add a company +
// years/months" facility, shared by DetailsForm.jsx (candidate self-
// registration) and CandidateAdmin.jsx (staff manual registration) so both
// forms build the same `work_experience: [{ company_name, years, months }]`
// shape to send to registerCandidate(). Purely local array state — nothing
// here talks to the API; the parent form submits the array as a whole.
export default function WorkExperienceFields({ entries, onChange }) {
  function updateEntry(index, key, value) {
    onChange(entries.map((e, i) => (i === index ? { ...e, [key]: value } : e)));
  }

  function addEntry() {
    onChange([...entries, { company_name: '', years: '', months: '' }]);
  }

  function removeEntry(index) {
    onChange(entries.filter((_, i) => i !== index));
  }

  return (
    <div className="field">
      <label>Work experience</label>
      {entries.map((entry, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
          <input
            placeholder="Company name"
            value={entry.company_name}
            onChange={(e) => updateEntry(i, 'company_name', e.target.value)}
            style={{ flex: 2 }}
          />
          <input
            type="number"
            min={0}
            placeholder="Years"
            value={entry.years}
            onChange={(e) => updateEntry(i, 'years', e.target.value)}
            style={{ flex: 1, minWidth: 70 }}
          />
          <input
            type="number"
            min={0}
            max={11}
            placeholder="Months"
            value={entry.months}
            onChange={(e) => updateEntry(i, 'months', e.target.value)}
            style={{ flex: 1, minWidth: 70 }}
          />
          <button type="button" className="rm" onClick={() => removeEntry(i)} aria-label="Remove entry">✕</button>
        </div>
      ))}
      <button type="button" className="btn ghost" style={{ width: 'auto', padding: '8px 14px' }} onClick={addEntry}>
        + Add another company
      </button>
    </div>
  );
}
