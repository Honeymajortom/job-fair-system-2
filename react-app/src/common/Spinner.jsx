import { useEffect, useState } from 'react';

// Loading state that upgrades itself into the "slow internet" state after a
// few seconds instead of leaving a spinner running silently forever — a
// fetch that's still pending at 5s is either a slow connection or a stalled
// request, and either way the user deserves an acknowledgment, not just
// continued spinning.
export default function Spinner({ label = 'Loading…', slowLabel = 'Still working — this is taking longer than usual…', slowAfterMs = 5000 }) {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), slowAfterMs);
    return () => clearTimeout(t);
  }, [slowAfterMs]);

  return (
    <div className="loading-row">
      <span className="spinner" />
      <span>{slow ? slowLabel : label}</span>
    </div>
  );
}
