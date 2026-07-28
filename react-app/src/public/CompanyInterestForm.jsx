import { useState } from 'react';
import { api } from '../api';

// Shown on LivePosition once every one of a candidate's bookings has
// settled, before the overall FeedbackForm — one Yes/No per company they
// actually interviewed with (Waitlisted bookings never had a live interview,
// so they're not asked about). Independent of the outcome, which is
// deliberately hidden from the candidate (RungBadge.jsx's OUTCOME_LABELS).
// Same check-in-QR-as-capability pattern as FeedbackForm.jsx and for the
// same reason — bare token_no is guessable.
export default function CompanyInterestForm({ token, companies, onSubmitted }) {
  const [answers, setAnswers] = useState({});
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const complete = companies.every((c) => typeof answers[c.company_id] === 'boolean');

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const qr = localStorage.getItem(`checkin_qr_${token}`);
      if (!qr) throw new Error('This needs the device you registered on — please ask staff for help.');
      await api.submitCompanyInterest(qr, answers);
      onSubmitted();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="feedback-box">
      <div className="resume-box-head">Interested in these companies?</div>
      <div style={{ padding: '2px 14px 14px' }}>
        {companies.map((c) => (
          <div className="stars-row" key={c.company_id} style={{ justifyContent: 'space-between' }}>
            <span className="p">{c.company_name}</span>
            <span className="seg" style={{ margin: 0 }}>
              <button
                type="button"
                className={answers[c.company_id] === true ? 'on' : ''}
                onClick={() => setAnswers((prev) => ({ ...prev, [c.company_id]: true }))}
              >
                Yes
              </button>
              <button
                type="button"
                className={answers[c.company_id] === false ? 'on' : ''}
                onClick={() => setAnswers((prev) => ({ ...prev, [c.company_id]: false }))}
              >
                No
              </button>
            </span>
          </div>
        ))}
        {error && <div className="error-note">{error}</div>}
        <button className="btn" style={{ marginTop: 12 }} disabled={!complete || submitting} onClick={submit}>
          {submitting ? 'Submitting…' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
