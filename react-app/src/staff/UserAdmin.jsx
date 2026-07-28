import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from './AuthContext';
import { useCenter } from './CenterContext';
import CandidateAdmin from './CandidateAdmin';

const ROLES = ['admin', 'registration_staff', 'floor_manager', 'company_hr', 'volunteer'];
// fair_cycle_isolation_plan.md Phase 4 — every non-admin role except
// company_hr needs a Center picked directly (company_hr's is derived
// server-side from its company instead — see routes/users.js).
const CENTER_SCOPED_ROLES = ['registration_staff', 'floor_manager', 'volunteer'];

export default function UserAdmin() {
  const { user } = useAuth();
  const { centers, centerName, effectiveCenterId } = useCenter();
  const [roster, setRoster] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editRole, setEditRole] = useState('');
  const [editCompanyId, setEditCompanyId] = useState('');
  const [editCenterId, setEditCenterId] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [newUsernameLocal, setNewUsernameLocal] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('registration_staff');
  const [newCompanyId, setNewCompanyId] = useState('');
  const [newCenterId, setNewCenterId] = useState('');
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState(null);

  function showToast(text, isErr) {
    setToast({ text, isErr });
    setTimeout(() => setToast(null), 2500);
  }

  function loadRoster() {
    api.getUsers(effectiveCenterId).then(setRoster).catch((err) => showToast(err.message, true));
  }

  // Widened to registration_staff 2026-07-25 for the Candidates section below
  // — the staff-account roster itself stays admin-only, so skip fetching it
  // (and the company list it needs) entirely for a role that can't see it, to
  // avoid a guaranteed-403 request on page load.
  const isAdmin = user.role === 'admin';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (isAdmin) loadRoster(); }, [isAdmin, effectiveCenterId]);
  // Needed for the Company HR company picker (both the add-staff form and the
  // roster's Company column) — same roster-fetching endpoint CompanyManagement
  // already uses.
  useEffect(() => { if (isAdmin) api.getCompanies(effectiveCenterId).then(setCompanies).catch(() => {}); }, [isAdmin, effectiveCenterId]);

  function companyName(id) {
    const c = companies.find((c) => c.id === id);
    return c ? c.company_name : '—';
  }

  function startEdit(row) {
    setEditingId(row.id);
    setEditRole(row.role);
    setEditCompanyId(row.company_id ?? '');
    setEditCenterId(row.center_id ?? '');
    setEditPassword('');
  }

  function cancelEdit() {
    setEditingId(null);
    setEditPassword('');
  }

  async function saveEdit(row) {
    const payload = {};
    if (editRole !== row.role) payload.role = editRole;
    if (editPassword) payload.password = editPassword;
    // Company HR always needs a company_id in the request — the backend can't
    // tell "keep the one already on file" from "none provided" otherwise
    // (routes/users.js), so this sends it whenever the role is (or is
    // becoming) company_hr, not just when it changed.
    if (editRole === 'company_hr') {
      if (!editCompanyId) { showToast('Pick a company for this Company HR account', true); return; }
      payload.company_id = Number(editCompanyId);
    }
    // Same "always resend it on this exact call" rule as company_id above —
    // the backend can't tell "keep the center already on file" from "none
    // provided" when the role is (or is becoming) one of these three.
    if (CENTER_SCOPED_ROLES.includes(editRole)) {
      if (!editCenterId) { showToast('Pick a center for this account', true); return; }
      payload.center_id = Number(editCenterId);
    }
    if (!Object.keys(payload).length) { cancelEdit(); return; }
    try {
      await api.updateUser(row.id, payload);
      showToast(`${row.username} updated`);
      cancelEdit();
      loadRoster();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function removeUser(row) {
    if (row.id === user.id) return;
    if (!window.confirm(`Remove ${row.username}?`)) return;
    try {
      await api.deleteUser(row.id);
      showToast(`${row.username} removed`);
      loadRoster();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function createStaff(e) {
    e.preventDefault();
    if (newRole === 'company_hr' && !newCompanyId) {
      showToast('Pick a company for this Company HR account', true);
      return;
    }
    if (CENTER_SCOPED_ROLES.includes(newRole) && !newCenterId) {
      showToast('Pick a center for this account', true);
      return;
    }
    const username = `${newUsernameLocal.trim()}@sdc.com`;
    setCreating(true);
    try {
      await api.createUser({
        username,
        password: newPassword,
        role: newRole,
        company_id: newRole === 'company_hr' ? Number(newCompanyId) : undefined,
        center_id: CENTER_SCOPED_ROLES.includes(newRole) ? Number(newCenterId) : undefined,
      });
      showToast(`${username} added`);
      setNewUsernameLocal('');
      setNewPassword('');
      setNewRole('registration_staff');
      setNewCompanyId('');
      setNewCenterId('');
      loadRoster();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="s-body">
      <h2 className="screen-title">Users</h2>
      {isAdmin && (
      <>
      <div className="sec-label" style={{ marginBottom: 10 }}>Staff accounts</div>
      <div className="table-wrap scroll-5">
        <table className="data-table">
          <thead>
            <tr><th>Username</th><th>Role</th><th>Company</th><th>Center</th><th>Created</th><th></th></tr>
          </thead>
          <tbody>
            {roster && roster.map((row) => (
              <tr key={row.id}>
                <td>{row.username}</td>
                <td>
                  {editingId === row.id ? (
                    <div className="field" style={{ maxWidth: 180 }}>
                      <select value={editRole} onChange={(e) => setEditRole(e.target.value)}>
                        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                  ) : (
                    <span className={`role-chip ${row.role}`}>{row.role}</span>
                  )}
                </td>
                <td>
                  {editingId === row.id ? (
                    editRole === 'company_hr' && (
                      <div className="field" style={{ maxWidth: 180 }}>
                        <select value={editCompanyId} onChange={(e) => setEditCompanyId(e.target.value)} required>
                          <option value="" disabled>Select a company…</option>
                          {companies.map((c) => <option key={c.id} value={c.id}>{c.company_name}</option>)}
                        </select>
                      </div>
                    )
                  ) : row.role === 'company_hr' ? companyName(row.company_id) : '—'}
                </td>
                <td>
                  {editingId === row.id ? (
                    CENTER_SCOPED_ROLES.includes(editRole) && (
                      <div className="field" style={{ maxWidth: 160 }}>
                        <select value={editCenterId} onChange={(e) => setEditCenterId(e.target.value)} required>
                          <option value="" disabled>Select a center…</option>
                          {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </div>
                    )
                  ) : row.center_id != null ? (centerName(row.center_id) || '—') : '—'}
                </td>
                <td className="mono">{new Date(row.created_at).toLocaleDateString()}</td>
                <td>
                  {editingId === row.id ? (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'end', flexWrap: 'wrap' }}>
                      <div className="field" style={{ maxWidth: 160 }}>
                        <label>New password</label>
                        <input type="password" value={editPassword} onChange={(e) => setEditPassword(e.target.value)} placeholder="leave blank to keep" minLength={6} />
                      </div>
                      <button className="btn" style={{ width: 'auto', padding: '8px 12px' }} onClick={() => saveEdit(row)}>Save</button>
                      <button className="btn ghost" style={{ width: 'auto', padding: '8px 12px' }} onClick={cancelEdit}>Cancel</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn ghost" style={{ width: 'auto', padding: '8px 12px' }} onClick={() => startEdit(row)}>Edit</button>
                      <button
                        className="btn ghost"
                        style={{ width: 'auto', padding: '8px 12px', color: 'var(--st-rejected)' }}
                        disabled={row.id === user.id}
                        onClick={() => removeUser(row)}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {roster && !roster.length && (
              <tr><td colSpan={6} className="save-note">No staff accounts yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="sec-label" style={{ marginTop: 24, marginBottom: 10 }}>Add staff</div>
      <form onSubmit={createStaff} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
        <div className="field" style={{ maxWidth: 240 }}>
          <label>Username</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              value={newUsernameLocal}
              onChange={(e) => setNewUsernameLocal(e.target.value)}
              placeholder={newRole === 'company_hr' ? 'company-name' : 'name'}
              pattern="[a-zA-Z0-9._-]+"
              title="Letters, numbers, dots, underscores, hyphens only"
              required
            />
            <span className="save-note" style={{ marginTop: 0, whiteSpace: 'nowrap' }}>@sdc.com</span>
          </div>
        </div>
        <div className="field" style={{ maxWidth: 200 }}>
          <label>Temp password</label>
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={6} required />
        </div>
        <div className="field" style={{ maxWidth: 200 }}>
          <label>Role</label>
          <select value={newRole} onChange={(e) => { setNewRole(e.target.value); setNewCompanyId(''); setNewCenterId(''); }}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        {newRole === 'company_hr' && (
          <div className="field" style={{ maxWidth: 200 }}>
            <label>Company</label>
            <select value={newCompanyId} onChange={(e) => setNewCompanyId(e.target.value)} required>
              <option value="" disabled>Select a company…</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.company_name}</option>)}
            </select>
          </div>
        )}
        {CENTER_SCOPED_ROLES.includes(newRole) && (
          <div className="field" style={{ maxWidth: 200 }}>
            <label>Center</label>
            <select value={newCenterId} onChange={(e) => setNewCenterId(e.target.value)} required>
              <option value="" disabled>Select a center…</option>
              {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <button className="btn" style={{ width: 'auto', padding: '11px 18px' }} type="submit" disabled={creating}>
          {creating ? 'Adding…' : '+ Add staff'}
        </button>
      </form>

      {toast && <div className={`toast${toast.isErr ? ' err' : ''}`}>{toast.text}</div>}
      </>
      )}

      <CandidateAdmin />
    </div>
  );
}
