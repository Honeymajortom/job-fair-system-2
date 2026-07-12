import { useEffect, useState } from 'react';

function format(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

// CountdownRing's counterpart once the interview has actually started — no
// deadline to shrink toward (an interview has no fixed length), so this just
// counts up against interview_started_at. Reuses .ring.done (solid
// --st-selected fill) rather than inventing a new ring style.
export default function InterviewTimer({ startedAt }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsed = startedAt ? now - new Date(startedAt).getTime() : 0;

  return (
    <div className="ring-wrap">
      <div className="ring done">
        <div className="face"><span className="mm-ss">{format(elapsed)}</span></div>
      </div>
      <div className="ring-label">Interview in progress</div>
    </div>
  );
}
