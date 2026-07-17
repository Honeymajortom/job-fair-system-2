// Presentational only — maps a ping-ladder rung (lib/pingLadder.js on the
// backend) to the label copy + color modifier from new_architecture_uiux_spec.html §01.
const LABELS = {
  far: 'TRACKING',
  warm: 'COME NOW',
  gate: 'GATE OPEN',
  staging: 'STAGING',
  desk_call: 'DESK CALL',
  in_interview: 'IN INTERVIEW',
  done: 'DONE',
  waitlisted: 'WAITLISTED',
};

// Overrides LABELS.done with the actual outcome once the result is in — a
// bare "DONE" badge doesn't tell the candidate whether that was good news.
const OUTCOME_LABELS = {
  Selected: 'SELECTED 🎉',
  Shortlisted: 'SHORTLISTED',
  Hold: 'ON HOLD',
  Rejected: 'NOT SELECTED',
  No_Show: 'MARKED NO-SHOW',
};

const MODIFIERS = {
  warm: 'warm',
  gate: 'hot',
  staging: 'hot',
  desk_call: 'hot',
  in_interview: 'hot',
  done: 'done',
  waitlisted: 'waitlisted',
};

// status only matters for rung 'done' — Rejected/No_Show shouldn't wear the
// same green "success" styling as Selected/Shortlisted/Hold. Shared by both
// RungBadge and PosCard's card modifier so the badge and card border never
// disagree on tone.
export function cardModifier(rung, status) {
  if (rung === 'done') return status === 'Rejected' || status === 'No_Show' ? 'rejected' : 'done';
  return MODIFIERS[rung] || '';
}

// status is the raw candidate_company_status value (only meaningful when
// rung === 'done') — see OUTCOME_LABELS above.
export default function RungBadge({ rung, status }) {
  const modifier = cardModifier(rung, status);
  const label = (rung === 'done' && OUTCOME_LABELS[status]) || LABELS[rung] || rung;
  return (
    <span className={`rung-badge${modifier ? ` ${modifier}` : ''}`}>
      {label}
    </span>
  );
}
