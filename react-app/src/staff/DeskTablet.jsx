import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AnimatePresence, m } from 'framer-motion';
import { api } from '../api';
import { useSocket, useSocketEvent } from './SocketContext';
import IncomingCard from './IncomingCard';
import CountdownRing from './CountdownRing';

// Backend always arms the same-floor timer (90s) — floor tracking doesn't
// exist yet (lib/noShowTimer.js's own floor-awareness note) — so this is the
// one real duration the ring will ever need to render against client-side.
const SAME_FLOOR_MS = 90 * 1000;

async function fetchCandidateDetails(token, companyId) {
  const full = await api.getCandidate(token);
  const co = full.companies.find((c) => c.company_id === companyId);
  return {
    token,
    name: full.name,
    qualification: full.qualification,
    missedCalls: co ? co.misses : 0,
    comingFrom: 'Same floor',
  };
}

export default function DeskTablet() {
  const { companyId: companyIdParam, deskId } = useParams();
  const companyId = Number(companyIdParam);
  const { joinDesk } = useSocket();

  const [ratingParameters, setRatingParameters] = useState([]);
  const [incoming, setIncoming] = useState(null); // { candidateId, ccsId, expiresAt, details }
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    joinDesk({ companyId, deskId });
  }, [companyId, deskId, joinDesk]);

  useEffect(() => {
    api.getCompany(companyId).then((c) => setRatingParameters(c.rating_parameters || [])).catch(() => {});
  }, [companyId]);

  function showToast(text, isErr) {
    setToast({ text, isErr });
    setTimeout(() => setToast(null), 2500);
  }

  async function applyIncoming({ candidateId, ccsId, token, expiresAt }) {
    try {
      const details = await fetchCandidateDetails(token, companyId);
      setIncoming({ candidateId, ccsId, expiresAt, details });
    } catch {
      setIncoming({ candidateId, ccsId, expiresAt, details: { token, name: token, missedCalls: 0, comingFrom: 'Same floor' } });
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
      applyIncoming({ candidateId: payload.candidateId, ccsId: payload.ccsId, token: payload.token, expiresAt: payload.expiresAt });
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

  async function handleDone({ status, ratings }) {
    if (!incoming) return;
    try {
      await api.submitResult({ token: incoming.details.token, company_id: companyId, status, ratings });
      showToast(`${incoming.details.token} — ${status}`);
      setIncoming(null);
      await callNext();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  return (
    <div className="s-body">
      <h2 className="screen-title">Desk {deskId}</h2>
      <div className="tablet-grid">
        <AnimatePresence mode="wait">
          {incoming ? (
            <IncomingCard key={incoming.candidateId} candidate={incoming.details} ratingParameters={ratingParameters} onDone={handleDone} />
          ) : (
            <m.div key="idle" className="incoming-card" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <p className="save-note" style={{ textAlign: 'left' }}>No one at the desk right now.</p>
              <button className="btn" style={{ marginTop: 14 }} disabled={loading} onClick={callNext}>
                {loading ? 'Calling…' : 'Call first candidate'}
              </button>
            </m.div>
          )}
        </AnimatePresence>
        <CountdownRing expiresAt={incoming?.expiresAt} totalMs={SAME_FLOOR_MS} />
      </div>
      {toast && <div className={`toast${toast.isErr ? ' err' : ''}`}>{toast.text}</div>}
    </div>
  );
}
