import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AnimatePresence, m } from 'framer-motion';
import QRCode from 'qrcode';
import { api } from '../api';
import RungBadge, { cardModifier } from './RungBadge';

const POLL_MS = 5000; // server caches the route for 15s, so most polls are cache hits
const QR_ELIGIBLE_RUNGS = ['gate', 'staging', 'desk_call'];
const DONE_STATUSES = ['Selected', 'Rejected', 'Shortlisted', 'Hold', 'No_Show']; // mirrors express-app/lib/pingLadder.js

// Card-body copy for a settled outcome (rung 'done') — a bare "position 0"
// or generic "DONE" doesn't tell the candidate whether that was good news.
const OUTCOME_NOTES = {
  Selected: "🎉 Congratulations — you've been selected!",
  Shortlisted: "You've been shortlisted — you'll hear back soon.",
  Hold: 'Your result is on hold — check back later or ask at the desk.',
  Rejected: 'Not selected this time. Thanks for interviewing with us!',
  No_Show: "You were marked as a no-show for this company's interview.",
};
// Demo values in new_architecture_uiux_spec.html (§01 ping-ladder replay: pos
// 47->w64%, 24->w33%, 13->w18%, 5->w7%, 0->w0) imply track width ~= position
// * 1.38, capped at 100 — there's no "total queue length" the API exposes to
// compute an exact fraction against, so this reproduces the spec's demo ratio
// as a reasonable approximation rather than a precise fraction.
function trackWidth(position) {
  if (position == null || position <= 0) return 0;
  return Math.min(100, position * 1.38);
}

function PosCard({ slot }) {
  const isWaitlisted = slot.rung === undefined;
  const rung = isWaitlisted ? 'waitlisted' : slot.rung;
  const isCalled = rung === 'desk_call';
  const isInInterview = rung === 'in_interview';
  const isDone = rung === 'done';
  const modifier = isWaitlisted ? '' : cardModifier(rung, slot.status);
  const prevRung = useRef(rung);
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    if (prevRung.current !== 'warm' && rung === 'warm') {
      setPulsing(true);
      const t = setTimeout(() => setPulsing(false), 400);
      return () => clearTimeout(t);
    }
    prevRung.current = rung;
  }, [rung]);

  return (
    <m.div
      className={`pos-card${modifier ? ` ${modifier}` : ''}${isCalled ? ' desk-call' : ''}`}
      animate={pulsing ? { scale: [1, 1.02, 1] } : { scale: 1 }}
      transition={{ duration: 0.4 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div className="co">{slot.company}</div>
          {/* Every tile shows where that company is set up, not just the
              moment they're called — a candidate picking up interviews for
              multiple companies needs this ahead of time too. */}
          {slot.location && <div className="loc-note">📍 {slot.location}</div>}
        </div>
        <RungBadge rung={rung} status={slot.status} />
      </div>
      {isWaitlisted ? (
        <p className="save-note" style={{ textAlign: 'left', marginTop: 10 }}>
          You're on the waitlist — you'll move up if a spot opens.
        </p>
      ) : isCalled ? (
        // Dispatched (position 0 / eta 0) means the desk is asking for this
        // candidate right now — a bare "0" position number reads as noise at
        // exactly the moment it matters most, so this replaces the numeric
        // display with an explicit call to action instead.
        <p className="desk-call-note">🔔 Your turn — go to {slot.location || 'the desk'} now</p>
      ) : isInInterview ? (
        // interview_started_at is set (confirm-arrival) but status is still
        // 'Dispatched' — the candidate is already at the desk, so the blinking
        // "come now" call would be actively wrong here.
        <p className="desk-call-note calm">🎤 Interview in progress at {slot.location || 'the desk'}</p>
      ) : isDone ? (
        <p className="desk-call-note calm">{OUTCOME_NOTES[slot.status] || 'Interview completed.'}</p>
      ) : (
        <>
          <div className="row">
            <div>
              <AnimatePresence mode="popLayout">
                <m.div
                  key={slot.position}
                  className="num"
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                >
                  {slot.position}
                </m.div>
              </AnimatePresence>
              <div className="num-label">Position</div>
            </div>
            {slot.eta_minutes != null && <div className="eta">~{slot.eta_minutes} min</div>}
          </div>
          <div className="pos-track"><i style={{ width: `${trackWidth(slot.position)}%` }} /></div>
        </>
      )}
    </m.div>
  );
}

// new_architecture_uiux_spec.html §01 step 4 — replaces the old ScheduleCard/
// LiveSchedule.jsx's fixed-time-list role entirely. Candidates never get a
// socket (lib/io.js is staff-only) — this is the poll-not-push design
// new_architecture.md §6.6 calls for, the 15s server cache absorbing most of
// the traffic from everyone's ~5s client poll.
export default function LivePosition() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState(null);

  useEffect(() => {
    // Once a candidate lands here, back must not be able to reopen the
    // registration form (they've already joined the queue). Refresh is the
    // only way to re-sync; back is trapped in place instead of navigated away.
    window.history.pushState(null, '', window.location.href);
    const onPopState = () => window.history.pushState(null, '', window.location.href);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const result = await api.qrSchedule(token);
        if (!cancelled) { setData(result); setError(null); }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [token]);

  // Blink the tab title + vibrate (mobile) the moment a desk actually calls
  // this candidate — the in-card blink (index.css .desk-call) only helps if
  // they're already looking at the tab; this is for the case where they've
  // switched apps or the phone is face-down. wasCalledRef gates the vibrate
  // to fire once per call (not every 5s poll while still desk_call).
  const wasCalledRef = useRef(false);
  // Previous status per company (keyed by company name — a candidate tracks
  // at most 3 distinct companies, so name collisions aren't a concern here).
  // Used to fire the outcome notification exactly once, on the transition
  // into a result, rather than on every 5s poll while it stays settled.
  const prevStatusesRef = useRef({});
  useEffect(() => {
    const originalTitle = document.title;
    return () => { document.title = originalTitle; };
  }, []);
  useEffect(() => {
    if (!data) return undefined;
    const isCalled = data.slots.some((s) => s.rung === 'desk_call');
    if (isCalled && !wasCalledRef.current && navigator.vibrate) {
      navigator.vibrate([200, 100, 200, 100, 200]);
    }
    wasCalledRef.current = isCalled;

    // Outcome notification: a shorter, one-time attention grab (result is
    // already final — no ongoing action needed, unlike desk_call) for any
    // company that just newly landed on Selected/Rejected/Shortlisted/Hold/
    // No_Show since the last poll.
    const justSettled = data.slots.some((s) => {
      const prev = prevStatusesRef.current[s.company];
      return DONE_STATUSES.includes(s.status) && prev !== s.status && prev !== undefined;
    });
    prevStatusesRef.current = Object.fromEntries(data.slots.map((s) => [s.company, s.status]));

    let outcomeTitleTimer;
    if (justSettled) {
      if (navigator.vibrate) navigator.vibrate([150, 80, 150]);
      const settledTitle = document.title;
      let flashes = 0;
      outcomeTitleTimer = setInterval(() => {
        document.title = flashes % 2 === 0 ? '🔔 Result posted' : settledTitle;
        flashes += 1;
        if (flashes >= 6) { clearInterval(outcomeTitleTimer); document.title = settledTitle; }
      }, 700);
    }

    if (!isCalled) return () => clearInterval(outcomeTitleTimer);

    const originalTitle = document.title;
    let on = false;
    document.title = '🔔 GO TO THE DESK NOW';
    const id = setInterval(() => {
      on = !on;
      document.title = on ? originalTitle : '🔔 GO TO THE DESK NOW';
    }, 1000);
    return () => { clearInterval(id); clearInterval(outcomeTitleTimer); document.title = originalTitle; };
  }, [data]);

  useEffect(() => {
    // The check-in QR payload is never sent by the server on this poll route
    // (red-team finding C1 — token_no is a guessable sequential id, so this
    // endpoint won't echo the HMAC). It's captured once client-side at
    // registration instead (DetailsForm.jsx -> localStorage).
    const qr = data && localStorage.getItem(`checkin_qr_${token}`);
    if (!qr) { setQrDataUrl(null); return; }
    const anyEligible = data.slots.some((s) => QR_ELIGIBLE_RUNGS.includes(s.rung));
    if (!anyEligible) { setQrDataUrl(null); return; }
    QRCode.toDataURL(qr, { margin: 1, width: 168 }).then(setQrDataUrl).catch(() => setQrDataUrl(null));
  }, [data, token]);

  if (error) return <div className="m-shell"><div className="m-body"><div className="error-note">{error}</div></div></div>;
  if (!data) return <div className="m-shell"><div className="m-body"><div className="save-note">Loading your position…</div></div></div>;

  return (
    <div className="m-shell">
      <div className="app-head">
        <div className="fair">{data.name}'s queues</div>
        <div className="token-hero">{data.token}</div>
        <div className="sub" style={{ marginTop: 6 }}>
          <span className="live-tag"><span className="pulse-dot live" />UPDATES EVERY FEW SECONDS</span>
        </div>
      </div>
      <div className="m-body">
        <div className="ladder">
          {data.slots.map((slot, i) => <PosCard key={`${slot.company}-${i}`} slot={slot} />)}
        </div>
        {qrDataUrl && (
          <div className="qr-wrap">
            <img src={qrDataUrl} alt="Check-in QR" width={168} height={168} />
            <div className="save-note">Show this at the gate / desk</div>
          </div>
        )}
      </div>
      <div className="footer-note">This page is the only place you'll see updates — keep it open, or check back.</div>
    </div>
  );
}
