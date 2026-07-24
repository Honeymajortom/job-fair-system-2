import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AnimatePresence, m } from 'framer-motion';
import { api } from '../api';
import { useSocket, useSocketEvent } from './SocketContext';
import IncomingCard from './IncomingCard';
import CountdownRing from './CountdownRing';
import InterviewTimer from './InterviewTimer';

// lib/queueDispatcher.js arms the timer at one of these two durations
// depending on resolveSameFloor()'s companies.floor_number comparison; the
// dispatch/occupant payload's own `sameFloor` (below) says which one applies
// to this specific candidate, so the ring's totalMs has to follow it rather
// than assuming same-floor always.
const SAME_FLOOR_MS = 90 * 1000;
const CROSS_FLOOR_MS = 180 * 1000;

async function fetchCandidateDetails(token, companyId) {
  const full = await api.getCandidate(token);
  const co = full.companies.find((c) => c.company_id === companyId);
  return {
    token,
    name: full.name,
    qualification: full.qualification,
    missedCalls: co ? co.misses : 0,
    // GET /api/candidates/:token already SELECT *s the candidates row, so
    // this needs zero backend changes beyond the resume_uploaded_at column.
    hasResume: !!full.resume_uploaded_at,
  };
}

export default function DeskTablet() {
  const { companyId: companyIdParam, deskId } = useParams();
  const companyId = Number(companyIdParam);
  const { joinDesk } = useSocket();

  const [ratingParameters, setRatingParameters] = useState([]);
  const [isOpen, setIsOpen] = useState(null); // null while unknown — company_hr's own desk-open status
  const [togglingOpen, setTogglingOpen] = useState(false);
  const [incoming, setIncoming] = useState(null); // { candidateId, ccsId, expiresAt, interviewStartedAt, details }
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pausedRemainingMs, setPausedRemainingMs] = useState(null);
  const [pausing, setPausing] = useState(false);
  const [skipping, setSkipping] = useState(false);

  useEffect(() => {
    joinDesk({ companyId, deskId });
  }, [companyId, deskId, joinDesk]);

  useEffect(() => {
    api.getCompany(companyId).then((c) => {
      setRatingParameters(c.rating_parameters || []);
      setIsOpen(c.is_open);
    }).catch(() => {});
  }, [companyId]);

  function showToast(text, isErr) {
    setToast({ text, isErr });
    setTimeout(() => setToast(null), 2500);
  }

  // The signal candidates' GET /qr/companies filters on — this is where
  // whoever's actually staffing the desk flips it, rather than needing an
  // admin to do it from the Companies tab on their behalf.
  async function toggleDeskOpen() {
    setTogglingOpen(true);
    try {
      const res = await api.setCompanyOpenStatus(companyId, !isOpen);
      setIsOpen(res.is_open);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setTogglingOpen(false);
    }
  }

  async function applyIncoming({ candidateId, ccsId, token, expiresAt, sameFloor = true, interviewStartedAt = null }) {
    const comingFrom = sameFloor ? 'Same floor' : 'Different floor';
    setPaused(false);
    setPausedRemainingMs(null);
    try {
      const details = await fetchCandidateDetails(token, companyId);
      setIncoming({ candidateId, ccsId, expiresAt, sameFloor, interviewStartedAt, details: { ...details, comingFrom } });
    } catch {
      setIncoming({ candidateId, ccsId, expiresAt, sameFloor, interviewStartedAt, details: { token, name: token, missedCalls: 0, comingFrom } });
    }
  }

  // Room-scoped — this only ever fires for dispatches to *this* desk, so any
  // event received here is authoritative, no companyId/deskId filtering needed.
  useSocketEvent('desk_incoming', (payload) => {
    applyIncoming(payload);
  });

  // Global event, so filter to this desk — candidate_dispatched carries no
  // ccsId, only used here to catch a dispatch that happened before this
  // component mounted its desk_incoming listener (rare race, cheap to cover).
  useSocketEvent('candidate_dispatched', (payload) => {
    if (payload.companyId === companyId && payload.deskId === String(deskId)) {
      applyIncoming({ candidateId: payload.candidateId, ccsId: payload.ccsId, token: payload.token, expiresAt: payload.expiresAt, sameFloor: payload.sameFloor });
    }
  });

  // queue_miss carries candidateId only, no token (see lib/queueDispatcher.js /
  // workers/noShowWorker.js) — key off candidateId, not token, to actually
  // react to it.
  useSocketEvent('queue_miss', (payload) => {
    setIncoming((cur) => {
      if (cur && cur.candidateId === payload.candidateId && payload.companyId === companyId) {
        showToast('Candidate missed the call — backfilling…');
        return null;
      }
      return cur;
    });
  });

  async function callNext() {
    setLoading(true);
    try {
      const res = await api.deskNext({ company_id: companyId, desk_id: deskId });
      if (res.dispatched) {
        await applyIncoming(res.dispatched);
      } else {
        showToast('No one eligible right now — waiting for the next arrival.');
      }
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setLoading(false);
    }
  }

  // Sits between InterviewTimer and CountdownRing — one control governing
  // whichever of the two is currently showing. Pre-arrival, this is a real
  // server-side pause (the no-show timer is actually removed, see
  // lib/noShowTimer.js); once interviewing, there's no backend deadline to
  // pause, so it's just a local freeze of the elapsed-time display.
  async function togglePause() {
    if (!incoming) return;
    if (incoming.interviewStartedAt) {
      setPaused((p) => !p);
      return;
    }
    setPausing(true);
    try {
      if (!paused) {
        const res = await api.pauseArrival({ token: incoming.details.token, company_id: companyId });
        setPaused(true);
        setPausedRemainingMs(res.remaining_ms);
      } else {
        const res = await api.resumeArrival({ token: incoming.details.token, company_id: companyId, same_floor: incoming.sameFloor });
        setIncoming((cur) => (cur ? { ...cur, expiresAt: res.expires_at } : cur));
        setPaused(false);
        setPausedRemainingMs(null);
      }
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setPausing(false);
    }
  }

  // "Next" — skip a candidate who hasn't arrived yet rather than waiting out
  // the full 90s/180s arrival timer. Reuses the same manual no-show endpoint
  // Floor Manager already had; Company HR just gets a one-tap shortcut to it
  // instead of watching the countdown run out on its own.
  async function handleSkip() {
    if (!incoming || incoming.interviewStartedAt) return;
    setSkipping(true);
    try {
      await api.markNoShow({ token: incoming.details.token, company_id: companyId });
      showToast(`${incoming.details.token} — skipped`);
      setIncoming(null);
      await callNext();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setSkipping(false);
    }
  }

  // Desk occupancy on mount: read-only (GET /queue/desk/:companyId/:deskId,
  // no dispatch side effect), so a page reload while someone's mid-interview
  // reattaches to them instead of leaving the tablet showing an empty "Call
  // first candidate" state — that emptiness was the other half of what made
  // a stray double-tap dispatch a second candidate onto an occupied desk.
  // dispatch() itself (called from callNext() above) now also refuses to
  // double-dispatch, independent of this check.
  useEffect(() => {
    let cancelled = false;
    api.getDeskOccupant(companyId, deskId).then((res) => {
      if (!cancelled && res.occupant) applyIncoming(res.occupant);
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, deskId]);

  async function handleStartInterview() {
    if (!incoming) return;
    try {
      const res = await api.confirmArrival({ token: incoming.details.token, company_id: companyId });
      setIncoming((cur) => (cur && cur.candidateId === incoming.candidateId ? { ...cur, interviewStartedAt: res.interview_started_at } : cur));
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function handleDone({ status, ratings }) {
    if (!incoming) return;
    try {
      await api.submitResult({ token: incoming.details.token, company_id: companyId, status, ratings });
      showToast(`${incoming.details.token} — ${status}`);
      setIncoming(null);
      setPaused(false);
      setPausedRemainingMs(null);
      await callNext();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  return (
    <div className="s-body">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h2 className="screen-title">Desk {deskId}</h2>
        {isOpen !== null && (
          <button
            className={`checkin-status ${isOpen ? 'in' : 'out'}`}
            style={{ cursor: 'pointer', marginTop: 0 }}
            disabled={togglingOpen}
            onClick={toggleDeskOpen}
            title="Whether candidates can currently see and register for this company"
          >
            {togglingOpen ? '…' : isOpen ? 'Desk open — candidates can register' : 'Desk closed — hidden from candidates'}
          </button>
        )}
      </div>
      <div className="tablet-grid">
        <AnimatePresence mode="wait">
          {incoming ? (
            <IncomingCard
              key={incoming.candidateId}
              candidate={incoming.details}
              companyId={companyId}
              ratingParameters={ratingParameters}
              interviewStartedAt={incoming.interviewStartedAt}
              onStartInterview={handleStartInterview}
              onDone={handleDone}
            />
          ) : (
            <m.div key="idle" className="incoming-card" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <p className="save-note" style={{ textAlign: 'left' }}>No one at the desk right now.</p>
              <button className="btn" style={{ marginTop: 14 }} disabled={loading} onClick={() => callNext()}>
                {loading ? 'Calling…' : 'Call first candidate'}
              </button>
            </m.div>
          )}
        </AnimatePresence>
        {incoming && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 10 }}>
            <button className="btn ghost" style={{ width: 'auto', padding: '8px 14px' }} disabled={pausing} onClick={togglePause}>
              {pausing ? '…' : paused ? '▶ Resume' : '⏸ Pause'}
            </button>
            {!incoming.interviewStartedAt && (
              <button className="btn ghost" style={{ width: 'auto', padding: '8px 14px' }} disabled={skipping} onClick={handleSkip}>
                {skipping ? '…' : '⏭ Next'}
              </button>
            )}
          </div>
        )}
        {incoming?.interviewStartedAt ? (
          <InterviewTimer startedAt={incoming.interviewStartedAt} paused={paused} />
        ) : (
          <CountdownRing
            expiresAt={incoming?.expiresAt}
            totalMs={incoming?.sameFloor === false ? CROSS_FLOOR_MS : SAME_FLOOR_MS}
            paused={paused}
            pausedRemainingMs={pausedRemainingMs}
          />
        )}
      </div>
      {toast && <div className={`toast${toast.isErr ? ' err' : ''}`}>{toast.text}</div>}
    </div>
  );
}
