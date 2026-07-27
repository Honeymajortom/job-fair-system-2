import { useEffect, useState } from 'react';

// navigator.onLine + the online/offline events — no polling, no fetch probe.
// It only detects "this device has no network interface up," not "our API
// is reachable" (a captive portal or a downed backend both read as "online"
// here) — that's the tradeoff for a zero-cost signal; per-screen fetch
// failures are still handled by each screen's own error state.
export default function useOnlineStatus() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    function goOnline() { setOnline(true); }
    function goOffline() { setOnline(false); }
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}
