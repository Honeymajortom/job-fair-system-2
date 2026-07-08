// Role gate — mount after authenticateJWT. Roles come from the v2.5
// role -> permission matrix (SDC_JobFair_Architecture.md §10).
module.exports = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions for this action' });
  }
  next();
};
