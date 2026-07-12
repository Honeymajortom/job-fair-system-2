# SDC Job Fair Prototype — Integrity Test Report

**Date:** 2026-07-03
**Scope:** `prototype/express-app` (API + worker) and `prototype/react-app` (staff SPA)
**Trigger:** User-reported symptoms — intermittent "request not found," data-fetching failures, and being unexpectedly bounced back to `/login`.

## Summary

Three real bugs were found and fixed. All three share one theme: **transient Redis unavailability or a wrong-role landing page was being mishandled as a hard failure**, when the rest of the codebase is explicitly designed to fail open around Redis. Two are process crashes (the most severe class of bug — they take down every route, not just the Redis-dependent ones), and one is a frontend routing/redirect bug from the previous fix session (documented here for completeness since it produced overlapping symptoms).

A full sweep of every backend route across all five roles (`admin`, `floor_manager`, `registration_staff`, `company_hr`, `volunteer`) plus anonymous found **no route-permission bugs and no 404s** — the permission matrix in `architecture-v3.0.md` is correctly implemented everywhere it was checked.

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Redis outage crashes the entire API process | Critical | **Fixed** |
| 2 | Redis outage crashes the standalone dispatch worker | Critical | **Fixed** |
| 3 | Any `/me` failure (not just a real 401) forces logout | High | **Fixed** |
| 4 | Wrong post-login redirect / missing route guards dropped roles onto screens they can't use | High | **Fixed (prior session)** |
| — | WSL-hosted Redis idles out and needs a manual restart | Operational | Not a code bug — see recommendation |

---

## Finding 1 — Redis outage crashes the whole API (Critical)

**Symptom this explains:** "sometimes request not found" — when this crash happens, *every* endpoint goes from working to `ECONNREFUSED` until someone manually restarts `node server.js`. From the browser this looks like random requests suddenly failing.

**Root cause:** `lib/io.js` wires the Socket.IO Redis adapter using `@socket.io/redis-adapter`. That package's constructor calls `this.subClient.psubscribe(...)` directly (`node_modules/@socket.io/redis-adapter/dist/index.js:99`) without awaiting or `.catch()`-ing the returned promise. If Redis is unreachable when this fires (at boot, or on any reconnect), the `sub` client — configured with `maxRetriesPerRequest: 1` — rejects that promise once retries are exhausted. Nothing in the app was listening for that rejection, so it became an **unhandled promise rejection**, and Node 15+'s default behavior for that is to terminate the process.

The `.on('error', …)` handlers already present on `pub`/`sub` in `io.js` do **not** catch this — those only suppress ioredis's own internal `'error'` events, not rejections from application-level command calls like `psubscribe()`.

This directly contradicts the codebase's own stated design invariant (see comments in `lib/dispatchQueue.js` and `middleware/rateLimit.js`): *"a Redis outage must never turn a successful registration into a 500"* / *"fails OPEN."* In practice it was failing about as hard as possible — taking down the entire server, not just the Redis-touching parts.

**Fix applied** (`server.js`):
```js
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection (contained, not crashing):', reason);
});
```
A single process-level safety net, placed before the app is built. This doesn't touch the vendored adapter package — it just stops one of its known gaps from taking the whole process down, consistent with how every other Redis client in this codebase already behaves.

**Verified:**
1. Stopped WSL Redis, confirmed down (`redis-cli ping` → connection refused).
2. Started `node server.js` fresh against the down Redis — **before the fix this crashed within ~1–2 seconds** (reproduced the user's exact log).
3. After the fix, the same scenario logged `[server] Unhandled rejection (contained, not crashing): MaxRetriesPerRequestError...` twice and **stayed running** for the full test window.
4. Confirmed the server kept serving real traffic while Redis was down: `GET /api/health` → 200, `GET /api/companies` (DB-only) → 200, `POST /api/qr/register` → 401 (correct validation error, not a crash).
5. Restored Redis, confirmed the server reconnects and Redis-backed features (cache, rate limiting, socket events) resume normally.

---

## Finding 2 — Redis outage crashes the standalone dispatch worker (Critical)

**Symptom this explains:** if the BullMQ worker (`npm run worker`) is running when Redis blips, interview-slot dispatching silently stops until someone notices the worker process died and restarts it — candidates would stop getting auto-dispatched/auto-no-showed.

**Root cause:** `workers/slotDispatcher.js` creates its own `ioredis` connection (`maxRetriesPerRequest: null`, required by BullMQ) but — unlike every other Redis client in the codebase — **never attaches an `.on('error', …)` handler to it**. An `EventEmitter` that emits `'error'` with zero listeners throws synchronously and crashes the process; this is a much older/blunter Node behavior than the unhandled-rejection case above; it doesn't depend on Node version.

**Fix applied** (`workers/slotDispatcher.js`):
```js
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
connection.on('error', (err) => console.error('[slot-dispatcher] Redis error:', err.message));
```

**Verified:** Stopped Redis, ran `node workers/slotDispatcher.js` — before the fix it crashed near-instantly; after the fix it logged `[slot-dispatcher] Redis error: ...` repeatedly and stayed alive for the full test window.

---

## Finding 3 — `/me` treats any failure as "not logged in" (High)

**Symptom this explains:** "sometimes thrown back to login page" — this is the direct mechanism. It's aggravated by Findings 1–2: every time the API process restarts or hiccups, any staff member with the page open at that moment gets logged out even though their session cookie is still valid.

**Root cause:** `src/staff/StaffApp.jsx` had:
```js
api.me().then(setUser).catch(() => setUser(null));
```
This treats a genuine `401 Not authenticated` the *same* as a network failure, a `500`, or the API being mid-restart — all of which throw from `api.js`'s `request()` helper. Any of those forces `user = null`, which the router immediately turns into a redirect to `/login`, discarding a perfectly valid session.

**Fix applied** (`StaffApp.jsx`): only a real `401` clears the session now. Any other error retries with exponential backoff (1s → 2s → 4s … capped at 15s) instead of logging the user out, and the loading screen distinguishes "Checking session…" from "Reconnecting to server…" so it's clear what's happening.

**Verified:** Code review + manual reasoning against `middleware/auth.js` (confirms `authenticateJWT` only ever returns 401 for missing/invalid/expired tokens — never for other conditions) — a non-401 error from `/me` can now only mean a transient failure, which is exactly what the new retry logic targets. Recommend also reloading the staff app once with Redis intentionally down to watch it show "Reconnecting…" instead of bouncing to `/login`.

---

## Finding 4 — Wrong post-login landing page / missing route guards (High, fixed earlier this session)

Documented here because it produced symptoms that overlap with what was reported (repeated error toasts, `registration_staff` login looking "broken"). Root cause: `Login.jsx` and `StaffApp.jsx` hardcoded every role's post-login redirect to `/staff/floor`, and nested routes had no per-role guard — only nav *links* were role-filtered. `company_hr`, `volunteer`, and `registration_staff` all landed on Floor Monitor, which unconditionally polls `GET /api/stats` (admin/floor_manager only) every 30s, producing a repeating 403 toast.

**Fix:** `NAV_LINKS` is now the single source of truth for both nav visibility and route access (`Gate` component wraps every `/staff/*` route); `roleHome(role)` computes each role's correct landing page and drives the post-login redirect and all catch-alls.

---

## Full permission-matrix sweep (for the record)

Every GET endpoint was hit as `admin`, `floor_manager`, `registration_staff`, `company_hr`, `volunteer`, and anonymous (disposable QA accounts created and deleted for this test). All results matched the documented permission matrix exactly — no unexpected 403/404/500s:

- Anonymous → 401 on every authenticated route, as expected.
- `admin` → 200 on everything.
- `floor_manager` → 200 on `/stats`, `/queue/:id`, `/companies*`, `/batches`, `/slots*`, `/candidates/:token`; 403 on `/fair-settings`, `/users`, all `/reports/*`-style endpoints, `/qr/token` — correct.
- `registration_staff` → 200 on `/companies*`, `/batches`, `/slots*`, `/candidates/:token`; 403 on `/queue/:id`, `/stats`, everything admin-only — correct.
- `company_hr` → 200 on `/companies*`, `/queue/:id`, `/batches`, `/slots*`, `/candidates/:token`; 403 elsewhere — correct.
- `volunteer` → same shape as `registration_staff`/`company_hr` minus `/queue`; 403 elsewhere — correct.

Also spot-checked: public `/api/qr/companies`, `/api/qr/schedule/:token`, `/api/health` all return 200 anonymously as designed; Vite's dev server SPA fallback (`appType: 'spa'`, default) means a hard refresh on a nested staff route does not 404.

**No route-path mismatches** were found between `react-app/src/api.js` and the backend route tables — every frontend call has a matching backend route.

---

## Operational note — WSL Redis idling (not a code bug)

During this test, the WSL-hosted Redis instance stopped on its own **twice** mid-session with no explicit `service redis-server stop` from me — consistent with the CLAUDE.md note that "the WSL VM idles out." This is the most common real-world trigger for Findings 1–2 in this environment (not a production concern once Redis runs somewhere durable). Two options if this keeps interrupting dev sessions:

1. Keep using `prototype/start-all.bat` (already set up) — it polls `redis-cli ping` until Redis actually answers before starting the API/worker/web servers, which sidesteps the race but not the underlying idling.
2. For a more permanent fix, consider running Redis via Docker Desktop or WSL with `systemd` + a scheduled keep-alive, so it doesn't depend on an interactive WSL session staying open.

Either way, Findings 1–2 mean **even if Redis idles out again, the API and worker will no longer crash** — they'll log errors and keep serving DB-backed traffic until Redis comes back.

## Files changed

- `prototype/express-app/server.js` — process-level `unhandledRejection` guard
- `prototype/express-app/workers/slotDispatcher.js` — `.on('error')` handler on the BullMQ connection
- `prototype/react-app/src/staff/StaffApp.jsx` — `/me` failure handling now distinguishes 401 from transient errors, with backoff retry
- `prototype/react-app/src/staff/StaffApp.jsx`, `Login.jsx` — role-aware landing page + per-route guards (prior fix, included for context)

---

# Integrity report — 2026-07-12 (Phase 5 / four-tab admin rebuild)

Scope: everything built this session — the Staff, Companies, Reports, and Floor admin tabs, plus the Phase 5 backend (`lib/floorStats.js`, `GET /api/floor-stats`, `GET /api/candidates`'s `registered_at` fix). Method: re-verify from scratch rather than trust the session's own running commentary — reread every claimed file, rerun every fixture (including ones this session didn't touch, to catch regressions), run a real production build, check both git repos and both datastores for drift/leftovers, and cross-check `CLAUDE.md` against the actual route surface.

## Result: no regressions, no data-integrity problems, two real (now-fixed) cleanup gaps, one stale claim in my own handoff notes, one pre-existing documentation gap.

### 1. File/route existence — all claims confirmed correct

Every file claimed built this session exists with the expected content: `lib/floorStats.js`, `lib/csv.js`, `routes/queue.js`'s `GET /floor-stats`, `routes/candidates.js`'s `registered_at` fix, `routes/companies.js`'s posts/rating-parameter routes, `routes/reports.js`'s six `?format=csv` branches, `db/schema.sql`'s `company_posts` table, and all four `.jsx` tabs (`UserAdmin`, `CompanyManagement`, `Reports`, `FloorMonitor`) wired into `StaffApp.jsx`. No missing files, no phantom claims.

**One small drift found in `schema.sql` itself**: its own top-of-file comment still lists `company_posts` under "Still to come" (line 6), even though the table was added further down (line 219) this session. Cosmetic — the table works — but worth a one-line fix next time that file is touched.

### 2. All fixtures rerun — 73/73 assertions pass, zero regressions

Reran every fixture in `scripts/`, not just the new one, specifically to catch anything this session's changes might have broken elsewhere:

| Fixture | Phase | Result |
|---|---|---|
| `queueDispatcherFixture.js` | 1 | 14/14 |
| `registrationCapacityFixture.js` | 2 | 9/9 |
| `deskTabletFixture.js` | 3 | 16/16 |
| `phase4PositionFixture.js` | 4 | 23/23 |
| `floorStatsFixture.js` | 5 (new) | 11/11 |

**One transient failure investigated and resolved as a known non-issue, not a regression**: running `phase4PositionFixture.js` twice back-to-back (as part of this re-verification) produced one failure — `GET /api/qr/companies carries a live queue_depth` — on the second run only. Root cause: that endpoint is deliberately response-cached for 60s (`CLAUDE.md`'s documented behavior), so a second run inside that window sees the first run's stale `queue_depth`. Waited past the cache window and reran: 23/23 clean. This is a pre-existing characteristic of that fixture (unrelated to anything built this session) worth knowing if anyone else hits it, not a code defect.

### 3. Production build — clean

`npm run build` in `react-app`: 500 modules, no errors, no warnings. Staff chunk (lazy) is 32.8KB / 7.3KB gzipped — grown from the ~20KB noted in `CLAUDE.md` as expected, now that it carries four full admin tabs instead of one.

### 4. Orphaned test data — two real leftovers found and removed

Checked Postgres and Redis for anything this session's verification scripts should have cleaned up but didn't:

- **Redis**: clean. No leftover `__test*`/`lock:*` keys; `queue:*`/`drain:*` entries present are real (companies 1 and 4), not test artifacts.
- **Postgres — two genuine orphans, now deleted**: a Playwright verification script for the Floor tab crashed partway through an earlier debugging iteration (a since-fixed selector bug), which meant its cleanup step never ran for that specific run. Left behind: one candidate row (`A-146`, "Floor Socket Test") and two temporary staff accounts (`pw_floor_…`, `pw_hr_…`, floor_manager/company_hr roles). None of these were real data — deleted directly. (A second, similarly-named candidate from the *successful* rerun, `A-147`, had correctly gone through the app's own soft-delete — confirmed `deleted_at` was set, so it's properly hidden from every real read path; left as-is, that one was never a problem.)
- Older test-looking candidates (`A-1`, `A-2`, "Test Candidate", "Stage Two Test", etc.) predate this session by over a week — not something introduced now, not touched.

### 5. Git — both repos verified directly, one stale claim in my own reporting caught

- **`prototype/`**: has two commits beyond what I knew about when I wrote my last summary — `1e86d44 "Reports tab updated"` and `2d23152 "Floor tab added"`, both authored by the user. Diffed both against what was actually built: contents match exactly (Reports commit: `lib/csv.js`, `routes/reports.js`, `Reports.jsx`, `StaffApp.jsx` nav wiring; Floor commit: `lib/floorStats.js`, `routes/queue.js`, `routes/candidates.js`, `scripts/floorStatsFixture.js`, `FloorMonitor.jsx`, CSS, nav wiring, plus `commit.bat`). **This means my closing summary in this session ("Nothing committed") was already wrong at the moment I said it** — the user had committed in parallel, in a window I didn't check before reporting. `handoff.md` has been corrected to stop claiming Phase 5 is uncommitted.
- **root repo**: confirmed still genuinely uncommitted (single initial commit, same as before) — `.gitignore`/`CLAUDE.md`/`handoff.md`/`docs/`/`sim/` are staged but not committed, plus an untracked `commit.bat`. No surprises here.
- **Secrets**: `express-app/.env` still correctly gitignored. Grepped every new file from this session for hardcoded passwords/secrets — none found.

### 6. `CLAUDE.md`'s "Routes implemented" list — confirmed stale, but not a new problem

Cross-checked `CLAUDE.md`'s route inventory (companies.js/queue.js/reports.js sections) against the actual route files: it only reflects the original six-stage v1/v3.0 build and has never been updated for *any* of the queue-system rollout (Phases 1–5) or the four-tab admin rebuild — not the `/api/queue/desk/next`/`confirm-arrival` routes from Phase 3, not `/api/floor-stats`, not the `company_posts` routes, not `?format=csv`. This predates this session (it's been drifting since Phase 1, 2026-07-11) — today's work adds three more routes to the gap rather than creating it. `handoff.md` has been the accurate source of truth for this work all along; `CLAUDE.md`'s route list can no longer be trusted in isolation for anything past the original six stages.

## Bottom line

Everything built and claimed this session is real, working, and matches what's on disk — verified independently, not just re-read from prior summaries. Two genuine (now-fixed) cleanup gaps in test data, one now-corrected stale claim in `handoff.md` about commit state, and one confirmed-benign flaky-fixture false alarm chased down to its actual cause. No code regressions anywhere in the five-fixture, 73-assertion suite, and the production build is clean.
