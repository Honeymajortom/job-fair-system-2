import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from '../api';

const AuthContext = createContext(null);

// prototype/integrity-test-report.md's fix, carried forward: only a real 401
// means "not logged in" — any other error (network blip, 500) should retry
// with backoff instead of bouncing the user to the login screen.
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000];

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('checking'); // checking | reconnecting | ready
  const retryIndex = useRef(0);

  const checkSession = useCallback(async () => {
    try {
      const me = await api.me();
      setUser(me);
      setStatus('ready');
      retryIndex.current = 0;
    } catch (err) {
      if (err.status === 401) {
        setUser(null);
        setStatus('ready');
        return;
      }
      setStatus('reconnecting');
      const delay = RETRY_DELAYS[Math.min(retryIndex.current, RETRY_DELAYS.length - 1)];
      retryIndex.current += 1;
      setTimeout(checkSession, delay);
    }
  }, []);

  useEffect(() => { checkSession(); }, [checkSession]);

  async function login(username, password) {
    const me = await api.login(username, password);
    setUser(me);
    return me;
  }

  async function logout() {
    await api.logout().catch(() => {});
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, status, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
