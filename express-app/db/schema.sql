-- SDC Job Fair — prototype schema
-- Subset of the full architecture (see SDC_JobFair_Architecture.md):
-- stage 1 proved the core registration -> interview -> result loop;
-- stage 2 adds fair_settings/fair_batches, users/auth and soft-delete;
-- stage 3 adds checkin_sig (HMAC QR), per-candidate check-in and Dispatched status.
-- company_posts (once listed here as "still to come") is done, further down
-- this file. "fair_date scoping columns (fix #8)" is underway, not finished —
-- Phase 0 of fair_cycle_isolation_plan.md added the Center concept fair_date
-- scoping sits on top of; candidates itself gets its own fair-cycle key
-- (fair_settings_id) in that plan's Phase 1, not yet done as of this comment.

CREATE SEQUENCE IF NOT EXISTS token_seq START 1;

CREATE TABLE IF NOT EXISTS companies (
  id                 SERIAL PRIMARY KEY,
  company_name       VARCHAR NOT NULL UNIQUE,
  description        TEXT,
  location           VARCHAR,
  field              VARCHAR,
  job_type           VARCHAR,
  min_qualification  VARCHAR,
  max_qualification  VARCHAR,
  max_queue_limit    INTEGER NOT NULL DEFAULT 7,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rating_parameters (
  id              SERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parameter_name  VARCHAR NOT NULL,
  display_order   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS interview_slots (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  slot_start        TIMESTAMPTZ NOT NULL,
  duration_minutes  INTEGER NOT NULL DEFAULT 15,
  capacity          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS candidates (
  id                 SERIAL PRIMARY KEY,
  token_no           VARCHAR NOT NULL UNIQUE,
  name               VARCHAR NOT NULL,
  mobile             VARCHAR,
  age                INTEGER,
  qualification      VARCHAR,
  field              VARCHAR,
  employment_status  VARCHAR NOT NULL DEFAULT 'Fresher'
    CHECK (employment_status IN ('Studying', 'Working', 'Fresher', 'Other')),
  registered_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_mobile
  ON candidates(mobile)
  WHERE mobile IS NOT NULL AND mobile != '';

CREATE TABLE IF NOT EXISTS candidate_company_status (
  id              SERIAL PRIMARY KEY,
  candidate_id    INTEGER NOT NULL REFERENCES candidates(id) ON DELETE RESTRICT,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  slot_id         INTEGER REFERENCES interview_slots(id) ON DELETE RESTRICT,
  status          VARCHAR NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Pending', 'Selected', 'Rejected', 'Shortlisted', 'Hold', 'No_Show')),
  ratings         JSONB,
  feedback_text   TEXT,
  processed_at    TIMESTAMPTZ,
  UNIQUE (candidate_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_ccs_company_status
  ON candidate_company_status(company_id, status);

CREATE INDEX IF NOT EXISTS idx_slots_company_start
  ON interview_slots(company_id, slot_start);

-- ---------------------------------------------------------------------------
-- Stage 2: fair configuration, arrival batches, staff accounts, soft-delete
-- (schema carried over from SDC_JobFair_Architecture.md §4 per v3.0 §0)
-- ---------------------------------------------------------------------------

-- Fair-level configuration
CREATE TABLE IF NOT EXISTS fair_settings (
  id                           SERIAL PRIMARY KEY,
  fair_name                    VARCHAR NOT NULL,
  fair_date                    DATE NOT NULL UNIQUE,
  max_companies_per_candidate  INTEGER NOT NULL DEFAULT 3,
  slot_duration_minutes        INTEGER NOT NULL DEFAULT 15,
  batch_size                   INTEGER NOT NULL DEFAULT 25,   -- candidates per arrival wave
  batch_interval_minutes       INTEGER NOT NULL DEFAULT 15,   -- minutes between waves
  is_active                    BOOLEAN NOT NULL DEFAULT false,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one active fair at a time — every "current fair" read (registerCandidate.js,
-- floorStats.js, public.js, slots.js) resolves ties with ORDER BY fair_date DESC LIMIT 1,
-- which silently picks the wrong row if two are ever active with mismatched fair_batches.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fair_settings_one_active
  ON fair_settings (is_active) WHERE is_active = true;

-- Batch schedule (auto-generated from fair_settings before the fair)
CREATE TABLE IF NOT EXISTS fair_batches (
  id            SERIAL PRIMARY KEY,
  fair_date     DATE NOT NULL REFERENCES fair_settings(fair_date) ON DELETE CASCADE,
  batch_number  INTEGER NOT NULL,
  arrival_time  TIMESTAMPTZ NOT NULL,
  capacity      INTEGER NOT NULL DEFAULT 25,     -- mirrors fair_settings.batch_size
  checked_in    INTEGER NOT NULL DEFAULT 0,
  status        VARCHAR NOT NULL DEFAULT 'upcoming'
    CHECK (status IN ('upcoming', 'active', 'closed')),
  UNIQUE (fair_date, batch_number)
);

-- Staff accounts
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  username       VARCHAR NOT NULL UNIQUE,
  password_hash  VARCHAR NOT NULL,
  role           VARCHAR NOT NULL
    CHECK (role IN ('admin', 'registration_staff', 'floor_manager', 'company_hr', 'volunteer')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Soft-delete (integrity fix #10): while a fair is live (fair_settings.is_active)
-- deletes only set deleted_at; hard deletes are allowed post-fair.
-- All reads filter WHERE deleted_at IS NULL.
-- batch_id: which arrival wave a candidate belongs to (assignment lands in stage 3).
-- feedback_by: which staff user recorded the interview result.
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS batch_id INTEGER REFERENCES fair_batches(id) ON DELETE RESTRICT;

-- Red-team finding H2: JWTs were otherwise non-revocable for their full 8h
-- life. Bumped on logout and on any admin password reset (routes/auth.js,
-- routes/users.js); authenticateJWT rejects any token whose embedded `tv`
-- no longer matches.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- Red-team finding H3: company_hr accounts had no company boundary — any HR
-- credential could act on any company's queue. NULL for non-company_hr roles.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);

ALTER TABLE candidate_company_status
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS feedback_by INTEGER REFERENCES users(id);

-- ---------------------------------------------------------------------------
-- Stage 3: QR check-in signature, per-candidate check-in, dispatch status
-- ---------------------------------------------------------------------------

-- checkin_sig (v3.0 §6): HMAC(token_no, SERVER_SECRET), set at registration.
-- The schedule card QR encodes "{token_no}.{checkin_sig}"; the gate recomputes
-- the HMAC — a forged QR fails without a DB pattern change.
-- checked_in_at: per-candidate gate state. Not in the v2.5 column list, but the
-- v3.0 dispatcher guard ("AND EXISTS (checked-in test)") requires it — the
-- fair_batches.checked_in counter alone can't answer "did THIS candidate arrive".
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS checkin_sig VARCHAR,
  ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ DEFAULT NULL;

-- 'Dispatched' joins the status enum (v2.5 §4 always had it; the stage 1
-- prototype omitted it because nothing dispatched yet). Drop + re-add is the
-- idempotent way to widen an inline CHECK.
ALTER TABLE candidate_company_status
  DROP CONSTRAINT IF EXISTS candidate_company_status_status_check;
ALTER TABLE candidate_company_status
  ADD CONSTRAINT candidate_company_status_status_check
  CHECK (status IN ('Pending', 'Dispatched', 'Selected', 'Rejected', 'Shortlisted', 'Hold', 'No_Show'));

-- ---------------------------------------------------------------------------
-- Queue-system Phase 1 (new_architecture.md — count-based virtual queue):
-- Redis (queue:{companyId} ZSET) is the live dispatch authority; these columns
-- are Postgres's durable copy of what seeded that ZSET and why its score
-- moved, so a Redis flush/restart or a report can reconstruct queue state.
-- serial: booking-order rank within this company (score before any misses).
-- misses: missed-call count: each miss adds 10 to the ZSET score (rank decay,
-- new_architecture.md §3.4) without dropping the candidate from the queue.
-- interview_slots / slot_id are untouched here — still read by the v1 routes
-- until the Phase 6 cutover retires them.
-- ---------------------------------------------------------------------------
ALTER TABLE candidate_company_status
  ADD COLUMN IF NOT EXISTS serial INTEGER,
  ADD COLUMN IF NOT EXISTS misses INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Queue-system Phase 2 (booking cap, new_architecture.md §3.1/§4):
-- capacity_j = seats * (60/interview_minutes) * fair_hours; cap_sold = 0.9 *
-- capacity_j. seats/interview_minutes are per company (c_j, service rate);
-- fair_hours is fair-wide (H). Defaults (1 seat, 6-min interviews, 8h fair)
-- match sim/jobfair_sim.py's defaults so an unconfigured company behaves like
-- the simulation's baseline rather than an arbitrary guess.
-- 'Waitlisted' joins the status enum: a pick that loses the capacity gate is
-- still recorded (Phase 5's standby/fall-through tier needs this as real
-- inventory, not a silently dropped request) but never reaches the live
-- Redis queue — no serial, no dispatch.
-- ---------------------------------------------------------------------------
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS seats INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS interview_minutes INTEGER NOT NULL DEFAULT 6;

-- Red-team L3: an admin-supplied interview_minutes of 0 fed
-- registerCandidate.js's `60 / interview_minutes` booking-cap divisor
-- (Infinity/NaN), silently disabling the per-company capacity gate.
ALTER TABLE companies
  DROP CONSTRAINT IF EXISTS companies_interview_minutes_positive;
ALTER TABLE companies
  ADD CONSTRAINT companies_interview_minutes_positive CHECK (interview_minutes > 0);

ALTER TABLE fair_settings
  ADD COLUMN IF NOT EXISTS fair_hours NUMERIC NOT NULL DEFAULT 8;

ALTER TABLE candidate_company_status
  DROP CONSTRAINT IF EXISTS candidate_company_status_status_check;
ALTER TABLE candidate_company_status
  ADD CONSTRAINT candidate_company_status_status_check
  CHECK (status IN ('Pending', 'Waitlisted', 'Dispatched', 'Selected', 'Rejected', 'Shortlisted', 'Hold', 'No_Show'));

-- ---------------------------------------------------------------------------
-- Queue-system Phase 3 (desk tablet + no-show timer, new_architecture.md §3.4/§6.1):
-- dispatched_at: set the moment dispatch() locks a candidate to a desk. Two
-- consumers — the no-show timer's location-aware duration is armed relative
-- to it, and completeInterview()'s drain-rate EMA needs an actual interview
-- duration (now() - dispatched_at) rather than a guessed constant.
-- ---------------------------------------------------------------------------
ALTER TABLE candidate_company_status
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- Queue-system Phase 4 (ping ladder + live position page, new_architecture.md §3.3/§4):
-- travel_time_minutes: candidate-reported travel time to venue, captured at
-- registration. Feeds the "come now" threshold (ETA <= travel_time + 15min) —
-- nullable because existing/unset candidates just skip straight to the "far"
-- rung instead of ever reaching "warm".
-- ---------------------------------------------------------------------------
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS travel_time_minutes SMALLINT;

-- ---------------------------------------------------------------------------
-- Insights dashboard (new_architecture_uiux_spec.html-adjacent admin tab):
-- gender and SDC-program membership, captured at registration alongside the
-- existing demographic fields. Both nullable — candidates registered before
-- this migration have no way to backfill either, so they report as "Unknown"
-- rather than a guessed default.
-- ---------------------------------------------------------------------------
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS gender VARCHAR CHECK (gender IN ('Male', 'Female', 'Other')),
  ADD COLUMN IF NOT EXISTS is_sdc BOOLEAN;

-- ---------------------------------------------------------------------------
-- Desk tablet: explicit "interview started" step, distinct from dispatched_at
-- (called to the desk) and processed_at (result recorded). Closes a real gap:
-- without this, the no-show timer (armed at dispatch, 90s/180s) had no way to
-- learn a candidate actually arrived except the interview finishing outright
-- — any interview running longer than the timer would incorrectly no-show a
-- candidate mid-interview. Also improves completeInterview()'s drain-rate EMA,
-- which previously measured dispatched_at -> result (walk-over time included)
-- instead of the real interview duration.
-- ---------------------------------------------------------------------------
ALTER TABLE candidate_company_status
  ADD COLUMN IF NOT EXISTS interview_started_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- Resume PDF upload (handoff.md's build-ready design, picked up 2026-07-15).
-- One nullable timestamp, not a separate boolean — doubles as an existence
-- flag (IS NOT NULL) and metadata, same idiom as checked_in_at/dispatched_at.
-- No path column: the file lives at uploads/resumes/{token_no}.pdf, derived
-- from the candidate's own server-generated, already-unique token.
-- ---------------------------------------------------------------------------
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS resume_uploaded_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- Floor number (distinct from the free-text `location`, e.g. "Hall B Desk 2"):
-- a plain integer so it can actually be compared, not just displayed. Feeds
-- lib/queueDispatcher.js's same-floor/cross-floor no-show timer (§6.1's 90s/
-- 180s) — before this, nothing tracked which floor a company was on, so
-- every timer armed at the same-floor duration regardless (see noShowTimer.js's
-- former floor-awareness note). Nullable: a company with no floor set is
-- treated as unknown and still defaults to same-floor, matching prior behavior.
-- ---------------------------------------------------------------------------
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS floor_number INTEGER;

-- Ground floor is 0, not 1 — no negative floors. Same drop-then-add idiom as
-- companies_interview_minutes_positive above, for the same reason: an inline
-- CHECK can't be widened/added in place, only replaced.
ALTER TABLE companies
  DROP CONSTRAINT IF EXISTS companies_floor_number_nonnegative;
ALTER TABLE companies
  ADD CONSTRAINT companies_floor_number_nonnegative CHECK (floor_number >= 0);

-- ---------------------------------------------------------------------------
-- Company Management (new_architecture_uiux_spec.html §07): vacancy tracking.
-- Migrated from old/SDC_JobFair_Architecture.md's v2.5 company_posts design —
-- a company can advertise multiple named postings, each with its own vacancy
-- count and qualification/gender/age filter, rather than one aggregate count.
-- Informational only: unrelated to the queue-system capacity gate (companies
-- .seats/.interview_minutes), which stays the sole source of the booking cap.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_posts (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  post_title     VARCHAR NOT NULL,
  vacancies      INTEGER NOT NULL DEFAULT 1,
  qualification  VARCHAR,
  gender         VARCHAR,
  age_min        INTEGER,
  age_max        INTEGER
);

-- ---------------------------------------------------------------------------
-- Post-fair candidate feedback: star ratings on the venue experience + SDC
-- program interest, shown on LivePosition once every one of a candidate's
-- bookings has settled (Selected/Rejected/Shortlisted/Hold/No_Show).
-- candidate_id is ON DELETE SET NULL (not CASCADE) so a submitted row
-- outlives the post-fair hard-delete cleanup (routes/candidates.js DELETE) —
-- mobile is kept alongside for that same reason. UNIQUE(candidate_id) makes
-- submission an upsert (ON CONFLICT), so correcting a misclick doesn't need
-- staff help; Postgres allows unlimited NULLs under a UNIQUE constraint, so
-- hard-deleted rows don't collide with each other.
-- NOTE: candidates aren't fair-scoped yet (this file's own header has flagged
-- "fair_date scoping columns (fix #8)" as not-yet-built since stage 2), so
-- registerCandidate.js's duplicate-mobile check below can only see as far
-- back as the last hard-delete cleanup, not a true cross-fair history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS candidate_feedback (
  id                 SERIAL PRIMARY KEY,
  candidate_id       INTEGER UNIQUE REFERENCES candidates(id) ON DELETE SET NULL,
  mobile             VARCHAR NOT NULL,
  venue_rating       SMALLINT NOT NULL CHECK (venue_rating BETWEEN 1 AND 5),
  process_rating     SMALLINT NOT NULL CHECK (process_rating BETWEEN 1 AND 5),
  staff_rating       SMALLINT NOT NULL CHECK (staff_rating BETWEEN 1 AND 5),
  overall_rating     SMALLINT NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),
  interested_in_sdc  BOOLEAN NOT NULL,
  submitted_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Desk-open signal: candidates should only ever see a company on the
-- registration tiles (GET /qr/companies) if someone is actually going to be
-- there to interview them — before this, a company was visible the instant it
-- was created, with no way to represent "registered for the fair but not
-- running desks yet/today." Defaults to false: a freshly created company (or
-- one nobody has opened yet this morning) shows to nobody, matching "no
-- companies open yet" rather than "every company, whether staffed or not."
-- Admin toggles it from the Companies tab; company_hr toggles their own
-- company's from the Desk tablet (PUT /companies/:id/open-status, company-
-- scoped the same way requireCompanyScope already confines company_hr
-- elsewhere). Existing companies will need a one-time manual open after this
-- migration runs — see CLAUDE.md.
-- ---------------------------------------------------------------------------
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS is_open BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Waiting rooms, per floor (superseded the single fair-wide waiting_room_
-- location/floor_number on fair_settings the same day it shipped — floors
-- turned out to matter after all: a candidate waiting for a company on
-- Floor 2 shouldn't be told to sit in a Floor 1 waiting room). One row per
-- floor that has a waiting room; a floor with no row just has no configured
-- location yet (candidates still get told which floor, just not a specific
-- room). floor_number is the natural key — there's exactly one waiting room
-- per floor, matched against companies.floor_number.
-- ---------------------------------------------------------------------------
ALTER TABLE fair_settings
  DROP COLUMN IF EXISTS waiting_room_location,
  DROP COLUMN IF EXISTS waiting_room_floor_number;

CREATE TABLE IF NOT EXISTS waiting_rooms (
  floor_number  INTEGER PRIMARY KEY CHECK (floor_number >= 0),
  location      VARCHAR NOT NULL
);

-- ---------------------------------------------------------------------------
-- Center — fair_cycle_isolation_plan.md Phase 0. The org runs multiple
-- physical Centers, each arranging its own multiple fair cycles over time —
-- concurrently, not one at a time system-wide. That concurrency requirement
-- is why this isn't just a new column: fair_settings.fair_date being
-- globally UNIQUE and uq_fair_settings_one_active being a system-wide
-- partial index (both pre-existing) directly forbid two centers each having
-- their own active fair, so both are loosened to per-center here.
--
-- One row seeded up front ("Main Center") so every pre-existing company/
-- fair_settings/user/waiting_room can backfill straight to it — real
-- multi-center support (a picker, more rows, request-scoped resolution) is
-- Phase 4's UI work, not this migration's job. Every place that still
-- resolves "the active fair" via a bare `WHERE is_active = true` (without a
-- center_id filter) is unaffected in practice as long as only one center
-- exists; those callsites become genuinely ambiguous the moment a second
-- center is created, which Phase 4 is responsible for fixing, not this pass.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS centers (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR NOT NULL UNIQUE,
  location    VARCHAR,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO centers (name) VALUES ('Main Center') ON CONFLICT (name) DO NOTHING;

-- Dropped up front, before fair_settings' own fair_date unique constraint
-- below — Postgres refuses to drop a UNIQUE constraint while a foreign key
-- still depends on it, and fair_batches_fair_date_fkey (added in stage 2)
-- references exactly that constraint.
ALTER TABLE fair_batches DROP CONSTRAINT IF EXISTS fair_batches_fair_date_fkey;

-- DEFAULT 1 (not a subquery — Postgres column defaults can't contain one):
-- 'Main Center' is the very first row this migration ever inserts into a
-- brand-new `centers` table, so its id is always 1 on a fresh run. Lets any
-- INSERT that doesn't mention center_id (fixtures, older code, curl) keep
-- working unchanged rather than needing every callsite updated by hand; real
-- multi-center callers pass an explicit center_id and this default never
-- applies to them.
ALTER TABLE fair_settings ADD COLUMN IF NOT EXISTS center_id INTEGER REFERENCES centers(id);
UPDATE fair_settings SET center_id = (SELECT id FROM centers WHERE name = 'Main Center') WHERE center_id IS NULL;
ALTER TABLE fair_settings ALTER COLUMN center_id SET NOT NULL;
ALTER TABLE fair_settings ALTER COLUMN center_id SET DEFAULT 1;

-- fair_date alone was globally UNIQUE (one fair per date, system-wide) —
-- replaced with UNIQUE(center_id, fair_date) so two centers can share a
-- date; a center still can't double-book itself on one.
ALTER TABLE fair_settings DROP CONSTRAINT IF EXISTS fair_settings_fair_date_key;
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS — db/migrate.js reruns this
-- whole file every time (no migration-tracking table), so the new
-- constraint's own name needs the same drop-then-add idempotency guard
-- every ADD COLUMN above already gets for free from IF NOT EXISTS.
ALTER TABLE fair_settings DROP CONSTRAINT IF EXISTS fair_settings_center_fair_date_key;
ALTER TABLE fair_settings ADD CONSTRAINT fair_settings_center_fair_date_key UNIQUE (center_id, fair_date);

-- uq_fair_settings_one_active was "at most one active fair, period" — now
-- "at most one active fair per center."
DROP INDEX IF EXISTS uq_fair_settings_one_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fair_settings_one_active_per_center
  ON fair_settings (center_id) WHERE is_active = true;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS center_id INTEGER REFERENCES centers(id);
UPDATE companies SET center_id = (SELECT id FROM centers WHERE name = 'Main Center') WHERE center_id IS NULL;
ALTER TABLE companies ALTER COLUMN center_id SET NOT NULL;
ALTER TABLE companies ALTER COLUMN center_id SET DEFAULT 1;

-- Nullable — NULL is only ever valid for role='admin' (unscoped, sees every
-- center); every non-admin role gets a real center_id. Enforced at the
-- application layer (routes/users.js), same convention company_id already
-- uses for company_hr — not a DB CHECK. Application-layer enforcement (the
-- Users-tab form requiring a Center picker) is Phase 4's job; this column
-- only exists so Phase 4 has somewhere to write to.
ALTER TABLE users ADD COLUMN IF NOT EXISTS center_id INTEGER REFERENCES centers(id);
UPDATE users SET center_id = (SELECT id FROM centers WHERE name = 'Main Center') WHERE center_id IS NULL AND role != 'admin';

-- fair_batches previously keyed off fair_date (a bare DATE, referencing
-- fair_settings.fair_date) — now that fair_date alone isn't unique, that FK
-- can no longer identify one fair (its constraint was already dropped up
-- front, above, before fair_settings' own fair_date uniqueness was touched).
-- fair_date itself is kept as a plain, unconstrained column (display/legacy
-- convenience, same "kept not dropped" convention interview_slots/slot_id
-- got during the queue-system cutover) — fair_settings_id is the new
-- authoritative link.
ALTER TABLE fair_batches ADD COLUMN IF NOT EXISTS fair_settings_id INTEGER REFERENCES fair_settings(id);
UPDATE fair_batches fb SET fair_settings_id = fs.id
  FROM fair_settings fs WHERE fb.fair_date = fs.fair_date AND fb.fair_settings_id IS NULL;
ALTER TABLE fair_batches ALTER COLUMN fair_settings_id SET NOT NULL;

-- UNIQUE(fair_date, batch_number) had the same latent bug as the FK above —
-- two centers sharing a date could collide on batch_number. Rescoped to the
-- real fair row.
ALTER TABLE fair_batches DROP CONSTRAINT IF EXISTS fair_batches_fair_date_batch_number_key;
ALTER TABLE fair_batches DROP CONSTRAINT IF EXISTS fair_batches_fair_settings_batch_number_key;
ALTER TABLE fair_batches ADD CONSTRAINT fair_batches_fair_settings_batch_number_key UNIQUE (fair_settings_id, batch_number);

-- waiting_rooms' natural key was floor_number alone — meaningless once two
-- centers can each have their own "Floor 2." Composite PK matches each
-- floor to its own building.
ALTER TABLE waiting_rooms ADD COLUMN IF NOT EXISTS center_id INTEGER REFERENCES centers(id);
UPDATE waiting_rooms SET center_id = (SELECT id FROM centers WHERE name = 'Main Center') WHERE center_id IS NULL;
ALTER TABLE waiting_rooms ALTER COLUMN center_id SET NOT NULL;
ALTER TABLE waiting_rooms ALTER COLUMN center_id SET DEFAULT 1;
ALTER TABLE waiting_rooms DROP CONSTRAINT IF EXISTS waiting_rooms_pkey;
ALTER TABLE waiting_rooms ADD CONSTRAINT waiting_rooms_pkey PRIMARY KEY (center_id, floor_number);

-- ---------------------------------------------------------------------------
-- fair_cycle_isolation_plan.md Phase 1 — candidates get a real fair-cycle
-- key. Previously the only path back to "which cycle (and center) does this
-- candidate belong to" was indirect: candidates.batch_id -> fair_batches.id
-- -> fair_batches.fair_settings_id (itself only added in Phase 0). That
-- chain breaks for any candidate with no batch (no active fair at
-- registration time, or a future no-batch flow) — fair_settings_id is a
-- direct link instead.
--
-- Nullable, same as batch_id itself — a candidate registered with no active
-- fair configured (the prototype-friendly fallback lib/registerCandidate.js
-- already has) still gets created, just with no fair-cycle key, same as it
-- gets no batch today.
-- ---------------------------------------------------------------------------
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS fair_settings_id INTEGER REFERENCES fair_settings(id);
UPDATE candidates c SET fair_settings_id = fb.fair_settings_id
  FROM fair_batches fb WHERE c.batch_id = fb.id AND c.fair_settings_id IS NULL;

-- ---------------------------------------------------------------------------
-- fair_cycle_isolation_plan.md Phase 2 — scope the mobile-dedup guard to the
-- fair cycle instead of blocking a repeat mobile forever. idx_candidates_
-- mobile (defined near the top of this file, before fair_settings_id
-- existed — can't be edited in place, the column it needs to reference
-- didn't exist yet at that point in the script) is dropped and recreated
-- here as a composite. Postgres's default unique-index semantics treat every
-- NULL as distinct from every other NULL, so two candidates with the same
-- mobile and both a NULL fair_settings_id (the no-active-fair edge case)
-- don't violate this index — lib/registerCandidate.js's own dedup check
-- (IS NOT DISTINCT FROM) is what actually catches that one case; real
-- operation always has an active fair, so it's a prototype-only gap, not a
-- production one.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_candidates_mobile;
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_mobile
  ON candidates(mobile, fair_settings_id)
  WHERE mobile IS NOT NULL AND mobile != '';

-- ---------------------------------------------------------------------------
-- Candidate's own per-company interest, asked on LivePosition once every
-- booking is done — independent of ratings/feedback_text above (staff's
-- rating OF the candidate) and of candidate_feedback (one fair-wide row).
-- Lives on this table rather than a new one since it's exactly the same
-- shape of fact as ratings/feedback_text: one per (candidate, company)
-- booking, sharing that row's lifecycle.
-- ---------------------------------------------------------------------------
ALTER TABLE candidate_company_status
  ADD COLUMN IF NOT EXISTS candidate_interested BOOLEAN;

-- ---------------------------------------------------------------------------
-- company_roster_plan.md — companies become a permanent, reusable per-Center
-- directory (create once, name never collides again); each fair cycle
-- explicitly opts a directory company in via its own roster row carrying
-- that cycle's operational values (seats/interview_minutes/floor_number/
-- is_open — the fields describing *today's* staffing, not the company's
-- permanent identity). Root cause fixed: companies.company_name was never
-- reset between fair cycles, unlike candidates (POST /fair-settings/:id/
-- archive already purges those) — re-entering a company for a new cycle
-- collided with the same-named row from a previous cycle that never went
-- away.
--
-- companies.seats/interview_minutes/floor_number/is_open/max_queue_limit are
-- deliberately left physically in place, unread by app code after this
-- lands — a passive rollback safety net until a full live fair cycle has run
-- on the roster path (see company_roster_plan.md's "Explicitly deferred").
-- ---------------------------------------------------------------------------

-- Rescope company_name uniqueness from global to per-Center — a company can
-- now share a name with one at a different Center (previously impossible),
-- and is no longer permanently burned at one Center once real archival/reuse
-- happens.
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_company_name_key;
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_center_company_name_key;
ALTER TABLE companies ADD CONSTRAINT companies_center_company_name_key UNIQUE (center_id, company_name);

CREATE TABLE IF NOT EXISTS fair_company_roster (
  id                 SERIAL PRIMARY KEY,
  fair_settings_id   INTEGER NOT NULL REFERENCES fair_settings(id) ON DELETE CASCADE,
  company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  seats              INTEGER NOT NULL DEFAULT 1,
  interview_minutes  INTEGER NOT NULL DEFAULT 6 CHECK (interview_minutes > 0),
  floor_number       INTEGER CHECK (floor_number >= 0),
  is_open            BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fair_settings_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_roster_company ON fair_company_roster(company_id);

-- One-time backfill: every company with no roster row *at all* yet (this
-- migration reruns on every deploy with no migration-tracking table, so this
-- guard — not just "no row for the target fair" — keeps a company an admin
-- later removed from a roster from being silently re-added next deploy)
-- gets one against the most recent fair_settings row at its own Center,
-- carrying over its legacy seats/interview_minutes/floor_number/is_open.
-- "Most recent" rather than strictly "is_active" — this can run between
-- fairs, while nothing is active anywhere, and the goal here is "don't
-- regress an existing, still-relevant cycle's data," not "only backfill
-- during a live fair." A company whose Center has no fair_settings row at
-- all yet (or none left, e.g. after an archival cleanup) simply gets no
-- roster row — a real, distinct "not part of any current cycle" state.
INSERT INTO fair_company_roster (fair_settings_id, company_id, seats, interview_minutes, floor_number, is_open)
SELECT DISTINCT ON (c.id) fs.id, c.id, c.seats, c.interview_minutes, c.floor_number, c.is_open
FROM companies c
JOIN fair_settings fs ON fs.center_id = c.center_id
WHERE NOT EXISTS (SELECT 1 FROM fair_company_roster r WHERE r.company_id = c.id)
ORDER BY c.id, fs.fair_date DESC;

-- ---------------------------------------------------------------------------
-- candidate_and_desk_improvements_plan.md §A — fair_settings.
-- max_companies_per_candidate already existed on this table (stage-2's
-- original design) and was already readable/writable via GET/POST/PUT
-- /fair-settings and /fair-settings/activate — but nothing that actually
-- *enforced* the "pick up to N companies" cap ever read it: companyAssignment.js
-- and its three callers (registerCandidate.js, routes/candidates.js,
-- routes/public.js) all used their own hardcoded `MAX_COMPANIES = 3` constant
-- instead, same dead-column pattern as employment_status was for §B. This
-- column was already correctly configurable end-to-end; it just had zero
-- effect. Only a missing positive-value guard is added here (the column had
-- no CHECK before, just NOT NULL DEFAULT 3) — same idiom as
-- companies_interview_minutes_positive above.
-- ---------------------------------------------------------------------------
ALTER TABLE fair_settings DROP CONSTRAINT IF EXISTS fair_settings_max_companies_positive;
ALTER TABLE fair_settings ADD CONSTRAINT fair_settings_max_companies_positive
  CHECK (max_companies_per_candidate > 0);

-- ---------------------------------------------------------------------------
-- candidate_and_desk_improvements_plan.md §B — employment_status was live in
-- registerCandidate.js/reports.js but had no UI ever setting it, so every row
-- in production reads the default 'Fresher'. 'Other' is dropped (nothing has
-- ever set it — no real data lost) and replaced with 'Experienced'; 'Studying'
-- and 'Working' are kept. When 'Working' or 'Experienced', the candidate can
-- list one or more past companies via candidate_work_experience below — a
-- repeatable "add" facility, not a flat pair of years/months columns, since
-- more than one past employer must be representable.
-- ---------------------------------------------------------------------------
ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_employment_status_check;
ALTER TABLE candidates ADD CONSTRAINT candidates_employment_status_check
  CHECK (employment_status IN ('Studying', 'Working', 'Fresher', 'Experienced'));

CREATE TABLE IF NOT EXISTS candidate_work_experience (
  id             SERIAL PRIMARY KEY,
  candidate_id   INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  company_name   VARCHAR NOT NULL,
  years          SMALLINT NOT NULL DEFAULT 0 CHECK (years >= 0),
  months         SMALLINT NOT NULL DEFAULT 0 CHECK (months BETWEEN 0 AND 11),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_work_experience_candidate ON candidate_work_experience(candidate_id);

-- ---------------------------------------------------------------------------
-- candidate_and_desk_improvements_plan.md §C — resume upload was PDF-only
-- end to end (multer fileFilter, a hardcoded `${token}.pdf` on-disk filename,
-- and the serving route's own hardcoded `.pdf` path). Once an image is also
-- accepted, both the serving route and the Desk UI (<iframe> vs <img>) need
-- to know which kind was actually stored, without re-sniffing file bytes on
-- every read — one nullable column, set alongside resume_uploaded_at at
-- upload time, same "doubles as existence+type metadata" idiom already used
-- by resume_uploaded_at itself.
-- ---------------------------------------------------------------------------
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS resume_ext VARCHAR CHECK (resume_ext IN ('pdf', 'jpg', 'jpeg', 'png'));

-- ---------------------------------------------------------------------------
-- candidate_and_desk_improvements_plan.md §D — Company HR's "Close Desk"
-- action now requires a short feedback form before is_open actually flips to
-- false (routes/companies.js's POST /companies/:id/close-desk). One row per
-- company per fair cycle: UNIQUE(company_id, fair_settings_id) makes a
-- reopen-then-reclose the same cycle an upsert rather than a pile of
-- duplicate rows, same reasoning candidate_feedback's UNIQUE(candidate_id)
-- already uses. ON DELETE SET NULL (not CASCADE) so a submitted row outlives
-- a company/fair-cycle hard delete, matching candidate_feedback's own
-- candidate_id column.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_hr_feedback (
  id                      SERIAL PRIMARY KEY,
  company_id              INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  fair_settings_id        INTEGER REFERENCES fair_settings(id) ON DELETE SET NULL,
  candidate_quality       SMALLINT NOT NULL CHECK (candidate_quality BETWEEN 1 AND 5),
  venue_rating            SMALLINT NOT NULL CHECK (venue_rating BETWEEN 1 AND 5),
  app_performance_rating  SMALLINT NOT NULL CHECK (app_performance_rating BETWEEN 1 AND 5),
  volunteer_satisfaction  SMALLINT NOT NULL CHECK (volunteer_satisfaction BETWEEN 1 AND 5),
  future_interest         VARCHAR NOT NULL CHECK (future_interest IN
                             ('Definitely Yes', 'Probably Yes', 'Maybe', 'Probably No', 'Definitely No')),
  submitted_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, fair_settings_id)
);
