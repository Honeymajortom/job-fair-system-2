import { useState, useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import { CenterProvider, useCenter } from './CenterContext';
import { SocketProvider } from './SocketContext';
import Login from './Login';
import DeskTablet from './DeskTablet';
import UserAdmin from './UserAdmin';
import CompanyManagement from './CompanyManagement';
import Settings from './Settings';
import FloorMonitor from './FloorMonitor';
import GateCheckIn from './GateCheckIn';
import PermissionDenied from '../common/PermissionDenied';
import { api } from '../api';

// prototype/integrity-test-report.md's NAV_LINKS pattern, carried forward:
// nav visibility and route access are driven by the same single list instead
// of two things that can drift apart.
// settings_tab_plan.md (2026-07-28): Reports and Insights, plus Fair Creation
// (moved out of FloorMonitor.jsx) and Center management (new), are now
// consolidated under one Settings tab instead of separate top-level entries.
const NAV_LINKS = [
  { to: '/staff/floor', label: 'Floor', roles: ['admin', 'floor_manager'] },
  { to: '/staff/gate', label: 'Gate', roles: ['admin', 'registration_staff'] },
  { to: '/staff/desk', label: 'Desk', roles: ['admin', 'floor_manager', 'company_hr'] },
  // Widened to registration_staff 2026-07-25 (was admin-only) — the tab now
  // also holds the Candidates section (manual registration + company
  // reassignment), which registration_staff needs; the staff-account roster
  // itself stays gated internally to admin (see UserAdmin.jsx).
  { to: '/staff/users', label: 'Users', roles: ['admin', 'registration_staff'] },
  { to: '/staff/companies', label: 'Companies', roles: ['admin'] },
  { to: '/staff/settings', label: 'Settings', roles: ['admin'] },
];

// STAFF_INCONSISTENCY_REPORT.md S10: a role mismatch used to silently
// redirect to /staff/desk with zero explanation — built for exactly this,
// common/PermissionDenied.jsx sat unused since the 2026-07-26 "Shared UI
// states" pass. Nav already hides tabs the role can't use, so this only
// fires via direct URL/bookmark navigation; staying on the attempted route
// (instead of redirecting away) keeps the Nav bar's other tabs reachable
// without hiding *why* the one they tried didn't load.
function Gate({ roles, children }) {
  const { user, status } = useAuth();
  if (status !== 'ready') return <div className="s-shell"><div className="s-body">Checking session…</div></div>;
  if (!user) return <Navigate to="/staff/login" replace />;
  if (roles && !roles.includes(user.role)) {
    return (
      <div className="s-body">
        <PermissionDenied message={`Your role (${user.role}) doesn't have access to this page.`} />
      </div>
    );
  }
  return children;
}

function DeskPicker() {
  const { user } = useAuth();
  const { effectiveCenterId } = useCenter();
  const [companies, setCompanies] = useState(null);
  const [companyId, setCompanyId] = useState('');
  const [deskId, setDeskId] = useState('1');
  const navigate = useNavigate();

  // company_hr is scoped to exactly one company (requireCompanyScope already
  // enforces this server-side on every desk/queue action) — showing every
  // company in this dropdown just invites picking the wrong one and hitting a
  // 403 the moment they try to call a candidate. admin/floor_manager still see
  // the full list (narrowed to admin's selected Center, if any — fair_cycle_
  // isolation_plan.md Phase 4; floor_manager is always narrowed server-side
  // to their own Center regardless of what's passed here).
  const isCompanyHr = user.role === 'company_hr';

  useEffect(() => {
    api.getCompanies(effectiveCenterId).then((rows) => {
      setCompanies(isCompanyHr ? rows.filter((c) => c.id === user.company_id) : rows);
    }).catch(() => setCompanies([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveCenterId]);

  useEffect(() => {
    if (isCompanyHr && companies && companies.length) setCompanyId(String(companies[0].id));
  }, [isCompanyHr, companies]);

  function go(e) {
    e.preventDefault();
    if (!companyId || !deskId) return;
    navigate(`/staff/desk/${companyId}/${deskId}`);
  }

  return (
    <div className="s-body" style={{ maxWidth: 360 }}>
      <h2 className="screen-title">Desk tablet</h2>
      <form onSubmit={go} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="field">
          <label>Company</label>
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} disabled={isCompanyHr} required>
            <option value="" disabled>Select a company…</option>
            {companies && companies.map((c) => <option key={c.id} value={c.id}>{c.company_name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Desk number</label>
          <input value={deskId} onChange={(e) => setDeskId(e.target.value)} required />
        </div>
        <button className="btn" type="submit">Open desk</button>
      </form>
    </div>
  );
}

function Nav() {
  const { user, logout } = useAuth();
  const { isAdmin, selectedCenterId, centerName } = useCenter();
  const navigate = useNavigate();
  async function doLogout() {
    await logout();
    navigate('/staff/login');
  }
  // fair_cycle_isolation_plan.md Phase 4 / settings_tab_plan.md follow-up:
  // the Nav used to carry an interactive Center switcher (a <select>) here.
  // It moved to Settings → Centers (SettingsCenters.jsx), which has room for
  // a proper "Viewing" control instead of squeezing a dropdown into the nav
  // bar — the nav now just shows which Center is currently in effect,
  // read-only, same as it already did for non-admin roles.
  const centerLabel = isAdmin
    ? (selectedCenterId ? centerName(selectedCenterId) : 'All centers')
    : (user.center_id != null ? centerName(user.center_id) : null);
  return (
    <div className="s-nav">
      <span className="brand">SDC JOB FAIR · STAFF</span>
      {NAV_LINKS.filter((l) => l.roles.includes(user.role)).map((l) => (
        <a key={l.to} href={l.to} onClick={(e) => { e.preventDefault(); navigate(l.to); }}>{l.label}</a>
      ))}
      {centerLabel && <span className="save-note" style={{ marginTop: 0, marginLeft: 10 }}>Center: {centerLabel || '—'}</span>}
      <span className={`role-chip ${user.role}`}>{user.role}</span>
      <button className="btn ghost" style={{ width: 'auto', padding: '6px 12px', marginLeft: 10 }} onClick={doLogout}>
        Log out
      </button>
    </div>
  );
}

function Shell() {
  const { user, status } = useAuth();
  return (
    <Routes>
      <Route path="login" element={<Login />} />
      <Route
        path="*"
        element={
          <Gate>
            <div className="s-shell">
              {status === 'ready' && user && <Nav />}
              <Routes>
                <Route path="floor" element={<Gate roles={['admin', 'floor_manager']}><FloorMonitor /></Gate>} />
                <Route path="gate" element={<Gate roles={['admin', 'registration_staff']}><GateCheckIn /></Gate>} />
                <Route path="desk" element={<DeskPicker />} />
                <Route path="desk/:companyId/:deskId" element={<DeskTablet />} />
                <Route path="users" element={<Gate roles={['admin', 'registration_staff']}><UserAdmin /></Gate>} />
                <Route path="companies" element={<Gate roles={['admin']}><CompanyManagement /></Gate>} />
                <Route path="settings/*" element={<Gate roles={['admin']}><Settings /></Gate>} />
                <Route path="*" element={<Navigate to="/staff/desk" replace />} />
              </Routes>
            </div>
          </Gate>
        }
      />
    </Routes>
  );
}

export default function StaffApp() {
  return (
    <AuthProvider>
      <CenterProvider>
        <SocketProvider>
          <Shell />
        </SocketProvider>
      </CenterProvider>
    </AuthProvider>
  );
}
