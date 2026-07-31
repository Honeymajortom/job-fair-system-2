import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AnimatePresence, m } from 'framer-motion';
import QRCode from 'qrcode';
import { api } from '../api';
import RungBadge, { cardModifier } from './RungBadge';
import FeedbackForm from './FeedbackForm';
import SelectCompanies from './SelectCompanies';
import SiteCredit from './SiteCredit.jsx';
import OfflineBanner from '../common/OfflineBanner';
import Spinner from '../common/Spinner';
import ErrorBanner from '../common/ErrorBanner';

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

// Card-body copy for a settled outcome (rung 'done'). As of 2026-07-25,
// Selected/Shortlisted/Hold/Rejected deliberately share one neutral message —
// staff tell candidates their actual result manually, so this page never
// reveals which of those four it was (see RungBadge.jsx's matching change).
// No_Show is exempt: it's a real notice about a missed call, not a hidden
// selection outcome, so it keeps its own message.
const OUTCOME_NOTES = {
  Selected: "Interview done — we'll be in touch with your result soon.",
  Shortlisted: "Interview done — we'll be in touch with your result soon.",
  Hold: "Interview done — we'll be in touch with your result soon.",
  Rejected: "Interview done — we'll be in touch with your result soon.",
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
// companies.js added alongside it — shown location first, floor second: a
// company may have either, both, or neither set (pre-existing companies
// often have location but no floor; newer ones the reverse), and location is
// the more specific, human-written signal when both exist.
function describeLocation(slot) {
  const floor = slot.floor_number != null ? `Floor ${slot.floor_number}` : null;
  return [slot.location, floor].filter(Boolean).join(' · ') || null;
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
    const loc = [room && room.location, floorLabel].filter(Boolean).join(' · ');
    return (
      <p className="desk-call-note calm" style={{ marginTop: 0, marginBottom: 14 }}>
        🪑 Please wait in the Waiting Room{loc ? <> — <strong>{loc}</strong></> : ''}.
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

function formatCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

// The same arrival deadline Company HR's desk tablet shows via CountdownRing
// (lib/noShowTimer.js's getArrivalStatus, threaded through the 'desk_call'
// rung) — a plain ticking mm:ss here rather than the desk's visual ring, off
// the identical expiresAt/pausedRemainingMs values so the two can never
// disagree. Ticks locally against the server-provided deadline the same way
// CountdownRing does; the actual no-show reversion stays server-authoritative
// (workers/noShowWorker.js) — this never fires anything itself.
function ArrivalCountdown({ expiresAt, paused, pausedRemainingMs }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (paused || !expiresAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [paused, expiresAt]);

  if (!expiresAt && !paused) return null;
  const remaining = paused ? pausedRemainingMs : new Date(expiresAt).getTime() - now;
  return (
    <p className="save-note" style={{ textAlign: 'left', marginTop: 6 }}>
      ⏱ {paused ? 'Paused — ' : 'Time to arrive: '}<span className="mono">{formatCountdown(remaining)}</span>
    </p>
  );
}

function PosCard({ slot, token }) {
  const isWaitlisted = slot.rung === undefined;
  const rung = isWaitlisted ? 'waitlisted' : slot.rung;
  const isCalled = rung === 'desk_call';
  const isInInterview = rung === 'in_interview';
  const isDone = rung === 'done';
  // A company can be closed (Desk toggle / admin) after a candidate already
  // booked it — their position/ETA would otherwise just sit there frozen
  // forever with no one dispatching. Doesn't apply once the candidate is
  // actually being called or interviewed (an edge-case timing gap, not worth
  // confusing an active call with a "closed" message) or once the result is
  // already in (the outcome note is more relevant at that point).
  const isClosed = slot.is_open === false && !isCalled && !isInInterview && !isDone;
  const modifier = isClosed ? 'rejected' : (isWaitlisted ? '' : cardModifier(rung, slot.status));
  const prevRung = useRef(rung);
  const [pulsing, setPulsing] = useState(false);
  const [acking, setAcking] = useState(false);
  const [acked, setAcked] = useState(false);

  useEffect(() => {
    if (prevRung.current !== 'warm' && rung === 'warm') {
      setPulsing(true);
      const t = setTimeout(() => setPulsing(false), 400);
      return () => clearTimeout(t);
    }
    prevRung.current = rung;
  }, [rung]);

  // Reset once this call is no longer live — a fresh call later (e.g. after
  // a missed-call rank decay puts them back in the queue and they get called
  // again) should show the button again, not stay silently acknowledged.
  useEffect(() => {
    if (rung !== 'desk_call') setAcked(false);
  }, [rung]);

  // Pure notification to Company HR's desk tablet — best-effort, no retry:
  // the queue/no-show-timer state this candidate actually depends on never
  // reads this, so a failed request here just means the tap silently didn't
  // reach the desk, not a broken candidate flow.
  async function acknowledge() {
    setAcking(true);
    try {
      const qr = localStorage.getItem(`checkin_qr_${token}`);
      if (qr) await api.acknowledgeArrival(qr);
      setAcked(true);
    } catch {
      // best-effort — see comment above
    } finally {
      setAcking(false);
    }
  }

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
        <RungBadge rung={rung} status={slot.status} closed={isClosed} />
      </div>
      {isCalled ? (
        // Dispatched (position 0 / eta 0) means the desk is asking for this
        // candidate right now — a bare "0" position number reads as noise at
        // exactly the moment it matters most, so this replaces the numeric
        // display with an explicit call to action instead.
        <>
          <p className="desk-call-note">🔔 Your turn — go to {describeLocation(slot) || 'the desk'} now</p>
          <ArrivalCountdown expiresAt={slot.expiresAt} paused={slot.paused} pausedRemainingMs={slot.pausedRemainingMs} />
          {acked ? (
            <p className="save-note" style={{ marginTop: 8, textAlign: 'left' }}>✅ We told them you're on the way</p>
          ) : (
            <button className="btn ok" style={{ marginTop: 8 }} disabled={acking} onClick={acknowledge}>
              {acking ? 'Letting them know…' : "✅ I'm on my way"}
            </button>
          )}
        </>
      ) : isInInterview ? (
        // interview_started_at is set (confirm-arrival) but status is still
        // 'Dispatched' — the candidate is already at the desk, so the blinking
        // "come now" call would be actively wrong here.
        <p className="desk-call-note calm">🎤 Interview in progress at {describeLocation(slot) || 'the desk'}</p>
      ) : isDone ? (
        <p className="desk-call-note calm">{OUTCOME_NOTES[slot.status] || 'Interview completed.'}</p>
      ) : isClosed ? (
        <p className="desk-call-note calm">🚫 This company has closed — no more interviews are being conducted.</p>
      ) : isWaitlisted ? (
        <p className="save-note" style={{ textAlign: 'left', marginTop: 10 }}>
          You're on the waitlist — you'll move up if a spot opens.
        </p>
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
  const [transferDataUrl, setTransferDataUrl] = useState(null);
  // Set once, right after SelectCompanies submits, if any picked company
  // silently didn't get a booking (closed/de-rostered in the gap between
  // the picker's fetch and submit) — SelectCompanies unmounts immediately
  // once data.slots is non-empty, so this has to live up here to survive
  // that swap instead of disappearing with it.
  const [selectionNotice, setSelectionNotice] = useState(null);

  useEffect(() => {
    // Once a candidate lands here, back must not be able to reopen the
    // registration form (they've already joined the queue). Refresh is the
    // only way to re-sync; back is trapped in place instead of navigated away.
    window.history.pushState(null, '', window.location.href);
    const onPopState = () => window.history.pushState(null, '', window.location.href);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Picks up a check-in QR handed off via ?qr= (see the "Continue on another
  // device" QR below) — lets a candidate registered on a shared/staff device
  // move their session to their own phone, which otherwise never gets the
  // signed token DetailsForm.jsx only ever writes to the registering device's
  // own localStorage. Stripped from the URL immediately so it doesn't linger
  // in browser history. Must run before the transferDataUrl effect below (same
  // [token] deps, declared first — effects run in declaration order) so that
  // effect picks up the freshly-written value on this device's first render.
  useEffect(() => {
    const qrFromUrl = new URLSearchParams(window.location.search).get('qr');
    if (qrFromUrl) {
      localStorage.setItem(`checkin_qr_${token}`, qrFromUrl);
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [token]);

  // QR/link for moving this same signed token to a different device — not a
  // new secret exposure: it's the identical value the check-in/exit QR below
  // already renders for Gate staff to scan, just also offered as a
  // self-transfer. Only rendered while this device actually holds the token.
  useEffect(() => {
    const qr = localStorage.getItem(`checkin_qr_${token}`);
    if (!qr) { setTransferDataUrl(null); return; }
    const transferUrl = `${window.location.origin}/schedule/${token}?qr=${encodeURIComponent(qr)}`;
    QRCode.toDataURL(transferUrl, { margin: 1, width: 140 }).then(setTransferDataUrl).catch(() => setTransferDataUrl(null));
  }, [token]);

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
        document.title = flashes % 2 === 0 ? '🔔 Interview update' : settledTitle;
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
    // staff scan. After check-in, show it again once the queue itself needs
    // it (gate/staging/desk_call) — and, separately, once every booking has
    // settled AND feedback is submitted, this same QR is what gets scanned to
    // *exit* (POST /candidates/exit accepts the identical signed value).
    const realSlots = data.checked_in ? data.slots.filter((s) => s.rung !== undefined) : [];
    const allSettled = realSlots.length > 0 && realSlots.every((s) => s.rung === 'done');
    const shouldShow = !data.checked_in
      || (allSettled ? data.feedback_submitted : data.slots.some((s) => QR_ELIGIBLE_RUNGS.includes(s.rung)));
    if (!shouldShow) { setQrDataUrl(null); return; }
    QRCode.toDataURL(qr, { margin: 1, width: 168 }).then(setQrDataUrl).catch(() => setQrDataUrl(null));
  }, [data, token]);

  if (error) return <div className="m-shell"><OfflineBanner /><div className="m-body"><ErrorBanner message={error} /></div></div>;
  if (!data) return <div className="m-shell"><OfflineBanner /><div className="m-body"><Spinner label="Loading your position…" /></div></div>;

  // Waitlisted bookings (rung undefined — never entered the live queue) never
  // had an interview to settle, so they're excluded here rather than
  // blocking the thank-you screen on a pick that was never actually live.
  const realSlots = data.slots.filter((s) => s.rung !== undefined);
  const allSettled = realSlots.length > 0 && realSlots.every((s) => s.rung === 'done');

  return (
    <div className="m-shell">
      <OfflineBanner />
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
        {transferDataUrl && (
          <details className="qr-wrap" style={{ marginBottom: 16 }}>
            <summary className="save-note" style={{ cursor: 'pointer' }}>On a different phone? Tap to show a QR to scan</summary>
            <img src={transferDataUrl} alt="Continue on another device" width={140} height={140} style={{ marginTop: 8 }} />
            <div className="save-note">Scan this with your own phone to continue there</div>
          </details>
        )}
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
        ) : data.slots.length === 0 ? (
          // Checked in, but hasn't picked companies yet — the new candidate
          // journey (Gate check-in happens before company selection, not
          // after). Queue booking/waitlisting only happens once they submit
          // a pick here.
          <SelectCompanies
            qr={localStorage.getItem(`checkin_qr_${token}`)}
            onDone={async (droppedNames) => {
              // Refresh immediately rather than waiting up to POLL_MS for the
              // next scheduled poll to pick up the new candidate_company_status
              // rows this call just created.
              try { setData(await api.qrSchedule(token)); } catch { /* next poll will pick it up */ }
              if (droppedNames && droppedNames.length) {
                setSelectionNotice(`${droppedNames.join(', ')} couldn't be added — ask staff for help if you wanted ${droppedNames.length === 1 ? 'it' : 'them'}.`);
              }
            }}
          />
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
              <>
                <p className="desk-call-note calm" style={{ marginTop: 16 }}>✅ Feedback received — thank you!</p>
                {qrDataUrl ? (
                  <div className="qr-wrap">
                    <img src={qrDataUrl} alt="Exit QR" width={168} height={168} />
                    <div className="save-note">Show this at the Gate to exit</div>
                  </div>
                ) : (
                  // Same "no local checkin_qr" gap as the pre-check-in QR
                  // above (a candidate who recovered their session on a
                  // different device via /recover never has it) — that case
                  // already falls back to showing the token number instead
                  // of silently rendering nothing; this is the same fallback
                  // for the exit QR, which previously had none at all.
                  <p className="save-note" style={{ marginTop: 12 }}>
                    Give the Gate staff your token number ({data.token}) to exit.
                  </p>
                )}
              </>
            ) : (
              <FeedbackForm token={token} onSubmitted={() => setData((d) => ({ ...d, feedback_submitted: true }))} />
            )}
          </div>
        ) : (
          <>
            {selectionNotice && (
              <div className="error-note" style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'start' }}>
                <span>{selectionNotice}</span>
                <button type="button" className="rm" aria-label="Dismiss" onClick={() => setSelectionNotice(null)}>✕</button>
              </div>
            )}
            <WaitingDirective slots={data.slots} waitingRooms={data.waiting_rooms || []} />
            <div className="ladder">
              {data.slots.map((slot, i) => <PosCard key={`${slot.company}-${i}`} slot={slot} token={token} />)}
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
