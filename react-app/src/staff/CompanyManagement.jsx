import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useCenter } from './CenterContext';

const emptyCompanyForm = {
  company_name: '', description: '', location: '', field: '', job_type: '',
  min_qualification: '', max_qualification: '', center_id: '',
};

const emptyEditForm = {
  company_name: '', description: '', location: '', field: '', job_type: '',
  min_qualification: '', max_qualification: '',
};

const emptyParamForm = { parameter_name: '', display_order: '' };

const emptyPostForm = {
  post_title: '', vacancies: '', qualification: '', gender: '', age_min: '', age_max: '',
};

const emptyRosterAddForm = { seats: '', interview_minutes: '', floor_number: '' };

function fmtDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

const BULK_TEMPLATE_HEADER = ['company_name', 'description', 'location', 'field', 'job_type', 'min_qualification', 'max_qualification', 'seats', 'interview_minutes', 'floor_number'];
const BULK_NUMERIC_FIELDS = new Set(['seats', 'interview_minutes', 'floor_number']);

// Minimal RFC4180-ish CSV parser — quoted fields (with embedded commas/
// newlines/escaped "" quotes) supported, no external dependency, matching
// this codebase's hand-rolled convention elsewhere (no chart library in
// Insights, no CSV library on the export side in reports.js either).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

// Header row decides the field names (order-independent, unlike the fixed
// column order BULK_TEMPLATE_HEADER downloads with) — so a spreadsheet
// export with reordered or a subset of columns still parses correctly, as
// long as the header names match.
function csvToCompanyRows(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1)
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => {
      const obj = {};
      header.forEach((key, i) => {
        const raw = (r[i] ?? '').trim();
        if (raw === '') return;
        obj[key] = BULK_NUMERIC_FIELDS.has(key) ? Number(raw) : raw;
      });
      return obj;
    });
}

// company_roster_plan.md, Phase 3 (the deferred UI split): companies are now
// a permanent per-Center directory (this tab's "Directory" half — identity
// fields only: name, description, location, field, job type, qualifications)
// plus a per-fair-cycle roster (seats/interview_minutes/floor_number/is_open
// — the fields describing *this cycle's* staffing, not the company's
// permanent identity). A company can sit in the directory without being on
// any roster at all — that's the real, distinct "not part of the current
// cycle" state the backend rewire introduced.
export default function CompanyManagement() {
  const { centers, effectiveCenterId } = useCenter();
  const [directory, setDirectory] = useState(null);
  const [companyForm, setCompanyForm] = useState(emptyCompanyForm);
  const [creating, setCreating] = useState(false);

  const [expandedId, setExpandedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [editForm, setEditForm] = useState(emptyEditForm);
  const [savingEdit, setSavingEdit] = useState(false);

  const [paramForm, setParamForm] = useState(emptyParamForm);
  const [postForm, setPostForm] = useState(emptyPostForm);
  const [editingPostId, setEditingPostId] = useState(null);
  const [editPost, setEditPost] = useState(emptyPostForm);

  // Roster section — defaults to the Center's currently active fair (no
  // click needed for normal day-to-day use); the Day dropdown only exists to
  // look back at an ended cycle's roster, read-only.
  const [fairs, setFairs] = useState([]);
  const [selectedFairId, setSelectedFairId] = useState('');
  const [roster, setRoster] = useState(null);
  const [rosterBusy, setRosterBusy] = useState(false);
  const [addCompanyId, setAddCompanyId] = useState('');
  const [rosterAddForm, setRosterAddForm] = useState(emptyRosterAddForm);

  // Bulk import (CSV) — Directory-only, mirrors the single "Add to
  // directory" form's fields plus a batch-wide Center (companies are tied to
  // exactly one Center, and a CSV export from HR/placement-cell tooling has
  // no reason to carry that column). Parsed client-side on file select, not
  // on submit, so the row count/errors are visible before committing.
  const [bulkCenterId, setBulkCenterId] = useState('');
  const [bulkRows, setBulkRows] = useState([]);
  const [bulkFileName, setBulkFileName] = useState('');
  const [bulkParseError, setBulkParseError] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);
  const bulkFileInputRef = useRef(null);

  const [toast, setToast] = useState(null);

  function showToast(text, isErr) {
    setToast({ text, isErr });
    setTimeout(() => setToast(null), 2500);
  }

  function loadDirectory() {
    api.getCompanies(effectiveCenterId).then(setDirectory).catch((err) => showToast(err.message, true));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadDirectory(); }, [effectiveCenterId]);

  // Pre-fills the create form's Center field from the Nav switcher whenever
  // it changes — a convenience default, not a lock; admin can still pick a
  // different Center for the company being created.
  useEffect(() => { setCompanyForm((f) => ({ ...f, center_id: effectiveCenterId || '' })); }, [effectiveCenterId]);
  useEffect(() => { setBulkCenterId(effectiveCenterId || ''); }, [effectiveCenterId]);

  function loadFairs() {
    api.getFairSettings(effectiveCenterId).then((rows) => {
      setFairs(rows);
      const active = rows.find((f) => f.is_active);
      setSelectedFairId(active ? active.id : '');
    }).catch((err) => showToast(err.message, true));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadFairs(); }, [effectiveCenterId]);

  function loadRoster(fairId) {
    if (!fairId) { setRoster([]); return; }
    api.getRoster(fairId).then(setRoster).catch((err) => showToast(err.message, true));
  }

  useEffect(() => { loadRoster(selectedFairId); }, [selectedFairId]);

  const selectedFair = fairs.find((f) => f.id === selectedFairId);
  const isActiveFairSelected = !!selectedFair && selectedFair.is_active;
  const rosterCompanyIds = new Set((roster || []).map((r) => r.company_id));
  const availableToAdd = (directory || []).filter((c) => !rosterCompanyIds.has(c.id));

  function loadDetail(id) {
    api.getCompany(id).then((c) => {
      setDetail(c);
      setEditForm({
        company_name: c.company_name, description: c.description || '', location: c.location || '',
        field: c.field || '', job_type: c.job_type || '',
        min_qualification: c.min_qualification || '', max_qualification: c.max_qualification || '',
      });
    }).catch((err) => showToast(err.message, true));
  }

  function toggleExpand(id) {
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(id);
    setParamForm(emptyParamForm);
    setPostForm(emptyPostForm);
    setEditingPostId(null);
    loadDetail(id);
  }

  async function createCompany(e) {
    e.preventDefault();
    // fair_cycle_isolation_plan.md Phase 4: a company is permanently tied to
    // one Center, so this is the one field admin must pick explicitly rather
    // than defaulting silently — pre-filled from the Nav switcher's current
    // selection (see the effect above) as a convenience only.
    if (!companyForm.center_id) { showToast('Pick a center', true); return; }
    setCreating(true);
    try {
      await api.createCompany({ ...companyForm, center_id: Number(companyForm.center_id) });
      showToast(`${companyForm.company_name} added`);
      setCompanyForm({ ...emptyCompanyForm, center_id: effectiveCenterId || '' });
      loadDirectory();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setCreating(false);
    }
  }

  function downloadBulkTemplate() {
    const csv = `${BULK_TEMPLATE_HEADER.join(',')}\n` +
      'Acme Robotics,Robotics & automation,Hall A Desk 5,Engineering,Full-time,B.Tech,M.Tech,2,8,1\n';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'companies_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleBulkFile(e) {
    const file = e.target.files[0];
    setBulkResult(null);
    if (!file) { setBulkRows([]); setBulkFileName(''); setBulkParseError(null); return; }
    setBulkFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = csvToCompanyRows(String(reader.result));
        if (!parsed.length) {
          setBulkRows([]);
          setBulkParseError('No data rows found — check the file has a header row plus at least one company.');
          return;
        }
        const withoutName = parsed.filter((r) => !r.company_name).length;
        if (withoutName) {
          setBulkRows([]);
          setBulkParseError(`${withoutName} row(s) are missing company_name — every row needs one.`);
          return;
        }
        setBulkParseError(null);
        setBulkRows(parsed);
      } catch {
        setBulkRows([]);
        setBulkParseError('Could not read that file as CSV.');
      }
    };
    reader.readAsText(file);
  }

  async function runBulkImport() {
    if (!bulkCenterId) { showToast('Pick a center', true); return; }
    if (!bulkRows.length) return;
    setBulkBusy(true);
    setBulkResult(null);
    try {
      const payload = bulkRows.map((r) => ({ ...r, center_id: Number(bulkCenterId) }));
      const res = await api.createCompaniesBulk(payload);
      setBulkResult(res);
      showToast(
        `${res.created.length} added${res.failed.length ? `, ${res.failed.length} failed` : ''}`,
        res.created.length === 0 && res.failed.length > 0
      );
      setBulkRows([]);
      setBulkFileName('');
      if (bulkFileInputRef.current) bulkFileInputRef.current.value = '';
      loadDirectory();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setBulkBusy(false);
    }
  }

  async function deleteCompany(company) {
    if (!window.confirm(`Delete ${company.company_name}? This can't be undone.`)) return;
    try {
      await api.deleteCompany(company.id);
      showToast(`${company.company_name} deleted`);
      if (expandedId === company.id) {
        setExpandedId(null);
        setDetail(null);
      }
      loadDirectory();
      loadRoster(selectedFairId);
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function saveEdit(e) {
    e.preventDefault();
    setSavingEdit(true);
    try {
      await api.updateCompany(expandedId, editForm);
      showToast('Company details saved');
      loadDetail(expandedId);
      loadDirectory();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setSavingEdit(false);
    }
  }

  async function addToRoster(e) {
    e.preventDefault();
    if (!addCompanyId) return;
    setRosterBusy(true);
    try {
      await api.upsertRoster(selectedFairId, {
        company_id: Number(addCompanyId),
        seats: rosterAddForm.seats ? Number(rosterAddForm.seats) : undefined,
        interview_minutes: rosterAddForm.interview_minutes ? Number(rosterAddForm.interview_minutes) : undefined,
        floor_number: rosterAddForm.floor_number !== '' ? Number(rosterAddForm.floor_number) : undefined,
      });
      showToast('Added to today\'s roster');
      setAddCompanyId('');
      setRosterAddForm(emptyRosterAddForm);
      loadRoster(selectedFairId);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setRosterBusy(false);
    }
  }

  // Optimistic toggle, same convention this screen's toggle used before the
  // roster split — flip immediately, reconcile with the server's actual
  // value on success, roll back + toast on failure.
  async function toggleRosterOpen(row) {
    const previous = row.is_open;
    const next = !previous;
    setRoster((rows) => rows.map((r) => (r.company_id === row.company_id ? { ...r, is_open: next } : r)));
    setRosterBusy(true);
    try {
      const res = await api.updateRoster(selectedFairId, row.company_id, { is_open: next });
      setRoster((rows) => rows.map((r) => (r.company_id === row.company_id ? { ...r, is_open: res.is_open } : r)));
    } catch (err) {
      setRoster((rows) => rows.map((r) => (r.company_id === row.company_id ? { ...r, is_open: previous } : r)));
      showToast(err.message, true);
    } finally {
      setRosterBusy(false);
    }
  }

  async function removeFromRoster(row) {
    if (!window.confirm(`Remove ${row.company_name} from today's roster? Candidates already booked here are untouched.`)) return;
    setRosterBusy(true);
    try {
      await api.removeRoster(selectedFairId, row.company_id);
      showToast(`${row.company_name} removed from today's roster`);
      loadRoster(selectedFairId);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setRosterBusy(false);
    }
  }

  async function addParameter(e) {
    e.preventDefault();
    if (!paramForm.parameter_name) return;
    try {
      await api.addRatingParameter(expandedId, {
        parameter_name: paramForm.parameter_name,
        display_order: paramForm.display_order ? Number(paramForm.display_order) : undefined,
      });
      showToast('Parameter added');
      setParamForm(emptyParamForm);
      loadDetail(expandedId);
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function removeParameter(param) {
    if (!window.confirm(`Remove parameter "${param.parameter_name}"?`)) return;
    try {
      await api.deleteRatingParameter(expandedId, param.id);
      showToast('Parameter removed');
      loadDetail(expandedId);
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function addPosting(e) {
    e.preventDefault();
    if (!postForm.post_title) return;
    try {
      await api.addCompanyPost(expandedId, {
        post_title: postForm.post_title,
        vacancies: postForm.vacancies ? Number(postForm.vacancies) : undefined,
        qualification: postForm.qualification || undefined,
        gender: postForm.gender || undefined,
        age_min: postForm.age_min ? Number(postForm.age_min) : undefined,
        age_max: postForm.age_max ? Number(postForm.age_max) : undefined,
      });
      showToast('Posting added');
      setPostForm(emptyPostForm);
      loadDetail(expandedId);
    } catch (err) {
      showToast(err.message, true);
    }
  }

  function startEditPost(post) {
    setEditingPostId(post.id);
    setEditPost({
      post_title: post.post_title,
      vacancies: post.vacancies,
      qualification: post.qualification || '',
      gender: post.gender || '',
      age_min: post.age_min ?? '',
      age_max: post.age_max ?? '',
    });
  }

  function cancelEditPost() {
    setEditingPostId(null);
  }

  async function saveEditPost(post) {
    try {
      await api.updateCompanyPost(expandedId, post.id, {
        post_title: editPost.post_title,
        vacancies: editPost.vacancies ? Number(editPost.vacancies) : undefined,
        qualification: editPost.qualification || undefined,
        gender: editPost.gender || undefined,
        age_min: editPost.age_min ? Number(editPost.age_min) : undefined,
        age_max: editPost.age_max ? Number(editPost.age_max) : undefined,
      });
      showToast('Posting updated');
      cancelEditPost();
      loadDetail(expandedId);
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function removePosting(post) {
    if (!window.confirm(`Remove posting "${post.post_title}"?`)) return;
    try {
      await api.deleteCompanyPost(expandedId, post.id);
      showToast('Posting removed');
      loadDetail(expandedId);
    } catch (err) {
      showToast(err.message, true);
    }
  }

  return (
    <div className="s-body">
      <h2 className="screen-title">Companies</h2>

      <div className="sec-label" style={{ marginBottom: 10 }}>
        Today's roster {selectedFair && !isActiveFairSelected && '— viewing a past cycle, read-only'}
      </div>
      <div className="field" style={{ maxWidth: 260, marginBottom: 16 }}>
        <label>Fair cycle</label>
        <select value={selectedFairId} onChange={(e) => setSelectedFairId(e.target.value ? Number(e.target.value) : '')}>
          <option value="">No cycle selected</option>
          {fairs.map((f) => (
            <option key={f.id} value={f.id}>{fmtDate(f.fair_date)}{f.is_active ? ' — active' : ''}</option>
          ))}
        </select>
      </div>

      {!selectedFairId && (
        <p className="save-note" style={{ textAlign: 'left', marginBottom: 20 }}>
          No fair cycle selected — start one from Settings → Fair, or pick a past cycle above to view its roster.
        </p>
      )}

      {!!selectedFairId && (
        <>
          <div className="table-wrap" style={{ marginBottom: 16 }}>
            <table className="data-table">
              <thead>
                <tr><th>Name</th><th>Floor</th><th>Seats / Interview</th><th>Desk</th>{isActiveFairSelected && <th></th>}</tr>
              </thead>
              <tbody>
                {roster && roster.map((r) => (
                  <tr key={r.company_id}>
                    <td>{r.company_name}</td>
                    <td className="mono">{r.floor_number ?? '—'}</td>
                    <td className="mono">{r.seats ?? '—'} / {r.interview_minutes ?? '—'}m</td>
                    <td>
                      {isActiveFairSelected ? (
                        <button
                          className={`checkin-status ${r.is_open ? 'in' : 'out'}`}
                          style={{ cursor: 'pointer', marginTop: 0 }}
                          disabled={rosterBusy}
                          onClick={() => toggleRosterOpen(r)}
                          title="Toggle whether candidates can see and register for this company"
                        >
                          {r.is_open ? 'Open' : 'Closed'}
                        </button>
                      ) : (
                        <span className={`checkin-status ${r.is_open ? 'in' : 'out'}`}>{r.is_open ? 'Open' : 'Closed'}</span>
                      )}
                    </td>
                    {isActiveFairSelected && (
                      <td>
                        <button
                          className="btn ghost"
                          style={{ width: 'auto', padding: '8px 12px', color: 'var(--st-rejected)' }}
                          disabled={rosterBusy}
                          onClick={() => removeFromRoster(r)}
                        >
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
                {roster && !roster.length && (
                  <tr><td colSpan={isActiveFairSelected ? 5 : 4} className="save-note">No companies on this cycle's roster yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {isActiveFairSelected && (
            <>
              <div className="sec-label" style={{ marginBottom: 8 }}>Add an existing company to today's roster</div>
              <form onSubmit={addToRoster} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', marginBottom: 24 }}>
                <div className="field" style={{ maxWidth: 220 }}>
                  <label>Company</label>
                  <select value={addCompanyId} onChange={(e) => setAddCompanyId(e.target.value)} required>
                    <option value="" disabled>Select a company…</option>
                    {availableToAdd.map((c) => <option key={c.id} value={c.id}>{c.company_name}</option>)}
                  </select>
                </div>
                <div className="field" style={{ maxWidth: 90 }}>
                  <label>Seats</label>
                  <input type="number" value={rosterAddForm.seats} onChange={(e) => setRosterAddForm({ ...rosterAddForm, seats: e.target.value })} placeholder="1" />
                </div>
                <div className="field" style={{ maxWidth: 110 }}>
                  <label>Interview min</label>
                  <input type="number" value={rosterAddForm.interview_minutes} onChange={(e) => setRosterAddForm({ ...rosterAddForm, interview_minutes: e.target.value })} placeholder="6" />
                </div>
                <div className="field" style={{ maxWidth: 100 }}>
                  <label>Floor number</label>
                  <input type="number" min="0" value={rosterAddForm.floor_number} onChange={(e) => setRosterAddForm({ ...rosterAddForm, floor_number: e.target.value })} placeholder="0" />
                </div>
                <button className="btn" style={{ width: 'auto', padding: '11px 18px' }} type="submit" disabled={rosterBusy || !availableToAdd.length}>
                  {rosterBusy ? 'Adding…' : '+ Add to roster'}
                </button>
              </form>
            </>
          )}
        </>
      )}

      <div className="sec-label" style={{ marginTop: 8, marginBottom: 10 }}>Directory — every company at this Center, any cycle</div>
      <div className="table-wrap scroll-5">
        <table className="data-table">
          <thead>
            <tr><th>Name</th><th>Field</th><th>Qualification</th><th></th></tr>
          </thead>
          <tbody>
            {directory && directory.map((c) => (
              <Fragment key={c.id}>
                <tr>
                  <td>{c.company_name}</td>
                  <td>{c.field || '—'}</td>
                  <td>{[c.min_qualification, c.max_qualification].filter(Boolean).join(' – ') || '—'}</td>
                  <td style={{ display: 'flex', gap: 6 }}>
                    <button className="btn ghost" style={{ width: 'auto', padding: '8px 12px' }} onClick={() => toggleExpand(c.id)}>
                      {expandedId === c.id ? 'Collapse' : 'Manage'}
                    </button>
                    <button
                      className="btn ghost"
                      style={{ width: 'auto', padding: '8px 12px', color: 'var(--st-rejected)' }}
                      onClick={() => deleteCompany(c)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
                {expandedId === c.id && (
                  <tr>
                    <td colSpan={4}>
                      {!detail ? 'Loading…' : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: '8px 0' }}>
                          <div>
                            <div className="sec-label" style={{ marginBottom: 8 }}>Company details</div>
                            <form onSubmit={saveEdit} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
                              <div className="field" style={{ maxWidth: 200 }}>
                                <label>Name</label>
                                <input value={editForm.company_name} onChange={(e) => setEditForm({ ...editForm, company_name: e.target.value })} required />
                              </div>
                              <div className="field" style={{ maxWidth: 220 }}>
                                <label>Description</label>
                                <input value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} />
                              </div>
                              <div className="field" style={{ maxWidth: 160 }}>
                                <label>Location</label>
                                <input value={editForm.location} onChange={(e) => setEditForm({ ...editForm, location: e.target.value })} placeholder="Hall A Desk 5" />
                              </div>
                              <div className="field" style={{ maxWidth: 140 }}>
                                <label>Field</label>
                                <input value={editForm.field} onChange={(e) => setEditForm({ ...editForm, field: e.target.value })} placeholder="IT Services" />
                              </div>
                              <div className="field" style={{ maxWidth: 140 }}>
                                <label>Job type</label>
                                <input value={editForm.job_type} onChange={(e) => setEditForm({ ...editForm, job_type: e.target.value })} />
                              </div>
                              <div className="field" style={{ maxWidth: 120 }}>
                                <label>Min qualification</label>
                                <input value={editForm.min_qualification} onChange={(e) => setEditForm({ ...editForm, min_qualification: e.target.value })} />
                              </div>
                              <div className="field" style={{ maxWidth: 120 }}>
                                <label>Max qualification</label>
                                <input value={editForm.max_qualification} onChange={(e) => setEditForm({ ...editForm, max_qualification: e.target.value })} />
                              </div>
                              <button className="btn" style={{ width: 'auto', padding: '11px 18px' }} type="submit" disabled={savingEdit}>
                                {savingEdit ? 'Saving…' : 'Save details'}
                              </button>
                            </form>
                          </div>

                          <div>
                            <div className="sec-label" style={{ marginBottom: 8 }}>Rating parameters</div>
                            <table className="data-table">
                              <thead><tr><th>Parameter</th><th>Order</th><th></th></tr></thead>
                              <tbody>
                                {detail.rating_parameters.map((p) => (
                                  <tr key={p.id}>
                                    <td>{p.parameter_name}</td>
                                    <td className="mono">{p.display_order}</td>
                                    <td>
                                      <button
                                        className="btn ghost"
                                        style={{ width: 'auto', padding: '6px 10px', color: 'var(--st-rejected)' }}
                                        onClick={() => removeParameter(p)}
                                      >
                                        Remove
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                                {!detail.rating_parameters.length && (
                                  <tr><td colSpan={3} className="save-note">No rating parameters yet.</td></tr>
                                )}
                              </tbody>
                            </table>
                            <form onSubmit={addParameter} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', marginTop: 10 }}>
                              <div className="field" style={{ maxWidth: 200 }}>
                                <label>Parameter name</label>
                                <input value={paramForm.parameter_name} onChange={(e) => setParamForm({ ...paramForm, parameter_name: e.target.value })} required />
                              </div>
                              <div className="field" style={{ maxWidth: 120 }}>
                                <label>Order</label>
                                <input type="number" value={paramForm.display_order} onChange={(e) => setParamForm({ ...paramForm, display_order: e.target.value })} />
                              </div>
                              <button className="btn" style={{ width: 'auto', padding: '11px 18px' }} type="submit">+ Add parameter</button>
                            </form>
                          </div>

                          <div>
                            <div className="sec-label" style={{ marginBottom: 8 }}>Postings</div>
                            <table className="data-table">
                              <thead>
                                <tr><th>Title</th><th>Vacancies</th><th>Qualification</th><th>Gender</th><th>Age range</th><th></th></tr>
                              </thead>
                              <tbody>
                                {detail.posts.map((post) => (
                                  <tr key={post.id}>
                                    {editingPostId === post.id ? (
                                      <>
                                        <td><input value={editPost.post_title} onChange={(e) => setEditPost({ ...editPost, post_title: e.target.value })} /></td>
                                        <td><input type="number" style={{ width: 70 }} value={editPost.vacancies} onChange={(e) => setEditPost({ ...editPost, vacancies: e.target.value })} /></td>
                                        <td><input style={{ width: 100 }} value={editPost.qualification} onChange={(e) => setEditPost({ ...editPost, qualification: e.target.value })} /></td>
                                        <td><input style={{ width: 80 }} value={editPost.gender} onChange={(e) => setEditPost({ ...editPost, gender: e.target.value })} /></td>
                                        <td style={{ display: 'flex', gap: 4 }}>
                                          <input type="number" style={{ width: 50 }} value={editPost.age_min} onChange={(e) => setEditPost({ ...editPost, age_min: e.target.value })} />
                                          <input type="number" style={{ width: 50 }} value={editPost.age_max} onChange={(e) => setEditPost({ ...editPost, age_max: e.target.value })} />
                                        </td>
                                        <td style={{ display: 'flex', gap: 6 }}>
                                          <button className="btn" style={{ width: 'auto', padding: '6px 10px' }} onClick={() => saveEditPost(post)}>Save</button>
                                          <button className="btn ghost" style={{ width: 'auto', padding: '6px 10px' }} onClick={cancelEditPost}>Cancel</button>
                                        </td>
                                      </>
                                    ) : (
                                      <>
                                        <td>{post.post_title}</td>
                                        <td className="mono">{post.vacancies}</td>
                                        <td>{post.qualification || '—'}</td>
                                        <td>{post.gender || '—'}</td>
                                        <td className="mono">{post.age_min ?? '—'}–{post.age_max ?? '—'}</td>
                                        <td style={{ display: 'flex', gap: 6 }}>
                                          <button className="btn ghost" style={{ width: 'auto', padding: '6px 10px' }} onClick={() => startEditPost(post)}>Edit</button>
                                          <button
                                            className="btn ghost"
                                            style={{ width: 'auto', padding: '6px 10px', color: 'var(--st-rejected)' }}
                                            onClick={() => removePosting(post)}
                                          >
                                            Remove
                                          </button>
                                        </td>
                                      </>
                                    )}
                                  </tr>
                                ))}
                                {!detail.posts.length && (
                                  <tr><td colSpan={6} className="save-note">No postings yet.</td></tr>
                                )}
                              </tbody>
                            </table>
                            <form onSubmit={addPosting} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', marginTop: 10 }}>
                              <div className="field" style={{ maxWidth: 200 }}>
                                <label>Title</label>
                                <input value={postForm.post_title} onChange={(e) => setPostForm({ ...postForm, post_title: e.target.value })} required />
                              </div>
                              <div className="field" style={{ maxWidth: 100 }}>
                                <label>Vacancies</label>
                                <input type="number" value={postForm.vacancies} onChange={(e) => setPostForm({ ...postForm, vacancies: e.target.value })} placeholder="1" />
                              </div>
                              <div className="field" style={{ maxWidth: 140 }}>
                                <label>Qualification</label>
                                <input value={postForm.qualification} onChange={(e) => setPostForm({ ...postForm, qualification: e.target.value })} />
                              </div>
                              <div className="field" style={{ maxWidth: 100 }}>
                                <label>Gender</label>
                                <input value={postForm.gender} onChange={(e) => setPostForm({ ...postForm, gender: e.target.value })} placeholder="Any" />
                              </div>
                              <div className="field" style={{ maxWidth: 80 }}>
                                <label>Age min</label>
                                <input type="number" value={postForm.age_min} onChange={(e) => setPostForm({ ...postForm, age_min: e.target.value })} />
                              </div>
                              <div className="field" style={{ maxWidth: 80 }}>
                                <label>Age max</label>
                                <input type="number" value={postForm.age_max} onChange={(e) => setPostForm({ ...postForm, age_max: e.target.value })} />
                              </div>
                              <button className="btn" style={{ width: 'auto', padding: '11px 18px' }} type="submit">+ Add posting</button>
                            </form>
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {directory && !directory.length && (
              <tr><td colSpan={4} className="save-note">No companies yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="sec-label" style={{ marginTop: 24, marginBottom: 10 }}>Add company to directory</div>
      <form onSubmit={createCompany} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
        <div className="field" style={{ maxWidth: 200 }}>
          <label>Name</label>
          <input value={companyForm.company_name} onChange={(e) => setCompanyForm({ ...companyForm, company_name: e.target.value })} required />
        </div>
        <div className="field" style={{ maxWidth: 160 }}>
          <label>Center</label>
          <select value={companyForm.center_id} onChange={(e) => setCompanyForm({ ...companyForm, center_id: e.target.value })} required>
            <option value="" disabled>Select a center…</option>
            {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="field" style={{ maxWidth: 220 }}>
          <label>Description</label>
          <input value={companyForm.description} onChange={(e) => setCompanyForm({ ...companyForm, description: e.target.value })} />
        </div>
        <div className="field" style={{ maxWidth: 160 }}>
          <label>Location</label>
          <input value={companyForm.location} onChange={(e) => setCompanyForm({ ...companyForm, location: e.target.value })} placeholder="Hall A Desk 5" />
        </div>
        <div className="field" style={{ maxWidth: 140 }}>
          <label>Field</label>
          <input value={companyForm.field} onChange={(e) => setCompanyForm({ ...companyForm, field: e.target.value })} placeholder="IT Services" />
        </div>
        <div className="field" style={{ maxWidth: 140 }}>
          <label>Job type</label>
          <input value={companyForm.job_type} onChange={(e) => setCompanyForm({ ...companyForm, job_type: e.target.value })} />
        </div>
        <div className="field" style={{ maxWidth: 120 }}>
          <label>Min qualification</label>
          <input value={companyForm.min_qualification} onChange={(e) => setCompanyForm({ ...companyForm, min_qualification: e.target.value })} />
        </div>
        <div className="field" style={{ maxWidth: 120 }}>
          <label>Max qualification</label>
          <input value={companyForm.max_qualification} onChange={(e) => setCompanyForm({ ...companyForm, max_qualification: e.target.value })} />
        </div>
        <button className="btn" style={{ width: 'auto', padding: '11px 18px' }} type="submit" disabled={creating}>
          {creating ? 'Adding…' : '+ Add to directory'}
        </button>
      </form>

      <div className="sec-label" style={{ marginTop: 24, marginBottom: 10 }}>Bulk import (CSV)</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', marginBottom: 10 }}>
        <div className="field" style={{ maxWidth: 160 }}>
          <label>Center</label>
          <select value={bulkCenterId} onChange={(e) => setBulkCenterId(e.target.value)} required>
            <option value="" disabled>Select a center…</option>
            {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="field" style={{ maxWidth: 260 }}>
          <label>CSV file</label>
          <input ref={bulkFileInputRef} type="file" accept=".csv,text/csv" onChange={handleBulkFile} />
        </div>
        <button type="button" className="btn ghost" style={{ width: 'auto', padding: '11px 18px' }} onClick={downloadBulkTemplate}>
          Download template
        </button>
        <button
          type="button"
          className="btn"
          style={{ width: 'auto', padding: '11px 18px' }}
          disabled={bulkBusy || !bulkRows.length}
          onClick={runBulkImport}
        >
          {bulkBusy ? 'Importing…' : bulkRows.length ? `Import ${bulkRows.length} companies` : 'Import'}
        </button>
      </div>
      <p className="save-note" style={{ textAlign: 'left', marginBottom: 16 }}>
        Columns: {BULK_TEMPLATE_HEADER.join(', ')}. Only <code>company_name</code> is required — everything else
        is optional, same as adding one company by hand. Each row gets the standard rating parameters and, if the
        picked Center has an active fair, a first roster row (closed by default) — same as the single-company form above.
      </p>
      {bulkParseError && <div className="error-note" style={{ marginBottom: 16 }}>{bulkParseError}</div>}
      {bulkFileName && !bulkParseError && !bulkResult && (
        <p className="save-note" style={{ textAlign: 'left', marginBottom: 16 }}>
          {bulkFileName}: {bulkRows.length} row{bulkRows.length === 1 ? '' : 's'} ready to import.
        </p>
      )}
      {bulkResult && (
        <div style={{ marginBottom: 20 }}>
          <p className="save-note" style={{ textAlign: 'left' }}>
            {bulkResult.created.length} added, {bulkResult.failed.length} failed.
          </p>
          {!!bulkResult.failed.length && (
            <div className="table-wrap scroll-5">
              <table className="data-table">
                <thead><tr><th>Row</th><th>Name</th><th>Error</th></tr></thead>
                <tbody>
                  {bulkResult.failed.map((f) => (
                    <tr key={f.row}>
                      <td className="mono">{f.row}</td>
                      <td>{f.company_name || '—'}</td>
                      <td>{f.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {toast && <div className={`toast${toast.isErr ? ' err' : ''}`}>{toast.text}</div>}
    </div>
  );
}
