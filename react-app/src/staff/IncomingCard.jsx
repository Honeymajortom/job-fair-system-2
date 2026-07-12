import { useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';

const OUTCOMES = ['Selected', 'Rejected', 'Shortlisted', 'Hold'];

// PUT /api/interview-result requires a status (and optionally ratings) — a
// bare "Done" tap can't satisfy that contract on its own, so tapping Done
// surfaces this compact outcome step before actually submitting. Reuses the
// same segmented-control + stars pattern the old (deleted) CompanyDesk.jsx
// used, and the .seg/.stars classes already in index.css.
export default function IncomingCard({ candidate, ratingParameters, onDone }) {
  const [pickingOutcome, setPickingOutcome] = useState(false);
  const [status, setStatus] = useState(null);
  const [ratings, setRatings] = useState({});
  const [submitting, setSubmitting] = useState(false);

  function setStar(param, value) {
    setRatings((prev) => ({ ...prev, [param]: value }));
  }

  async function confirm() {
    if (!status) return;
    setSubmitting(true);
    try {
      await onDone({ status, ratings });
    } finally {
      setSubmitting(false);
      setPickingOutcome(false);
      setStatus(null);
      setRatings({});
    }
  }

  return (
    <m.div
      className="incoming-card"
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.35, ease: [0.25, 1, 0.5, 1] }}
    >
      <div className="tag">On their way to you</div>
      <div className="tk">{candidate.token}</div>
      <dl className="cand-card" style={{ border: 'none', padding: 0 }}>
        <dt>Name</dt><dd>{candidate.name}</dd>
        <dt>Qual</dt><dd>{candidate.qualification || '—'}</dd>
        <dt>Missed calls</dt><dd>{candidate.missedCalls ?? 0}</dd>
        <dt>Coming from</dt><dd>{candidate.comingFrom}</dd>
      </dl>

      <AnimatePresence>
        {!pickingOutcome && (
          <m.button
            className="btn ok"
            style={{ marginTop: 14 }}
            onClick={() => setPickingOutcome(true)}
            exit={{ opacity: 0 }}
          >
            ✓ Done — call next
          </m.button>
        )}
        {pickingOutcome && (
          <m.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            transition={{ duration: 0.25 }}
            style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            <div className="seg">
              {OUTCOMES.map((o) => (
                <button key={o} type="button" className={status === o ? 'on' : ''} onClick={() => setStatus(o)}>
                  {o}
                </button>
              ))}
            </div>
            {ratingParameters?.map((p) => (
              <div className="stars-row" key={p.id}>
                <span className="p">{p.parameter_name}</span>
                <span className="stars">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={(ratings[p.parameter_name] || 0) >= n ? 'on' : ''}
                      onClick={() => setStar(p.parameter_name, n)}
                    >★</button>
                  ))}
                </span>
              </div>
            ))}
            <button className="btn" disabled={!status || submitting} onClick={confirm}>
              {submitting ? 'Submitting…' : 'Submit & call next'}
            </button>
          </m.div>
        )}
      </AnimatePresence>
    </m.div>
  );
}
