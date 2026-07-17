import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AnimatePresence, m } from 'framer-motion';
import QRCode from 'qrcode';
import { api } from '../api';
import RungBadge, { cardModifier } from './RungBadge';

const POLL_MS = 5000; // server caches the route for 15s, so most polls are cache hits
const QR_ELIGIBLE_RUNGS = ['gate', 'staging', 'desk_call'];
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
  const modifier = isWaitlisted ? '' : cardModifier(rung);
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
        <div className="co">{slot.company}</div>
        <RungBadge rung={rung} />
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
        <p className="desk-call-note">🔔 Your turn — go to the desk now</p>
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
    if (!isCalled) return undefined;

    const originalTitle = document.title;
    let on = false;
    document.title = '🔔 GO TO THE DESK NOW';
    const id = setInterval(() => {
      on = !on;
      document.title = on ? originalTitle : '🔔 GO TO THE DESK NOW';
    }, 1000);
    return () => { clearInterval(id); document.title = originalTitle; };
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
