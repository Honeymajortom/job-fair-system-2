// Operator recovery tool (new_architecture.md §7.1/§3.2) — NOT wired into any
// route or startup path. Run by hand if Redis crashes or gets flushed mid-fair
// and a company's queue:{companyId} ZSET is gone.
//
// Postgres (candidate_company_status.serial/misses) is the system of record;
// this script rebuilds a company's live queue from it: every candidate whose
// status is 'Pending' OR 'Dispatched' (not just Pending — dispatch() in
// lib/queueDispatcher.js does NOT remove a candidate from the ZSET, only
// completeInterview()'s store.remove() does, so a Dispatched candidate still
// belongs in the rebuilt queue) belongs back in, at score = serial + 10*misses
// (matches lib/queueStore.js's enqueue()/recordMiss() scoring exactly).
//
// KNOWN LIMITATION — read before running this for real: this tool cannot
// reconstruct which desk a 'Dispatched' candidate was locked to. The
// candidate-level lock (lock:{candidateId} -> deskId) carries the desk id,
// and Postgres has no desk_id column anywhere to fall back on (confirmed by
// lib/floorStats.js's own comment: "Postgres has no desk_id column anywhere
// — the Redis candidate lock is the only place it lives"). If the lock was
// also lost in the crash, re-adding a Dispatched candidate to the queue makes
// them eligible for redispatch again, which could double-dispatch someone
// who is actually mid-interview at a desk right now. This script does NOT
// attempt to solve that — it only rebuilds queue membership/rank. A human
// needs to reconcile in-progress desk interviews separately (e.g. walk the
// floor / ask desks who they're currently serving) before trusting dispatch
// to behave correctly for those candidates again.
//
// This script intentionally does not touch drain:{companyId} (drain-rate EMA
// — lib/pingLadder.js's MIN_DRAIN_RATE is a safe fallback) or
// pingbuf:{companyId} (ping-buffer tuning — DEFAULT_BETA is a safe fallback):
// losing either is a temporary performance blip, not a correctness issue.
// It also does not touch candidate locks — a lost lock just makes that
// candidate eligible for redispatch, which is the system's existing
// "skip, don't drop" design (lib/queueDispatcher.js), safe by construction.
//
// Usage:
//   node scripts/reconcileQueues.js              # dry run (default) — report only
//   node scripts/reconcileQueues.js --apply       # actually rebuild empty/missing queues
//   node scripts/reconcileQueues.js --apply --force  # also overwrite queues that already have members
require('dotenv').config();
const pool = require('../db');
const redis = require('../lib/redisClient');
const store = require('../lib/queueStore');

const queueKey = (companyId) => `queue:${companyId}`;

// Core logic, importable so a companion script/fixture can call it directly
// instead of shelling out. Returns a per-company report array; does not
// print anything and does not touch process.exit.
async function reconcileQueues({ apply = false, force = false } = {}) {
  const eligibleRes = await pool.query(
    `SELECT ccs.company_id, ccs.candidate_id, ccs.serial, ccs.misses, ccs.status, c.company_name
       FROM candidate_company_status ccs
       JOIN candidates cd ON cd.id = ccs.candidate_id
       JOIN companies c ON c.id = ccs.company_id
      WHERE ccs.status IN ('Pending', 'Dispatched')
        AND ccs.deleted_at IS NULL
        AND cd.deleted_at IS NULL
      ORDER BY ccs.company_id, ccs.serial NULLS LAST, ccs.candidate_id`
  );

  const byCompany = new Map();
  for (const row of eligibleRes.rows) {
    if (!byCompany.has(row.company_id)) {
      byCompany.set(row.company_id, { companyId: row.company_id, companyName: row.company_name, candidates: [] });
    }
    byCompany.get(row.company_id).candidates.push(row);
  }

  const report = [];
  for (const { companyId, companyName, candidates } of byCompany.values()) {
    const existingMembers = await store.queueSize(companyId);
    const dispatchedCount = candidates.filter((c) => c.status === 'Dispatched').length;
    const pendingCount = candidates.length - dispatchedCount;

    const entry = {
      companyId,
      companyName,
      candidateCount: candidates.length,
      pendingCount,
      dispatchedCount,
      existingMembers,
    };

    if (existingMembers > 0 && !force) {
      entry.action = 'skip-healthy-queue';
      report.push(entry);
      continue;
    }

    if (!apply) {
      entry.action = existingMembers > 0 ? 'would-force-overwrite' : 'would-rebuild';
      report.push(entry);
      continue;
    }

    // Clear first so a --force rebuild doesn't leave stale members behind
    // that aren't in the current Pending/Dispatched set (e.g. someone who
    // moved to Selected/Rejected after the last enqueue but before the crash).
    await redis.del(queueKey(companyId));
    for (const c of candidates) {
      const serial = c.serial == null ? 0 : c.serial; // defensive: Pending/Dispatched rows should always have a serial (see registerCandidate.js), only Waitlisted rows don't
      const score = serial + 10 * c.misses;
      await store.enqueue(companyId, c.candidate_id, score);
    }
    entry.action = existingMembers > 0 ? 'force-overwrote' : 'rebuilt';
    report.push(entry);
  }

  return report;
}

function printReport(report, { apply, force }) {
  console.log(`=== reconcileQueues ${apply ? (force ? '(--apply --force)' : '(--apply)') : '(dry run — pass --apply to write)'} ===\n`);
  console.log('KNOWN LIMITATION: cannot reconstruct which desk a Dispatched candidate');
  console.log('was locked to (no desk_id column in Postgres). If the Redis lock was also');
  console.log('lost, rebuilding a Dispatched candidate into the queue makes them eligible');
  console.log('for redispatch, risking a double-dispatch of someone mid-interview right');
  console.log('now. Reconcile in-progress desk interviews by hand before trusting dispatch');
  console.log('for those candidates again.\n');

  if (!report.length) {
    console.log('No companies have Pending/Dispatched candidates — nothing to do.');
    return;
  }

  for (const e of report) {
    console.log(`Company ${e.companyId} (${e.companyName}):`);
    console.log(`  candidates to enqueue: ${e.candidateCount} (${e.pendingCount} Pending, ${e.dispatchedCount} Dispatched)`);
    console.log(`  existing queue members: ${e.existingMembers}`);
    console.log(`  action: ${e.action}`);
    console.log('');
  }

  const summary = report.reduce((acc, e) => {
    acc[e.action] = (acc[e.action] || 0) + 1;
    return acc;
  }, {});
  console.log('--- summary ---');
  for (const [action, count] of Object.entries(summary)) {
    console.log(`  ${action}: ${count} company/companies`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const force = args.includes('--force');

  const report = await reconcileQueues({ apply, force });
  printReport(report, { apply, force });

  await pool.end();
  redis.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('reconcileQueues crashed:', err);
    process.exit(1);
  });
}

module.exports = { reconcileQueues };
