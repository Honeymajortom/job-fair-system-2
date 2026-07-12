// Presentational only — maps a ping-ladder rung (lib/pingLadder.js on the
// backend) to the label copy + color modifier from new_architecture_uiux_spec.html §01.
const LABELS = {
  far: 'TRACKING',
  warm: 'COME NOW',
  gate: 'GATE OPEN',
  staging: 'STAGING',
  desk_call: 'DESK CALL',
  done: 'DONE',
  waitlisted: 'WAITLISTED',
};

const MODIFIERS = {
  warm: 'warm',
  gate: 'hot',
  staging: 'hot',
  desk_call: 'hot',
  done: 'done',
  waitlisted: 'waitlisted',
};

export default function RungBadge({ rung }) {
  const modifier = MODIFIERS[rung] || '';
  return (
    <span className={`rung-badge${modifier ? ` ${modifier}` : ''}`}>
      {LABELS[rung] || rung}
    </span>
  );
}

export function cardModifier(rung) {
  if (rung === 'warm') return 'warm';
  if (rung === 'gate' || rung === 'staging' || rung === 'desk_call') return 'hot';
  if (rung === 'done') return 'done';
  return '';
}
