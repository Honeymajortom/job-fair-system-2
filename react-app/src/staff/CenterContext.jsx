import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useAuth } from './AuthContext';

const CenterContext = createContext(null);

const STORAGE_KEY = 'staff_selected_center_id';

// fair_cycle_isolation_plan.md Phase 4 — the Center switcher's state. Admin
// can freely narrow/widen which Center every scoped screen reads (persisted
// across reloads so the switcher doesn't silently reset to "All centers");
// every other role is unconditionally pinned to user.center_id — there's
// nothing to switch, the server already enforces this regardless of what the
// client sends, this context just mirrors it for display.
export function CenterProvider({ children }) {
  const { user } = useAuth();
  const [centers, setCenters] = useState([]);
  const [selectedCenterId, setSelectedCenterIdState] = useState(() => {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    return saved ? Number(saved) : '';
  });

  const loadCenters = useCallback(() => {
    api.getCenters().then(setCenters).catch(() => {});
  }, []);

  useEffect(() => { if (user) loadCenters(); }, [user, loadCenters]);

  const isAdmin = user && user.role === 'admin';

  const setSelectedCenterId = useCallback((id) => {
    if (!isAdmin) return; // non-admin has nothing to switch — server ignores it anyway
    setSelectedCenterIdState(id);
    if (id) sessionStorage.setItem(STORAGE_KEY, String(id));
    else sessionStorage.removeItem(STORAGE_KEY);
  }, [isAdmin]);

  const addCenter = useCallback(async (payload) => {
    const created = await api.createCenter(payload);
    loadCenters();
    setSelectedCenterId(created.id);
    return created;
  }, [loadCenters, setSelectedCenterId]);

  // The effective centerId every scoped api.js call should pass: admin's own
  // switcher choice (or '' / undefined for "all centers"), everyone else's
  // pinned center — passing it explicitly from the client is a convenience
  // only, since the server ignores it for non-admin roles anyway.
  const effectiveCenterId = isAdmin ? (selectedCenterId || undefined) : (user && user.center_id) || undefined;

  const centerName = useCallback((id) => {
    const c = centers.find((c) => c.id === id);
    return c ? c.name : null;
  }, [centers]);

  const value = useMemo(() => ({
    centers, isAdmin, selectedCenterId, setSelectedCenterId, addCenter, effectiveCenterId, centerName, loadCenters,
  }), [centers, isAdmin, selectedCenterId, setSelectedCenterId, addCenter, effectiveCenterId, centerName, loadCenters]);

  return <CenterContext.Provider value={value}>{children}</CenterContext.Provider>;
}

export function useCenter() {
  return useContext(CenterContext);
}
