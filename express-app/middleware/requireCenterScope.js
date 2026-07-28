// fair_cycle_isolation_plan.md Phase 0 — every non-admin role is scoped to
// one Center (mirrors requireCompanyScope's company_hr pattern, but applies
// to all four non-admin roles rather than just one, since Center scoping
// isn't role-specific the way company scoping is). getCenterId(req) reads
// the target center_id from params/body/query (route-specific); admin keeps
// unscoped access to every Center.
//
// Not yet mounted on any route — with only one Center in existence, every
// request already resolves to it, so there's nothing to enforce yet. Phase 4
// (the actual Center picker) is what gives requests a real, variable
// center_id to check against.
module.exports = (getCenterId) => (req, res, next) => {
  if (req.user.role === 'admin') return next();
  const centerId = getCenterId(req);
  if (centerId == null || Number(centerId) !== Number(req.user.center_id)) {
    return res.status(403).json({ error: 'You do not have access to this center' });
  }
  next();
};
