import { useEffect, useState } from 'react';
import { api } from '../api';
import { useCenter } from './CenterContext';

function fmtDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// settings_tab_plan.md — moved here verbatim (logic unchanged) from
// FloorMonitor.jsx, which used to carry this alongside the live dashboard.
// No role check needed — the whole Settings tab is already admin-gated at
// the route level (StaffApp.jsx), unlike when this lived inline on the
// Floor tab (visible to floor_manager too, so it had to guard itself).
// Styling ported to plain classes (`.field`/`.btn`/`.data-table`) instead of
// the `.floor-v2`-scoped ones (`.bp-card`/`.attn-list`) it borrowed from
// living inside FloorMonitor.jsx — this tab isn't part of the Industry
// redesign, same as Users/Companies/Reports/Insights.
export default function SettingsFair() {
  const { centers, selectedCenterId, effectiveCenterId } = useCenter();
  const [fairSettings, setFairSettings] = useState(null);
  const [fairDate, setFairDate] = useState('');
  // Only shown/required when the Nav switcher is on "All centers" — if admin
  // already has one Center selected there, starting a fair for it needs no
  // extra picker.
  const [fairCenterId, setFairCenterId] = useState('');
  const [startingFair, setStartingFair] = useState(false);
  const [endingFair, setEndingFair] = useState(false);
  const [archivingId, setArchivingId] = useState(null);
  const [toast, setToast] = useState(null);

  function showToast(text, isErr) {
    setToast({ text, isErr });
    setTimeout(() => setToast(null), 2500);
  }

  function loadFairSettings() {
    api.getFairSettings(effectiveCenterId).then(setFairSettings).catch(() => {});
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadFairSettings(); }, [effectiveCenterId]);

  async function startFair(e) {
    e.preventDefault();
    if (!fairDate) { showToast('Pick a date', true); return; }
    // Only ambiguous (needs the inline dropdown's value) when the switcher is
    // on "All centers" AND more than one Center exists — otherwise there's
    // exactly one sane target, no picker was even shown.
    const targetCenterId = selectedCenterId || fairCenterId || (centers.length === 1 ? centers[0].id : '');
    if (!targetCenterId) { showToast('Pick a center', true); return; }
    setStartingFair(true);
    try {
      await api.activateFair({ fair_date: fairDate, center_id: Number(targetCenterId) });
      showToast(`Job fair started for ${fmtDate(fairDate)}`);
      loadFairSettings();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setStartingFair(false);
    }
  }

  async function endFair() {
    if (!activeFair) return;
    if (!window.confirm(`End the job fair for ${fmtDate(activeFair.fair_date)}?`)) return;
    setEndingFair(true);
    try {
      await api.updateFairSettings(activeFair.id, { is_active: false });
      showToast('Job fair ended');
      loadFairSettings();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setEndingFair(false);
    }
  }

  // fair_cycle_isolation_plan.md Phase 3 — the bulk end-of-cycle cleanup.
  // Only ended fairs that still have candidates attached are worth listing;
  // an already-archived (or never-populated) fair has nothing left to do.
  async function archiveFair(fair) {
    if (!window.confirm(`Permanently delete all ${fair.candidate_count} candidate(s) from "${fair.fair_name}" (${fmtDate(fair.fair_date)})? This can't be undone.`)) return;
    setArchivingId(fair.id);
    try {
      const res = await api.archiveFair(fair.id);
      showToast(`Archived ${res.archived} candidate(s) from ${fair.fair_name}`);
      loadFairSettings();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setArchivingId(null);
    }
  }

  // "Which fair is active" only has one right answer when fairSettings is
  // scoped to a single Center — on the Nav switcher's "All centers" view with
  // 2+ Centers in existence, multiple fairs can legitimately be active at
  // once (fair_cycle_isolation_plan.md Phase 0's whole point), so Start/End
  // job fair is hidden until a specific Center is picked, rather than acting
  // on an arbitrary "first active fair found" row.
  const canManageFair = Boolean(selectedCenterId) || centers.length <= 1;
  const activeFair = fairSettings && fairSettings.find((f) => f.is_active);
  const archivableFairs = fairSettings ? fairSettings.filter((f) => !f.is_active && f.candidate_count > 0) : [];

  return (
    <div>
      <div className="sec-label" style={{ marginBottom: 10 }}>Job fair</div>
      {!canManageFair && (
        <p className="save-note" style={{ textAlign: 'left' }}>Select a center above to manage its job fair.</p>
      )}
      {canManageFair && (
        activeFair ? (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="checkin-status in">Active — {fmtDate(activeFair.fair_date)}</span>
            <button className="btn ghost" style={{ width: 'auto', padding: '10px 14px' }} disabled={endingFair} onClick={endFair}>
              {endingFair ? 'Ending…' : 'End job fair'}
            </button>
          </div>
        ) : (
          <form onSubmit={startFair} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
            <div className="field" style={{ maxWidth: 180, marginBottom: 0 }}>
              <label>Fair date</label>
              <input type="date" value={fairDate} onChange={(e) => setFairDate(e.target.value)} />
            </div>
            {!selectedCenterId && centers.length > 1 && (
              <div className="field" style={{ maxWidth: 160, marginBottom: 0 }}>
                <label>Center</label>
                <select value={fairCenterId} onChange={(e) => setFairCenterId(e.target.value)} required>
                  <option value="" disabled>Select…</option>
                  {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}
            <button className="btn" style={{ width: 'auto', padding: '10px 14px' }} type="submit" disabled={startingFair}>
              {startingFair ? 'Starting…' : 'Start job fair'}
            </button>
          </form>
        )
      )}

      {archivableFairs.length > 0 && (
        <>
          <div className="sec-label" style={{ marginTop: 24, marginBottom: 10 }}>Past fairs — pending cleanup</div>
          <div className="table-wrap scroll-5">
            <table className="data-table">
              <thead>
                <tr><th>Fair</th><th>Date</th><th>Candidates</th><th></th></tr>
              </thead>
              <tbody>
                {archivableFairs.map((f) => (
                  <tr key={f.id}>
                    <td>{f.fair_name}</td>
                    <td className="mono">{fmtDate(f.fair_date)}</td>
                    <td className="mono">{f.candidate_count}</td>
                    <td>
                      <button
                        className="btn ghost"
                        style={{ width: 'auto', padding: '6px 12px', color: 'var(--st-rejected)' }}
                        disabled={archivingId === f.id}
                        onClick={() => archiveFair(f)}
                      >
                        {archivingId === f.id ? 'Archiving…' : 'Archive'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {toast && <div className={`toast${toast.isErr ? ' err' : ''}`}>{toast.text}</div>}
    </div>
  );
}
