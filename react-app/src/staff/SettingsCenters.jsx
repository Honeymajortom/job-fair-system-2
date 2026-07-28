import { useEffect, useState } from 'react';
import { api } from '../api';
import { useCenter } from './CenterContext';

// settings_tab_plan.md — Center *management* (the list + add-new form) and
// Center *selection* (the "Viewing" segmented control) both live here now;
// the Nav's own switcher was removed in favor of this, one screen for both,
// and just shows the current selection read-only. Both read/write the same
// CenterContext, so nothing here can drift from what other tabs see.
export default function SettingsCenters() {
  const { centers, addCenter, selectedCenterId, setSelectedCenterId } = useCenter();
  const [companyCounts, setCompanyCounts] = useState({});
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  function showToast(text, isErr) {
    setToast({ text, isErr });
    setTimeout(() => setToast(null), 2500);
  }

  useEffect(() => {
    // Unscoped (admin sees every company) — one request, counted client-side
    // per center_id, instead of one request per center row.
    api.getCompanies().then((rows) => {
      const counts = {};
      for (const c of rows) counts[c.center_id] = (counts[c.center_id] || 0) + 1;
      setCompanyCounts(counts);
    }).catch(() => {});
  }, [centers]);

  async function submitAdd(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const created = await addCenter({ name, location: location || undefined });
      showToast(`${created.name} added`);
      setName('');
      setLocation('');
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="sec-label" style={{ marginBottom: 10 }}>Viewing</div>
      <div className="field" style={{ maxWidth: 260, marginBottom: 8 }}>
        <label>Center</label>
        <select
          value={selectedCenterId || ''}
          onChange={(e) => setSelectedCenterId(e.target.value ? Number(e.target.value) : '')}
        >
          <option value="">All centers</option>
          {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <p className="save-note" style={{ textAlign: 'left', marginBottom: 24 }}>
        Scopes Floor, Gate, Desk, Users, Companies, Reports and Insights to one Center — carries over to every other tab.
      </p>

      <div className="sec-label" style={{ marginBottom: 10 }}>Centers</div>
      <div className="table-wrap scroll-5">
        <table className="data-table">
          <thead>
            <tr><th>Name</th><th>Location</th><th>Companies</th><th>Created</th></tr>
          </thead>
          <tbody>
            {centers.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.location || '—'}</td>
                <td className="mono">{companyCounts[c.id] || 0}</td>
                <td className="mono">{new Date(c.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
            {!centers.length && (
              <tr><td colSpan={4} className="save-note">No centers yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="sec-label" style={{ marginTop: 24, marginBottom: 10 }}>Add center</div>
      <form onSubmit={submitAdd} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
        <div className="field" style={{ maxWidth: 220 }}>
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="field" style={{ maxWidth: 220 }}>
          <label>Location</label>
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="City, venue" />
        </div>
        <button className="btn" style={{ width: 'auto', padding: '11px 18px' }} type="submit" disabled={saving}>
          {saving ? 'Adding…' : '+ Add center'}
        </button>
      </form>

      {toast && <div className={`toast${toast.isErr ? ' err' : ''}`}>{toast.text}</div>}
    </div>
  );
}
