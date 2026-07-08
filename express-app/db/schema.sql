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
