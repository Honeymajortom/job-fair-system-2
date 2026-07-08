const bcrypt = require('bcryptjs');
const pool = require('../db');

// Seed admin so login is testable out of the box — change the password before any real fair.
const ADMIN = { username: 'admin', password: 'admin123', role: 'admin' };

const COMPANIES = [
  {
    company_name: 'Infosys',
    description: 'IT services & consulting',
    location: 'Hall B · Desk 2',
    field: 'IT',
    job_type: 'Full-time',
    min_qualification: 'Diploma',
    max_qualification: 'Any Graduate',
    params: ['Communication', 'Technical', 'Attitude'],
  },
  {
    company_name: 'TCS',
    description: 'Global IT & business solutions',
    location: 'Hall A · Desk 5',
    field: 'IT',
    job_type: 'Full-time',
    min_qualification: 'Diploma',
    max_qualification: 'Any Graduate',
    params: ['Communication', 'Technical', 'Problem Solving'],
  },
  {
    company_name: 'Wipro',
    description: 'IT & manufacturing services',
    location: 'Hall B · Desk 1',
    field: 'IT',
    job_type: 'Full-time',
    min_qualification: 'ITI',
    max_qualification: 'Any Graduate',
    params: ['Communication', 'Technical', 'Reliability'],
  },
];

// Slot grid: 9:45 -> 12:00, 15 min apart, per company
function buildSlotTimes() {
  const times = [];
  const start = new Date();
  start.setHours(9, 45, 0, 0);
  for (let i = 0; i < 10; i++) {
    times.push(new Date(start.getTime() + i * 15 * 60 * 1000));
  }
  return times;
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Admin account
    const adminExisting = await client.query('SELECT id FROM users WHERE username = $1', [ADMIN.username]);
    if (adminExisting.rows.length) {
      console.log(`User ${ADMIN.username} already exists (id ${adminExisting.rows[0].id}), skipping.`);
    } else {
      const adminRes = await client.query(
        `INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING id`,
        [ADMIN.username, bcrypt.hashSync(ADMIN.password, 10), ADMIN.role]
      );
      console.log(`Seeded admin user (id ${adminRes.rows[0].id}) — username '${ADMIN.username}', password '${ADMIN.password}'.`);
    }

    // Fair settings for today, is_active = true so the soft-delete guard is live
    const fairExisting = await client.query('SELECT id FROM fair_settings WHERE fair_date = CURRENT_DATE');
    if (fairExisting.rows.length) {
      console.log(`fair_settings for today already exists (id ${fairExisting.rows[0].id}), skipping.`);
    } else {
      const fairRes = await client.query(
        `INSERT INTO fair_settings (fair_name, fair_date, is_active)
         VALUES ('SDC Job Fair (prototype)', CURRENT_DATE, true) RETURNING id, fair_date`
      );
      console.log(`Seeded fair_settings for ${fairRes.rows[0].fair_date} (id ${fairRes.rows[0].id}).`);
    }

    for (const c of COMPANIES) {
      const existing = await client.query('SELECT id FROM companies WHERE company_name = $1', [c.company_name]);
      let companyId;
      if (existing.rows.length) {
        companyId = existing.rows[0].id;
        console.log(`Company ${c.company_name} already exists (id ${companyId}), skipping slots/params re-insert.`);
        continue;
      }

      const res = await client.query(
        `INSERT INTO companies (company_name, description, location, field, job_type, min_qualification, max_qualification)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [c.company_name, c.description, c.location, c.field, c.job_type, c.min_qualification, c.max_qualification]
      );
      companyId = res.rows[0].id;

      for (let i = 0; i < c.params.length; i++) {
        await client.query(
          `INSERT INTO rating_parameters (company_id, parameter_name, display_order) VALUES ($1,$2,$3)`,
          [companyId, c.params[i], i]
        );
      }

      for (const slotStart of buildSlotTimes()) {
        await client.query(
          `INSERT INTO interview_slots (company_id, slot_start, duration_minutes, capacity) VALUES ($1,$2,$3,$4)`,
          [companyId, slotStart, 15, 1]
        );
      }

      console.log(`Seeded ${c.company_name} (id ${companyId}) with ${c.params.length} rating params and 10 slots.`);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

seed()
  .then(() => {
    console.log('Seed complete.');
    return pool.end();
  })
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exit(1);
  });
