// Shared by registerCandidate.js (registration-time assignment) and
// routes/batches.js (legacy-candidate fallback at check-in) — replaces the
// old manual "Generate batch" step. When no open batch has room, this just
// creates the next one on the same evenly-spaced grid (anchored to batch
// #1's arrival_time) instead of making staff press a button first.
//
// Advisory-locked per fair_date so two concurrent callers can't both decide
// "none has room" and insert the same batch_number twice — fair_batches has
// a UNIQUE(fair_date, batch_number) constraint.
async function getOrCreateAvailableBatch(client, fair) {
  const { fair_date: fairDate, batch_size: batchSize, batch_interval_minutes: intervalMinutes } = fair;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`batch-assign:${fairDate}`]);

  // Occupancy for every open batch in one round trip (a correlated subquery
  // per row, not a join, so FOR UPDATE still locks exactly the fair_batches
  // rows it always did) instead of a sequential per-batch COUNT(*) loop —
  // that loop used to run entirely while holding both this advisory lock and
  // the row lock below, serializing every concurrent registration on the
  // same fair-date through it.
  const batchesRes = await client.query(
    `SELECT fb.id, fb.arrival_time, fb.capacity,
            (SELECT COUNT(*)::int FROM candidates c WHERE c.batch_id = fb.id AND c.deleted_at IS NULL) AS occupied
     FROM fair_batches fb
     WHERE fb.fair_date = $1 AND fb.status != 'closed'
     ORDER BY fb.arrival_time ASC
     FOR UPDATE`,
    [fairDate]
  );
  const available = batchesRes.rows.find((b) => b.occupied < b.capacity);
  if (available) return available;

  const lastRes = await client.query(
    'SELECT batch_number, arrival_time FROM fair_batches WHERE fair_date = $1 ORDER BY batch_number DESC LIMIT 1',
    [fairDate]
  );
  const nextNumber = lastRes.rows.length ? lastRes.rows[0].batch_number + 1 : 1;
  let arrivalTime;
  if (lastRes.rows.length) {
    const anchorRes = await client.query(
      'SELECT arrival_time FROM fair_batches WHERE fair_date = $1 AND batch_number = 1',
      [fairDate]
    );
    arrivalTime = new Date(new Date(anchorRes.rows[0].arrival_time).getTime() + (nextNumber - 1) * intervalMinutes * 60000);
  } else {
    arrivalTime = new Date(`${fairDate}T09:00:00`);
  }

  const insertRes = await client.query(
    `INSERT INTO fair_batches (fair_date, batch_number, arrival_time, capacity)
     VALUES ($1, $2, $3, $4) RETURNING id, arrival_time, capacity`,
    [fairDate, nextNumber, arrivalTime.toISOString(), batchSize]
  );
  return insertRes.rows[0];
}

module.exports = { getOrCreateAvailableBatch };
