// fair_cycle_isolation_plan.md Phase 4 — resolves which Center a request
// should be scoped to. Admin is unscoped by default (sees every Center) but
// can voluntarily narrow via ?center_id= (the Nav switcher's selection, once
// one is picked); every other role is unconditionally pinned to its own
// center_id regardless of what (if anything) the query string says — same
// "server enforces, client convenience only" shape as requireCompanyScope.
function resolveCenterFilter(req) {
  if (req.user.role === 'admin') {
    return req.query.center_id ? Number(req.query.center_id) : null;
  }
  return req.user.center_id;
}

module.exports = { resolveCenterFilter };
