import { useState, useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import { SocketProvider } from './SocketContext';
import Login from './Login';
import DeskTablet from './DeskTablet';
import UserAdmin from './UserAdmin';
import CompanyManagement from './CompanyManagement';
import Reports from './Reports';
import { api } from '../api';

// prototype/integrity-test-report.md's NAV_LINKS pattern, carried forward:
// nav visibility and route access are driven by the same single list instead
// of two things that can drift apart.
const NAV_LINKS = [
  { to: '/staff/desk', label: 'Desk', roles: ['admin', 'floor_manager', 'company_hr'] },
  { to: '/staff/users', label: 'Staff', roles: ['admin'] },
  { to: '/staff/companies', label: 'Companies', roles: ['admin'] },
  { to: '/staff/reports', label: 'Reports', roles: ['admin'] },
];

function Gate({ roles, children }) {
  const { user, status } = useAuth();
  if (status !== 'ready') return <div className="s-shell"><div className="s-body">Checking session…</div></div>;
  if (!user) return <Navigate to="/staff/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/staff/desk" replace />;
  return children;
}

function DeskPicker() {
  const [companies, setCompanies] = useState(null);
  const [companyId, setCompanyId] = useState('');
  const [deskId, setDeskId] = useState('1');
  const navigate = useNavigate();

  useEffect(() => { api.getCompanies().then(setCompanies).catch(() => setCompanies([])); }, []);

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
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} required>
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
  const navigate = useNavigate();
  async function doLogout() {
    await logout();
    navigate('/staff/login');
  }
  return (
    <div className="s-nav">
      <span className="brand">SDC JOB FAIR · STAFF</span>
      {NAV_LINKS.filter((l) => l.roles.includes(user.role)).map((l) => (
        <a key={l.to} href={l.to} onClick={(e) => { e.preventDefault(); navigate(l.to); }}>{l.label}</a>
      ))}
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
                <Route path="desk" element={<DeskPicker />} />
                <Route path="desk/:companyId/:deskId" element={<DeskTablet />} />
                <Route path="users" element={<Gate roles={['admin']}><UserAdmin /></Gate>} />
                <Route path="companies" element={<Gate roles={['admin']}><CompanyManagement /></Gate>} />
                <Route path="reports" element={<Gate roles={['admin']}><Reports /></Gate>} />
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
      <SocketProvider>
        <Shell />
      </SocketProvider>
    </AuthProvider>
  );
}
