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

// Overrides LABELS.done once the result is in. As of 2026-07-25, Selected/
// Shortlisted/Hold/Rejected are deliberately NOT distinguished here — staff
// tell candidates their real result manually, so the badge only ever says
// "INTERVIEW DONE" regardless of which of those four it actually was.
// No_Show is exempt: it's process feedback about a missed call, not a
// selection result, so it keeps its own distinct label.
const OUTCOME_LABELS = {
  Selected: 'INTERVIEW DONE',
  Shortlisted: 'INTERVIEW DONE',
  Hold: 'INTERVIEW DONE',
  Rejected: 'INTERVIEW DONE',
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

// status only matters for rung 'done'. As of 2026-07-25 a real outcome
// (Selected/Shortlisted/Hold/Rejected) always wears the same neutral 'done'
// styling — coloring it red-for-Rejected/green-for-Selected would leak the
// hidden result just as much as the label would. No_Show keeps its own
// distinct (muted/alert) styling since it's a process notice, not a result.
// Shared by both RungBadge and PosCard's card modifier so the badge and card
// border never disagree on tone.
export function cardModifier(rung, status) {
  if (rung === 'done') return status === 'No_Show' ? 'rejected' : 'done';
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
