import { useState } from 'react';

const RATING_FIELDS = [
  { key: 'candidate_quality', label: 'Overall quality of candidates interviewed' },
  { key: 'venue_rating', label: 'Venue & overall event arrangements' },
  { key: 'app_performance_rating', label: 'Job Fair app/system performance' },
  { key: 'volunteer_satisfaction', label: 'Coordination & support from volunteers/organizers' },
];

const FUTURE_INTEREST_OPTIONS = ['Definitely Yes', 'Probably Yes', 'Maybe', 'Probably No', 'Definitely No'];

// candidate_and_desk_improvements_plan.md §D: shown inline by DeskTablet.jsx
// when Company HR taps "Close Desk" — submitting this is what actually flips
// is_open to false (POST /companies/:id/close-desk does both in one
// transaction). Canceling leaves the desk open, by design: closing is a
// no-op until this form is actually submitted. Same star-rating + segmented-
// control shapes as FeedbackForm.jsx/IncomingCard.jsx's outcome step, reusing
// the existing .stars-row/.stars/.seg classes.
export default function CloseDeskFeedback({ onSubmit, onCancel }) {
  const [ratings, setRatings] = useState({});
  const [futureInterest, setFutureInterest] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const complete = RATING_FIELDS.every((f) => ratings[f.key]) && futureInterest !== null;

  function setStar(field, value) {
    setRatings((prev) => ({ ...prev, [field]: value }));
  }

  async function submit() {
    if (!complete) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        candidate_quality: ratings.candidate_quality,
        venue_rating: ratings.venue_rating,
        app_performance_rating: ratings.app_performance_rating,
        volunteer_satisfaction: ratings.volunteer_satisfaction,
        future_interest: futureInterest,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="feedback-box">
      <div className="resume-box-head">Before you close — a few quick questions</div>
      <div style={{ padding: '2px 14px 14px' }}>
        {RATING_FIELDS.map((f) => (
          <div className="stars-row" key={f.key}>
            <span className="p">{f.label}</span>
            <span className="stars">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={(ratings[f.key] || 0) >= n ? 'on' : ''}
                  onClick={() => setStar(f.key, n)}
                  aria-label={`${n} star${n > 1 ? 's' : ''}`}
                >★</button>
              ))}
            </span>
          </div>
        ))}
        <div className="stars-row" style={{ borderBottom: 'none', paddingBottom: 6 }}>
          <span className="p">Interested in future Job Fairs from us?</span>
        </div>
        <div className="seg" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          {FUTURE_INTEREST_OPTIONS.map((opt) => (
            <button
              key={opt}
              type="button"
              className={futureInterest === opt ? 'on' : ''}
              onClick={() => setFutureInterest(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
        {error && <div className="error-note">{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn ghost" style={{ flex: 1 }} type="button" disabled={submitting} onClick={onCancel}>
            Cancel
          </button>
          <button className="btn" style={{ flex: 1 }} disabled={!complete || submitting} onClick={submit}>
            {submitting ? 'Closing…' : 'Submit & close desk'}
          </button>
        </div>
      </div>
    </div>
  );
}
