// Generic "nothing here yet" placeholder — covers both the true-empty case
// (no rows exist) and the no-search-results case (filters/search matched
// nothing); callers pick copy for whichever applies.
export default function EmptyState({ icon = '📭', title, hint }) {
  return (
    <div className="empty-state">
      <span className="ic">{icon}</span>
      {title && <div className="title">{title}</div>}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}
