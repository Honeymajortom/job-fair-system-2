import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from './AuthContext';

const ROLES = ['admin', 'registration_staff', 'floor_manager', 'company_hr', 'volunteer'];

export default function UserAdmin() {
  const { user } = useAuth();
  const [roster, setRoster] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editRole, setEditRole] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('registration_staff');
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState(null);

  function showToast(text, isErr) {
    setToast({ text, isErr });
    setTimeout(() => setToast(null), 2500);
  }

  function loadRoster() {
    api.getUsers().then(setRoster).catch((err) => showToast(err.message, true));
  }

  useEffect(() => { loadRoster(); }, []);

  function startEdit(row) {
    setEditingId(row.id);
    setEditRole(row.role);
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
    setCreating(true);
    try {
      await api.createUser({ username: newUsername, password: newPassword, role: newRole });
      showToast(`${newUsername} added`);
      setNewUsername('');
      setNewPassword('');
      setNewRole('registration_staff');
      loadRoster();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="s-body">
      <h2 className="screen-title">Staff</h2>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr><th>Username</th><th>Role</th><th>Created</th><th></th></tr>
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
              <tr><td colSpan={4} className="save-note">No staff accounts yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="sec-label" style={{ marginTop: 24, marginBottom: 10 }}>Add staff</div>
      <form onSubmit={createStaff} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
        <div className="field" style={{ maxWidth: 200 }}>
          <label>Username</label>
          <input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} required />
        </div>
        <div className="field" style={{ maxWidth: 200 }}>
          <label>Temp password</label>
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={6} required />
        </div>
        <div className="field" style={{ maxWidth: 200 }}>
          <label>Role</label>
          <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <button className="btn" style={{ width: 'auto', padding: '11px 18px' }} type="submit" disabled={creating}>
          {creating ? 'Adding…' : '+ Add staff'}
        </button>
      </form>

      {toast && <div className={`toast${toast.isErr ? ' err' : ''}`}>{toast.text}</div>}
    </div>
  );
}
