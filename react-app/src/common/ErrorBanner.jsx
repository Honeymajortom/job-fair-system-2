// Generic error display with an optional retry action — replaces the
// ad hoc `<div className="error-note">{msg}</div>` copy-pasted per screen.
export default function ErrorBanner({ message, onRetry }) {
  if (!message) return null;
  return (
    <div className="error-note" style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
      <span>⚠ {message}</span>
      {onRetry && (
        <button type="button" className="btn ghost" style={{ width: 'auto', padding: '4px 10px' }} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
