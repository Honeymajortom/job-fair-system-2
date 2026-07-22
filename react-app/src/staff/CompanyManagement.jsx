import { Fragment, useEffect, useState } from 'react';
import { api } from '../api';

const emptyCompanyForm = {
  company_name: '', description: '', location: '', floor_number: '', field: '', job_type: '',
  min_qualification: '', max_qualification: '', seats: '', interview_minutes: '',
};

const emptyEditForm = {
  company_name: '', description: '', location: '', floor_number: '', field: '', job_type: '',
  min_qualification: '', max_qualification: '', seats: '', interview_minutes: '',
};

const emptyParamForm = { parameter_name: '', display_order: '' };

const emptyPostForm = {
  post_title: '', vacancies: '', qualification: '', gender: '', age_min: '', age_max: '',
};

export default function CompanyManagement() {
  const [roster, setRoster] = useState(null);
  const [companyForm, setCompanyForm] = useState(emptyCompanyForm);
  const [creating, setCreating] = useState(false);

  const [expandedId, setExpandedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [editForm, setEditForm] = useState(emptyEditForm);
  const [savingEdit, setSavingEdit] = useState(false);
  const [togglingOpen, setTogglingOpen] = useState(null);

  const [paramForm, setParamForm] = useState(emptyParamForm);
  const [postForm, setPostForm] = useState(emptyPostForm);
  const [editingPostId, setEditingPostId] = useState(null);
  const [editPost, setEditPost] = useState(emptyPostForm);

  const [toast, setToast] = useState(null);

  function showToast(text, isErr) {
    setToast({ text, isErr });
    setTimeout(() => setToast(null), 2500);
  }

  function loadRoster() {
    api.getCompanies().then(setRoster).catch((err) => showToast(err.message, true));
  }

  useEffect(() => { loadRoster(); }, []);

  function loadDetail(id) {
    api.getCompany(id).then((c) => {
      setDetail(c);
      setEditForm({
        company_name: c.company_name, description: c.description || '', location: c.location || '',
        floor_number: c.floor_number ?? '', field: c.field || '', job_type: c.job_type || '',
        min_qualification: c.min_qualification || '', max_qualification: c.max_qualification || '',
        seats: c.seats ?? '', interview_minutes: c.interview_minutes ?? '',
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
    setCreating(true);
    try {
      await api.createCompany({
        ...companyForm,
        floor_number: companyForm.floor_number ? Number(companyForm.floor_number) : undefined,
        seats: companyForm.seats ? Number(companyForm.seats) : undefined,
        interview_minutes: companyForm.interview_minutes ? Number(companyForm.interview_minutes) : undefined,
      });
      showToast(`${companyForm.company_name} added`);
      setCompanyForm(emptyCompanyForm);
      loadRoster();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setCreating(false);
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
      loadRoster();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function saveEdit(e) {
    e.preventDefault();
    setSavingEdit(true);
    try {
      await api.updateCompany(expandedId, {
        ...editForm,
        floor_number: editForm.floor_number !== '' ? Number(editForm.floor_number) : undefined,
        seats: editForm.seats !== '' ? Number(editForm.seats) : undefined,
        interview_minutes: editForm.interview_minutes !== '' ? Number(editForm.interview_minutes) : undefined,
      });
      showToast('Company details saved');
      loadDetail(expandedId);
      loadRoster();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setSavingEdit(false);
    }
  }

  async function toggleOpen(company) {
    setTogglingOpen(company.id);
    try {
      await api.setCompanyOpenStatus(company.id, !company.is_open);
      loadRoster();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setTogglingOpen(null);
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
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr><th>Name</th><th>Floor</th><th>Field</th><th>Qualification</th><th>Seats / Interview</th><th>Desk</th><th></th></tr>
          </thead>
          <tbody>
            {roster && roster.map((c) => (
              <Fragment key={c.id}>
                <tr>
                  <td>{c.company_name}</td>
                  <td className="mono">{c.floor_number ?? '—'}</td>
                  <td>{c.field || '—'}</td>
                  <td>{[c.min_qualification, c.max_qualification].filter(Boolean).join(' – ') || '—'}</td>
                  <td className="mono">{c.seats ?? '—'} / {c.interview_minutes ?? '—'}m</td>
                  <td>
                    <button
                      className={`checkin-status ${c.is_open ? 'in' : 'out'}`}
                      style={{ cursor: 'pointer', marginTop: 0 }}
                      disabled={togglingOpen === c.id}
                      onClick={() => toggleOpen(c)}
                      title="Toggle whether candidates can see and register for this company"
                    >
                      {togglingOpen === c.id ? '…' : c.is_open ? 'Open' : 'Closed'}
                    </button>
                  </td>
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
                    <td colSpan={7}>
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
                              <div className="field" style={{ maxWidth: 100 }}>
                                <label>Floor number</label>
                                <input type="number" min="0" value={editForm.floor_number} onChange={(e) => setEditForm({ ...editForm, floor_number: e.target.value })} placeholder="0" />
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
                              <div className="field" style={{ maxWidth: 90 }}>
                                <label>Seats</label>
                                <input type="number" value={editForm.seats} onChange={(e) => setEditForm({ ...editForm, seats: e.target.value })} placeholder="1" />
                              </div>
                              <div className="field" style={{ maxWidth: 110 }}>
                                <label>Interview min</label>
                                <input type="number" value={editForm.interview_minutes} onChange={(e) => setEditForm({ ...editForm, interview_minutes: e.target.value })} placeholder="6" />
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
            {roster && !roster.length && (
              <tr><td colSpan={7} className="save-note">No companies yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="sec-label" style={{ marginTop: 24, marginBottom: 10 }}>Add company</div>
      <form onSubmit={createCompany} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
        <div className="field" style={{ maxWidth: 200 }}>
          <label>Name</label>
          <input value={companyForm.company_name} onChange={(e) => setCompanyForm({ ...companyForm, company_name: e.target.value })} required />
        </div>
        <div className="field" style={{ maxWidth: 220 }}>
          <label>Description</label>
          <input value={companyForm.description} onChange={(e) => setCompanyForm({ ...companyForm, description: e.target.value })} />
        </div>
        <div className="field" style={{ maxWidth: 160 }}>
          <label>Location</label>
          <input value={companyForm.location} onChange={(e) => setCompanyForm({ ...companyForm, location: e.target.value })} placeholder="Hall A Desk 5" />
        </div>
        <div className="field" style={{ maxWidth: 100 }}>
          <label>Floor number</label>
          <input type="number" min="0" value={companyForm.floor_number} onChange={(e) => setCompanyForm({ ...companyForm, floor_number: e.target.value })} placeholder="0" />
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
        <div className="field" style={{ maxWidth: 90 }}>
          <label>Seats</label>
          <input type="number" value={companyForm.seats} onChange={(e) => setCompanyForm({ ...companyForm, seats: e.target.value })} placeholder="1" />
        </div>
        <div className="field" style={{ maxWidth: 110 }}>
          <label>Interview min</label>
          <input type="number" value={companyForm.interview_minutes} onChange={(e) => setCompanyForm({ ...companyForm, interview_minutes: e.target.value })} placeholder="6" />
        </div>
        <button className="btn" style={{ width: 'auto', padding: '11px 18px' }} type="submit" disabled={creating}>
          {creating ? 'Adding…' : '+ Add company'}
        </button>
      </form>

      {toast && <div className={`toast${toast.isErr ? ' err' : ''}`}>{toast.text}</div>}
    </div>
  );
}
