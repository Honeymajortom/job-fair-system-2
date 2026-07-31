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
  const { selectedCenterId, effectiveCenterId } = useCenter();
  const [fairSettings, setFairSettings] = useState(null);
  const [fairDate, setFairDate] = useState('');
  // candidate_and_desk_improvements_plan.md §A: max_companies_per_candidate
  // already existed on fair_settings (readable/writable via this same
  // POST/PUT pair) but had no admin-facing form field anywhere — this is that
  // field, both at fair-creation time and as an inline edit once a fair is
  // active.
  const [maxCompanies, setMaxCompanies] = useState(3);
  const [startingFair, setStartingFair] = useState(false);
  const [endingFair, setEndingFair] = useState(false);
  const [savingCap, setSavingCap] = useState(false);
  const [capDraft, setCapDraft] = useState('');
  const [archivingId, setArchivingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
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

  // Both checks below are real popups (window.alert), not the quiet toast
  // the rest of this screen uses — starting a fair for the wrong (or no)
  // Center/date is the one mistake here worth a hard stop in front of the
  // admin's face, not something easy to miss in a corner-of-the-screen
  // toast. In normal use neither should fire — the form itself is hidden
  // until a Center is selected (see canManageFair below) and the date input
  // is required — these are a defensive backstop, not the primary guard.
  async function startFair(e) {
    e.preventDefault();
    if (!fairDate) { window.alert('Pick a fair date before starting the job fair.'); return; }
    if (!selectedCenterId) { window.alert('Select a Center (Settings → Centers) before starting a job fair.'); return; }
    // STAFF_INCONSISTENCY_REPORT.md S4: this used to skip saveCap()'s
    // validation entirely — clearing the field made maxCompanies read as 0,
    // which PUT /fair-settings/:id's `|| null` coercion (fair.js) silently
    // treats as "not provided" and keeps whatever the row already had,
    // rather than erroring. Same hard-stop style (window.alert) as the two
    // checks above, not saveCap()'s toast — this function's own convention.
    const n = Number(maxCompanies);
    if (!Number.isInteger(n) || n <= 0) {
      window.alert('Max companies per candidate must be a whole number greater than 0.');
      return;
    }
    setStartingFair(true);
    try {
      const activated = await api.activateFair({ fair_date: fairDate, center_id: Number(selectedCenterId) });
      // /fair-settings/activate itself only takes fair_date/fair_name/center_id
      // — max_companies_per_candidate is set as a follow-up PUT against the
      // row it just created/reactivated, same route the inline edit below uses.
      if (n !== 3) {
        await api.updateFairSettings(activated.id, { max_companies_per_candidate: n });
      }
      showToast(`Job fair started for ${fmtDate(fairDate)}`);
      loadFairSettings();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setStartingFair(false);
    }
  }

  async function saveCap() {
    if (!activeFair) return;
    const n = Number(capDraft);
    if (!Number.isInteger(n) || n <= 0) {
      showToast('Enter a whole number greater than 0', true);
      return;
    }
    setSavingCap(true);
    try {
      await api.updateFairSettings(activeFair.id, { max_companies_per_candidate: n });
      showToast(`Max companies per candidate set to ${n}`);
      loadFairSettings();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setSavingCap(false);
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

  // Full list, delete option — separate from archivableFairs above (which is
  // just the "still has candidates to purge" subset). DELETE /fair-settings/:id
  // itself refuses an active fair or one with candidates still attached (same
  // guards mirrored client-side below, just for a clear disabled-button
  // reason instead of a round trip that's always going to 409).
  async function deleteFair(fair) {
    if (!window.confirm(`Delete "${fair.fair_name}" (${fmtDate(fair.fair_date)})? This can't be undone.`)) return;
    setDeletingId(fair.id);
    try {
      await api.deleteFairSettings(fair.id);
      showToast(`Deleted ${fair.fair_name}`);
      loadFairSettings();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setDeletingId(null);
    }
  }

  // Start/End job fair requires an explicit Center selection (Settings →
  // Centers) — always, even when only one Center exists. This used to
  // auto-pick the sole Center so the form worked without ever visiting the
  // Centers tab; that silently meant "unless a Center is selected" never
  // actually held, since a single-Center setup could always start a fair
  // with nothing selected. "Which fair is active" also only has one right
  // answer once fairSettings is scoped to a single Center anyway — on the
  // "All centers" view with 2+ Centers, multiple fairs can legitimately be
  // active at once (fair_cycle_isolation_plan.md Phase 0's whole point), so
  // this doubles as the guard against acting on an arbitrary "first active
  // fair found" row.
  const canManageFair = Boolean(selectedCenterId);
  const activeFair = fairSettings && fairSettings.find((f) => f.is_active);
  const archivableFairs = fairSettings ? fairSettings.filter((f) => !f.is_active && f.candidate_count > 0) : [];

  // Keeps the inline cap editor's draft in sync with whatever's actually
  // stored — re-syncs whenever a different fair becomes active or the value
  // itself changes server-side (e.g. after saveCap's own reload).
  useEffect(() => {
    if (activeFair) setCapDraft(String(activeFair.max_companies_per_candidate));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFair?.id, activeFair?.max_companies_per_candidate]);

  return (
    <div>
      <div className="sec-label" style={{ marginBottom: 10 }}>Job fair</div>
      {!canManageFair && (
        <p className="save-note" style={{ textAlign: 'left' }}>Select a Center under Settings → Centers before managing a job fair.</p>
      )}
      {canManageFair && (
        activeFair ? (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="checkin-status in">Active — {fmtDate(activeFair.fair_date)}</span>
            <button className="btn ghost" style={{ width: 'auto', padding: '10px 14px' }} disabled={endingFair} onClick={endFair}>
              {endingFair ? 'Ending…' : 'End job fair'}
            </button>
            <div className="field" style={{ maxWidth: 160, marginBottom: 0 }}>
              <label>Max companies per candidate</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="number"
                  min={1}
                  value={capDraft}
                  onChange={(e) => setCapDraft(e.target.value)}
                  style={{ width: 70 }}
                />
                <button
                  className="btn ghost"
                  style={{ width: 'auto', padding: '10px 14px' }}
                  disabled={savingCap || Number(capDraft) === activeFair.max_companies_per_candidate}
                  onClick={saveCap}
                >
                  {savingCap ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <form onSubmit={startFair} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
            <div className="field" style={{ maxWidth: 180, marginBottom: 0 }}>
              <label>Fair date</label>
              <input type="date" value={fairDate} onChange={(e) => setFairDate(e.target.value)} />
            </div>
            <div className="field" style={{ maxWidth: 160, marginBottom: 0 }}>
              <label>Max companies per candidate</label>
              <input type="number" min={1} value={maxCompanies} onChange={(e) => setMaxCompanies(e.target.value)} />
            </div>
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

      {fairSettings && fairSettings.length > 0 && (
        <>
          <div className="sec-label" style={{ marginTop: 24, marginBottom: 10 }}>All fairs</div>
          <div className="table-wrap scroll-5">
            <table className="data-table">
              <thead>
                <tr><th>Fair</th><th>Date</th><th>Status</th><th>Candidates</th><th></th></tr>
              </thead>
              <tbody>
                {fairSettings.map((f) => {
                  const blockedReason = f.is_active
                    ? 'End this job fair before deleting it'
                    : f.candidate_count > 0
                      ? 'Archive this fair (purge its candidates) before deleting it'
                      : null;
                  return (
                    <tr key={f.id}>
                      <td>{f.fair_name}</td>
                      <td className="mono">{fmtDate(f.fair_date)}</td>
                      <td>
                        <span className={`checkin-status ${f.is_active ? 'in' : 'out'}`} style={{ marginTop: 0 }}>
                          {f.is_active ? 'Active' : 'Ended'}
                        </span>
                      </td>
                      <td className="mono">{f.candidate_count}</td>
                      <td>
                        <button
                          className="btn ghost"
                          style={{ width: 'auto', padding: '6px 12px', color: 'var(--st-rejected)' }}
                          disabled={Boolean(blockedReason) || deletingId === f.id}
                          title={blockedReason || undefined}
                          onClick={() => deleteFair(f)}
                        >
                          {deletingId === f.id ? 'Deleting…' : 'Delete'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {toast && <div className={`toast${toast.isErr ? ' err' : ''}`}>{toast.text}</div>}
    </div>
  );
}
