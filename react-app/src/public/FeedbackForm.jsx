import { useState } from 'react';
import { api } from '../api';

const RATING_FIELDS = [
  { key: 'venue_rating', label: 'Venue & Facilities' },
  { key: 'process_rating', label: 'Registration & Queue Process' },
  { key: 'staff_rating', label: 'Staff Support' },
  { key: 'overall_rating', label: 'Overall Experience' },
];

// Shown on LivePosition once every one of a candidate's bookings has
// settled. The check-in QR doubles as this write's capability token (same
// reasoning as uploadResume — bare token_no is guessable) — a candidate who
// recovered their session on a different device (RecoverToken.jsx) won't
// have it locally, same known gap the resume upload already has.
export default function FeedbackForm({ token, onSubmitted }) {
  const [ratings, setRatings] = useState({});
  const [interestedInSdc, setInterestedInSdc] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const complete = RATING_FIELDS.every((f) => ratings[f.key]) && interestedInSdc !== null;

  function setStar(field, value) {
    setRatings((prev) => ({ ...prev, [field]: value }));
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const qr = localStorage.getItem(`checkin_qr_${token}`);
      if (!qr) throw new Error('Feedback needs the device you registered on — please ask staff for help.');
      await api.submitFeedback(qr, {
        venue_rating: ratings.venue_rating,
        process_rating: ratings.process_rating,
        staff_rating: ratings.staff_rating,
        overall_rating: ratings.overall_rating,
        interested_in_sdc: interestedInSdc,
      });
      onSubmitted();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="feedback-box">
      <div className="resume-box-head">Tell us about today</div>
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
          <span className="p">Interested in joining SDC?</span>
        </div>
        <div className="seg" style={{ marginBottom: 12 }}>
          <button type="button" className={interestedInSdc === true ? 'on' : ''} onClick={() => setInterestedInSdc(true)}>Yes</button>
          <button type="button" className={interestedInSdc === false ? 'on' : ''} onClick={() => setInterestedInSdc(false)}>No</button>
        </div>
        {error && <div className="error-note">{error}</div>}
        <button className="btn" disabled={!complete || submitting} onClick={submit}>
          {submitting ? 'Submitting…' : 'Submit feedback'}
        </button>
      </div>
    </div>
  );
}
