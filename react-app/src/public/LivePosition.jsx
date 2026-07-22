import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AnimatePresence, m } from 'framer-motion';
import QRCode from 'qrcode';
import { api } from '../api';
import RungBadge, { cardModifier } from './RungBadge';
import FeedbackForm from './FeedbackForm';
import SiteCredit from './SiteCredit.jsx';

const POLL_MS = 5000; // server caches the route for 15s, so most polls are cache hits
const QR_ELIGIBLE_RUNGS = ['gate', 'staging', 'desk_call'];
const DONE_STATUSES = ['Selected', 'Rejected', 'Shortlisted', 'Hold', 'No_Show']; // mirrors express-app/lib/pingLadder.js

// Mirrors lib/gateStatus.js's RUNG_RANK (lower = more urgent), extended with
// in_interview/done — gateStatus.js never needs those two since it excludes
// settled bookings up front and doesn't special-case interview-in-progress,
// but a candidate's own multi-company view has to rank *everything* they're
// tracking to find the single most urgent thing across all of them.
const RUNG_RANK = { in_interview: -1, desk_call: 0, staging: 1, gate: 2, warm: 3, far: 4, done: 5 };

// A candidate tracking 3 companies is physically in one place — this reduces
// their bookings to the single most-urgent one, the same way gateStatus.js
// does fair-wide, so the top-of-page banner can tell them "wait" or "go"
// without them cross-referencing 3 separate cards themselves. Returns the
// whole slot, not just the rung — the banner needs its `floor_number` too, to
// match against the right per-floor waiting room.
function mostUrgentSlot(slots) {
  let best = null;
  for (const s of slots) {
    if (s.rung === undefined) continue; // waitlisted — never entered the live queue
    if (best === null || RUNG_RANK[s.rung] < RUNG_RANK[best.rung]) best = s;
  }
  return best;
}

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

// location is free text ("Hall A Desk 5"); floor_number is the plain integer
// companies.js added alongside it — shown together, floor first, since it's
// the more useful signal for wayfinding at a glance across multiple halls.
function describeLocation(slot) {
  const floor = slot.floor_number != null ? `Floor ${slot.floor_number}` : null;
  return [floor, slot.location].filter(Boolean).join(' · ') || null;
}

// Tells the candidate whether to be in the waiting room right now, or that
// they've earned their way past it — the direct answer to "should I be
// waiting in the room or not," derived from whichever booking is most urgent
// across all of them. Waiting rooms are per-floor now (matched against the
// most-urgent booking's own company floor — the same `floor_number` its card
// already shows), not one fair-wide room: a candidate about to be called by a
// Floor 2 company gets pointed at the Floor 2 room specifically. desk_call/
// in_interview aren't handled here: PosCard's own per-card message ("go to
// the desk now" / "interview in progress") is already more specific than a
// generic banner would be.
function WaitingDirective({ slots, waitingRooms }) {
  const slot = mostUrgentSlot(slots);
  const rung = slot && slot.rung;
  if (rung === 'far' || rung === 'warm' || rung === 'gate') {
    const room = waitingRooms.find((r) => r.floor_number === slot.floor_number);
    const floorLabel = slot.floor_number != null ? `Floor ${slot.floor_number}` : null;
    const loc = [floorLabel, room && room.location].filter(Boolean).join(' · ');
    return (
      <p className="desk-call-note calm" style={{ marginTop: 0, marginBottom: 14 }}>
        🪑 Please wait in the Waiting Room{loc ? ` — ${loc}` : ''}.
      </p>
    );
  }
  if (rung === 'staging') {
    return (
      <p className="desk-call-note calm" style={{ marginTop: 0, marginBottom: 14 }}>
        🚶 You're almost up — stay near the desks, no need to wait in the room anymore.
      </p>
    );
  }
  return null;
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
          {describeLocation(slot) && <div className="loc-note">📍 {describeLocation(slot)}</div>}
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
        <p className="desk-call-note">🔔 Your turn — go to {describeLocation(slot) || 'the desk'} now</p>
      ) : isInInterview ? (
        // interview_started_at is set (confirm-arrival) but status is still
        // 'Dispatched' — the candidate is already at the desk, so the blinking
        // "come now" call would be actively wrong here.
        <p className="desk-call-note calm">🎤 Interview in progress at {describeLocation(slot) || 'the desk'}</p>
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
    // Before check-in, this QR *is* the point of the page — that's what Gate
    // staff scan. After check-in, only show it again once the queue itself
    // needs it (gate/staging/desk_call), matching the previous behavior.
    const shouldShow = data.checked_in ? data.slots.some((s) => QR_ELIGIBLE_RUNGS.includes(s.rung)) : true;
    if (!shouldShow) { setQrDataUrl(null); return; }
    QRCode.toDataURL(qr, { margin: 1, width: 168 }).then(setQrDataUrl).catch(() => setQrDataUrl(null));
  }, [data, token]);

  if (error) return <div className="m-shell"><div className="m-body"><div className="error-note">{error}</div></div></div>;
  if (!data) return <div className="m-shell"><div className="m-body"><div className="save-note">Loading your position…</div></div></div>;

  // Waitlisted bookings (rung undefined — never entered the live queue) never
  // had an interview to settle, so they're excluded here rather than
  // blocking the thank-you screen on a pick that was never actually live.
  const realSlots = data.slots.filter((s) => s.rung !== undefined);
  const allSettled = realSlots.length > 0 && realSlots.every((s) => s.rung === 'done');

  return (
    <div className="m-shell">
      <div className="app-head">
        <div className="fair">{data.name}'s queues</div>
        <div className="token-hero">{data.token}</div>
        <div className="sub" style={{ marginTop: 6 }}>
          <span className="live-tag"><span className="pulse-dot live" />UPDATES EVERY FEW SECONDS</span>
        </div>
        <div className={`checkin-status ${data.checked_in ? 'in' : 'out'}`}>
          {data.checked_in ? '✅ Checked In' : '⚠️ Not Checked In'}
        </div>
      </div>
      <div className="m-body">
        {!data.checked_in ? (
          // Positions/ETAs aren't meaningful to act on until the candidate
          // has physically checked in at the Gate — show the check-in QR
          // (their way in) instead of the queue ladder.
          <>
            <p className="desk-call-note calm" style={{ marginTop: 0 }}>
              {qrDataUrl
                ? 'Head to the entrance Gate and show this QR code to check in.'
                : `Head to the entrance Gate and give staff your token number (${data.token}) to check in.`}
            </p>
            {qrDataUrl && (
              <div className="qr-wrap">
                <img src={qrDataUrl} alt="Check-in QR" width={168} height={168} />
                <div className="save-note">Show this at the Gate to check in</div>
              </div>
            )}
          </>
        ) : allSettled ? (
          // Every booking has a final result — this is the last screen a
          // candidate needs, so it replaces the ladder rather than sitting
          // alongside it.
          <div className="thank-you">
            <div className="thank-you-emoji">🎉</div>
            <div className="thank-you-title">Thank you for your participation!</div>
            <p className="save-note" style={{ marginTop: 6 }}>
              We hope today went well. One last thing before you go:
            </p>
            {data.feedback_submitted ? (
              <p className="desk-call-note calm" style={{ marginTop: 16 }}>✅ Feedback received — thank you!</p>
            ) : (
              <FeedbackForm token={token} onSubmitted={() => setData((d) => ({ ...d, feedback_submitted: true }))} />
            )}
          </div>
        ) : (
          <>
            <WaitingDirective slots={data.slots} waitingRooms={data.waiting_rooms || []} />
            <div className="ladder">
              {data.slots.map((slot, i) => <PosCard key={`${slot.company}-${i}`} slot={slot} />)}
            </div>
            {qrDataUrl && (
              <div className="qr-wrap">
                <img src={qrDataUrl} alt="Check-in QR" width={168} height={168} />
                <div className="save-note">Show this at the gate / desk</div>
              </div>
            )}
          </>
        )}
      </div>
      <div className="footer-note">This page is the only place you'll see updates — keep it open, or check back.</div>
      <div style={{ paddingBottom: 12 }}><SiteCredit /></div>
    </div>
  );
}
