// Shown when a role-gated action is actually attempted and the server 403s
// — distinct from just hiding the control client-side (which the app
// already does for most cases), for the screens/actions where the attempt
// itself needs an explicit acknowledgment.
export default function PermissionDenied({ message = "You don't have permission to do that." }) {
  return (
    <div className="permission-denied">
      <span className="ic">🔒</span>
      <div>{message}</div>
    </div>
  );
}
