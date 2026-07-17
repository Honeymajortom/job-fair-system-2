import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import QRLanding from './public/QRLanding.jsx';
import CompanyTiles from './public/CompanyTiles.jsx';
import DetailsForm from './public/DetailsForm.jsx';
import RecoverToken from './public/RecoverToken.jsx';
import LivePosition from './public/LivePosition.jsx';
import GateBoard from './public/GateBoard.jsx';

// Public routes load eagerly (the morning-spike path must be instant);
// the staff chunk only downloads once someone heads to /staff (v3.0 §10).
// Staff routes are prefixed under /staff/* (a departure from v1's unprefixed
// catch-all) — with only two staff screens rebuilt so far, an unprefixed
// catch-all would ambiguously swallow future public route additions.
const StaffApp = lazy(() => import('./staff/StaffApp.jsx'));

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<QRLanding />} />
      <Route path="/qr" element={<QRLanding />} />
      <Route path="/register" element={<CompanyTiles />} />
      <Route path="/register/details" element={<DetailsForm />} />
      <Route path="/recover" element={<RecoverToken />} />
      {/* LivePosition replaces the old ScheduleCard/LiveSchedule — same URLs,
          new_architecture_uiux_spec.html §01 step 4's live position page. */}
      <Route path="/qr/schedule/:token" element={<LivePosition />} />
      <Route path="/schedule/:token" element={<LivePosition />} />
      {/* new_architecture_uiux_spec.html §03 — the entrance-monitor board, not a candidate's own device. */}
      <Route path="/gate-board" element={<GateBoard />} />
      <Route
        path="/staff/*"
        element={
          <Suspense fallback={<div style={{ padding: 40, textAlign: 'center', fontFamily: 'var(--mono)', color: 'var(--ink-60)' }}>Loading…</div>}>
            <StaffApp />
          </Suspense>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
