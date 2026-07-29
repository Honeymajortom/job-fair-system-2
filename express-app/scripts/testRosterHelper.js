// Shared by fixtures that need a company's operational fields (seats/
// interview_minutes/floor_number/is_open) resolved via a real
// fair_company_roster row (company_roster_plan.md) instead of the
// company's own now-legacy columns. Reuses the center's already-active fair
// if one exists (never fights with real state a real fair day might have);
// otherwise creates a dedicated throwaway fair for the fixture's own
// duration on a far-future date (collision-proof against real fair dates),
// returned with `created: true` so the caller knows to clean it up —
// deleting it cascades the roster row away with it (ON DELETE CASCADE).
const pool = require('../db');

async function ensureActiveFair(centerId = 1) {
  const existing = await pool.query('SELECT id FROM fair_settings WHERE center_id = $1 AND is_active = true', [centerId]);
  if (existing.rows.length) return { fairId: existing.rows[0].id, created: false };

  const created = await pool.query(
    `INSERT INTO fair_settings (fair_name, fair_date, center_id, is_active)
     VALUES ($1, CURRENT_DATE + ((floor(random() * 100000) + 1000)::int * interval '1 day'), $2, true)
     RETURNING id`,
    [`__test_fixture_fair_${Date.now()}`, centerId]
  );
  return { fairId: created.rows[0].id, created: true };
}

async function ensureRoster(fairId, companyId, { seats = 1, interview_minutes = 6, floor_number = null, is_open = true } = {}) {
  await pool.query(
    `INSERT INTO fair_company_roster (fair_settings_id, company_id, seats, interview_minutes, floor_number, is_open)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (fair_settings_id, company_id) DO UPDATE SET
       seats = EXCLUDED.seats, interview_minutes = EXCLUDED.interview_minutes,
       floor_number = EXCLUDED.floor_number, is_open = EXCLUDED.is_open`,
    [fairId, companyId, seats, interview_minutes, floor_number, is_open]
  );
}

async function cleanupFair(fair) {
  if (fair && fair.created) await pool.query('DELETE FROM fair_settings WHERE id = $1', [fair.fairId]);
}

module.exports = { ensureActiveFair, ensureRoster, cleanupFair };
