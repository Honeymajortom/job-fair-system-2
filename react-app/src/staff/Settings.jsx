import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import Reports from './Reports';
import Insights from './Insights';
import SettingsCenters from './SettingsCenters';
import SettingsFair from './SettingsFair';

// settings_tab_plan.md — Centers, Fair, Reports and Insights consolidated
// under one admin-only tab, each its own sub-route (deep-linkable/back-button
// friendly) rather than one long scroll. Sub-nav mirrors StaffApp.jsx's own
// NAV_LINKS pattern one level down: a plain list driving both the visible
// strip and which sub-route is active.
const SETTINGS_TABS = [
  { to: 'centers', label: 'Centers' },
  { to: 'fair', label: 'Fair' },
  { to: 'reports', label: 'Reports' },
  { to: 'insights', label: 'Insights' },
];

export default function Settings() {
  const navigate = useNavigate();
  const location = useLocation();
  const activeTab = location.pathname.split('/').pop();

  return (
    <div className="s-body">
      <h2 className="screen-title">Settings</h2>
      <div className="settings-subnav">
        {SETTINGS_TABS.map((t) => (
          <a
            key={t.to}
            href={`/staff/settings/${t.to}`}
            className={activeTab === t.to ? 'active' : ''}
            onClick={(e) => { e.preventDefault(); navigate(`/staff/settings/${t.to}`); }}
          >
            {t.label}
          </a>
        ))}
      </div>

      <Routes>
        <Route index element={<Navigate to="/staff/settings/centers" replace />} />
        <Route path="centers" element={<SettingsCenters />} />
        <Route path="fair" element={<SettingsFair />} />
        <Route path="reports" element={<Reports />} />
        <Route path="insights" element={<Insights />} />
        <Route path="*" element={<Navigate to="/staff/settings/centers" replace />} />
      </Routes>
    </div>
  );
}
