-- SDC Job Fair — prototype schema
-- Subset of the full architecture (see SDC_JobFair_Architecture.md):
-- stage 1 proved the core registration -> interview -> result loop;
-- stage 2 adds fair_settings/fair_batches, users/auth and soft-delete;
-- stage 3 adds checkin_sig (HMAC QR), per-candidate check-in and Dispatched status.
-- Still to come: fair_date scoping columns (fix #8), company_posts.

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
-- Waiting room location: per new_architecture.md/new_architecture_uiux_spec.html,
-- the waiting room is deliberately fair-wide and general (one shared pool, not
-- per-company or per-floor), so this lives on fair_settings rather than on
-- companies. Surfaced on the public gate-status board and each candidate's
-- live position page (routes/public.js), so both know where "the waiting
-- room" the ping ladder keeps referring to actually physically is.
-- ---------------------------------------------------------------------------
ALTER TABLE fair_settings
  ADD COLUMN IF NOT EXISTS waiting_room_location VARCHAR,
  ADD COLUMN IF NOT EXISTS waiting_room_floor_number INTEGER;

ALTER TABLE fair_settings
  DROP CONSTRAINT IF EXISTS fair_settings_waiting_room_floor_nonnegative;
ALTER TABLE fair_settings
  ADD CONSTRAINT fair_settings_waiting_room_floor_nonnegative CHECK (waiting_room_floor_number >= 0);
