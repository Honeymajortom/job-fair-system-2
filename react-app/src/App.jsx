import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import QRLanding from './public/QRLanding.jsx';
import CompanyTiles from './public/CompanyTiles.jsx';
import DetailsForm from './public/DetailsForm.jsx';
import LiveSchedule from './public/LiveSchedule.jsx';

// Public routes load eagerly (the morning-spike path must be instant);
// the staff chunk only downloads after someone heads to /login (v3.0 §10).
const StaffApp = lazy(() => import('./staff/StaffApp.jsx'));

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<QRLanding />} />
      <Route path="/qr" element={<QRLanding />} />
      <Route path="/register" element={<CompanyTiles />} />
      <Route path="/register/details" element={<DetailsForm />} />
      <Route path="/qr/schedule/:token" element={<LiveSchedule />} />
      <Route path="/schedule/:token" element={<LiveSchedule />} />
      <Route
        path="/*"
        element={
          <Suspense fallback={<div style={{ padding: 40, textAlign: 'center', fontFamily: 'var(--mono)', color: 'var(--ink-60)' }}>Loading…</div>}>
            <StaffApp />
          </Suspense>
        }
      />
    </Routes>
  );
}
