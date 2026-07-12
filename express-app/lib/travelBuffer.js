// new_architecture.md §4: tau_bar + sigma_tau, the travel-time term of
// B_j* = d_hat_j * (tau_bar + sigma_tau). Shared by lib/floorStats.js
// (display) and lib/bufferController.js (the closed loop that acts on it) so
// the two never drift onto different numbers for the same fair.
const pool = require('../db');

// Approximation (documented in the plan): no candidate reports travel time
// per company, so mean/stddev is fair-wide. Falls back to a fixed estimate
// when nobody's reported one yet.
const FALLBACK_TRAVEL_MINUTES = 20;

async function getTravelBuffer() {
  const r = await pool.query(
    `SELECT AVG(travel_time_minutes) AS mean, STDDEV(travel_time_minutes) AS sd
     FROM candidates WHERE travel_time_minutes IS NOT NULL AND deleted_at IS NULL`
  );
  const mean = parseFloat(r.rows[0].mean);
  if (!mean) return FALLBACK_TRAVEL_MINUTES;
  const sd = parseFloat(r.rows[0].sd) || 0;
  return mean + sd;
}

module.exports = { getTravelBuffer, FALLBACK_TRAVEL_MINUTES };
