const pool = require('../db');

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

// STAFF_INCONSISTENCY_REPORT.md S11: several global Socket.IO events
// (lib/events.js's emit(), not emitToRoom()) carry no center_id at all, so a
// client scoped to one Center (FloorMonitor.jsx) can't filter out another
// Center's activity and ends up re-fetching on every event regardless of
// which Center it actually came from. Single-row lookup, used only at emit
// time (a handful of call sites), not on any hot read path.
async function resolveCompanyCenterId(companyId) {
  const res = await pool.query('SELECT center_id FROM companies WHERE id = $1', [companyId]);
  return res.rows[0]?.center_id ?? null;
}

module.exports = { resolveCenterFilter, resolveCompanyCenterId };
