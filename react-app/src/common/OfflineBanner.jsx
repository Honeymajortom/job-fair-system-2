import useOnlineStatus from './useOnlineStatus';

// Drop-in anywhere — renders nothing while online, so it's safe to mount
// unconditionally at the top of any screen.
export default function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;
  return <div className="offline-banner">⚠ No internet connection — showing the last data we had</div>;
}
