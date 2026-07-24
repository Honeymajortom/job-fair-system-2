import { useEffect, useRef, useState } from 'react';

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
//
// Pause here is purely a display freeze (no backend deadline depends on this
// clock, unlike CountdownRing's) — pausedOffsetMs accumulates real time spent
// paused so resuming continues from where it froze instead of jumping
// forward by however long the pause lasted.
export default function InterviewTimer({ startedAt, paused }) {
  const [now, setNow] = useState(Date.now());
  const [pausedOffsetMs, setPausedOffsetMs] = useState(0);
  const pauseStartRef = useRef(null);

  useEffect(() => {
    if (paused) {
      if (pauseStartRef.current == null) pauseStartRef.current = Date.now();
      return;
    }
    if (pauseStartRef.current != null) {
      setPausedOffsetMs((v) => v + (Date.now() - pauseStartRef.current));
      pauseStartRef.current = null;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [paused]);

  const elapsed = startedAt ? now - new Date(startedAt).getTime() - pausedOffsetMs : 0;

  return (
    <div className="ring-wrap">
      <div className="ring done">
        <div className="face"><span className="mm-ss">{format(elapsed)}</span></div>
      </div>
      <div className="ring-label">{paused ? 'Interview paused' : 'Interview in progress'}</div>
    </div>
  );
}
