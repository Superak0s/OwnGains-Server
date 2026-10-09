-- OwnGains Server — canonical schema.
--
-- This file IS the schema. It is not derived from anything; every table the
-- server uses is declared here, in dependency order, and the bootstrap in
-- config/database.ts replays it on every boot.
--
-- Operational note: every statement is CREATE TABLE IF NOT EXISTS, so editing
-- this file does NOT alter an existing database. Structural changes to a table
-- that already exists go in migrations/NNN_description.sql, which runMigrations()
-- applies at most once each. During development against a throwaway database the
-- faster path is DROP DATABASE and let the server re-provision.
--
-- Conventions, all deliberate:
--   * DATETIME everywhere, never TIMESTAMP. Connections are pinned to UTC
--     (SET time_zone = '+00:00') and the driver runs with dateStrings: true, so
--     a DATETIME round-trips as the exact UTC string the app sent.
--   * `measured_at` / `logged_at` / `taken_at` / `start_time` are the only
--     "when did this happen" names. `created_at` always means "when was this row
--     written" and always defaults to CURRENT_TIMESTAMP — never hand-write NOW().
--   * `note` (singular) is the user's free text on a row. There is no `notes`.
--   * No explicit COLLATE, so MySQL 8 applies utf8mb4_0900_ai_ci. That is
--     case-INSENSITIVE, which is intended: it makes uq_users_username treat
--     'Bob' and 'bob' as the same name and blocks username impersonation. Do not
--     "fix" this to a _bin collation.
--   * CHECK constraints carry every range rule. The database, not four scattered
--     route files, is the authority on what an intensity or an RIR is.
--   * Scalar time series (weight, circumferences, hydration, body-fat percent,
--     user-defined metrics) all live in `measurements`. Anything with internal
--     structure — sets, photos, cycles, injuries, supplements, macros — keeps
--     its own table. Hold that line or this rots into EAV.

-- ═══════════════════════════════════════════════════════════════════════════
-- Identity & auth
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
  id             INT UNSIGNED          NOT NULL AUTO_INCREMENT,
  -- The user's public identity: the only user id that leaves the database
  -- (JWTs, API responses, route params, X-Trainee-Id, WS events). `id` stays
  -- the internal key every foreign key points at, and is never exposed, so a
  -- caller can't enumerate accounts by counting. Random (v4), set by
  -- createUser.
  uuid           CHAR(36) CHARACTER SET ascii NOT NULL,
  username       VARCHAR(64)           NOT NULL,
  email          VARCHAR(255)          NOT NULL,
  password_hash  VARCHAR(255)          NOT NULL,
  name           VARCHAR(128)          NOT NULL,
  -- Used for exactly one thing: the sex coefficient in the US-Navy body-fat
  -- formula (features/tracking/bodyStats). Named for its purpose so nobody
  -- mistakes it for a profile/identity field.
  bf_formula_sex ENUM('male','female')          DEFAULT NULL,
  height_cm      DECIMAL(5,2)                   DEFAULT NULL,
  height_unit    ENUM('cm','ft')       NOT NULL DEFAULT 'cm',
  weight_unit    ENUM('kg','lbs')      NOT NULL DEFAULT 'kg',
  is_admin       TINYINT(1)            NOT NULL DEFAULT 0,
  -- Bumped to invalidate every JWT ever issued to this account at once.
  token_version  INT UNSIGNED          NOT NULL DEFAULT 0,
  -- Set when an admin suspends the account: auth, signin and refresh refuse
  -- it until cleared. Suspending also bumps token_version.
  disabled_at    DATETIME                       DEFAULT NULL,
  -- Shown to the user at sign-in (DSA Art. 17 statement of reasons).
  disabled_reason VARCHAR(500)                  DEFAULT NULL,
  -- What the account agreed to (GDPR Art. 7(1): consent must be provable).
  -- The Terms version the app showed and when it was accepted, and when
  -- explicit consent to health data was given; NULL once withdrawn.
  terms_version     VARCHAR(32)                 DEFAULT NULL,
  terms_accepted_at DATETIME                    DEFAULT NULL,
  health_consent_at DATETIME                    DEFAULT NULL,
  -- Set on the fake friends POST /api/sessions/demo creates: the real user
  -- they were made for. They are also suspended, so nobody can sign in as
  -- one or find one in search.
  demo_owner_id  INT UNSIGNED                   DEFAULT NULL,
  -- The Google account's stable `sub` claim, for accounts that sign in with
  -- Google. Only set on a server with GOOGLE_WEB_CLIENT_ID.
  google_sub     VARCHAR(64)                    DEFAULT NULL,
  -- 0 for an account created through Google, whose password_hash is a hash of
  -- random bytes nobody knows. Set to 1 when an operator resets the password.
  has_password   TINYINT(1)            NOT NULL DEFAULT 1,
  created_at     DATETIME              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_uuid (uuid),
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_google_sub (google_sub),
  KEY idx_users_demo_owner (demo_owner_id),
  CONSTRAINT fk_users_demo_owner FOREIGN KEY (demo_owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ck_users_height CHECK (height_cm IS NULL OR height_cm > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per user, created on first write. Every per-user preference is a
-- column here; a new preference must never become a new table.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id                 INT UNSIGNED     NOT NULL,
  hydration_goal_ml       INT UNSIGNED     NOT NULL DEFAULT 2000,
  hydration_error_percent DECIMAL(5,2)     NOT NULL DEFAULT 0,
  cycle_period_days       TINYINT UNSIGNED NOT NULL DEFAULT 5,
  cycle_length_days       TINYINT UNSIGNED NOT NULL DEFAULT 28,
  macro_protein_goal      DECIMAL(7,2)     NOT NULL DEFAULT 150.00,
  macro_carbs_goal        DECIMAL(7,2)     NOT NULL DEFAULT 250.00,
  macro_fat_goal          DECIMAL(7,2)     NOT NULL DEFAULT 65.00,
  macro_calories_goal     DECIMAL(8,2)     NOT NULL DEFAULT 2000.00,
  updated_at              DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_us_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ck_us_cycle CHECK (cycle_period_days > 0 AND cycle_length_days > 0
                                AND cycle_period_days <= cycle_length_days),
  CONSTRAINT ck_us_hydration CHECK (hydration_goal_ml > 0 AND hydration_error_percent >= 0),
  CONSTRAINT ck_us_macros CHECK (macro_protein_goal >= 0 AND macro_carbs_goal >= 0
                                 AND macro_fat_goal >= 0 AND macro_calories_goal >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Opaque rotating refresh tokens. family_id chains every rotation of one login;
-- presenting an already-used token revokes the whole family (theft detection).
-- Correct as built — do not simplify.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  token_hash CHAR(64)     NOT NULL,   -- SHA-256 of the opaque token; the token itself is never stored
  family_id  CHAR(36)     NOT NULL,
  issued_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME     NOT NULL,
  used_at    DATETIME              DEFAULT NULL,
  revoked_at DATETIME              DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_refresh_tokens_hash (token_hash),
  KEY idx_refresh_tokens_user_revoked (user_id, revoked_at),
  KEY idx_refresh_tokens_family (family_id),
  KEY idx_refresh_tokens_expiry (expires_at),
  CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ═══════════════════════════════════════════════════════════════════════════
-- Exercise catalog & programs
-- ═══════════════════════════════════════════════════════════════════════════

-- Deliberately GLOBAL: no user_id, UNIQUE on name. A shared vocabulary is what
-- makes joint sessions and cross-user analytics coherent. The muscle labels
-- here are only a fallback: each user's own live in user_exercise_muscles.
--
-- Consequence to respect: an exercise row is shared, so "rename my exercise"
-- must never UPDATE exercises.name. It re-points the referencing rows at a
-- different (found-or-created) exercise instead — see renameExerciseInHistory.
-- Renaming the row itself would rewrite every other user's history.
CREATE TABLE IF NOT EXISTS exercises (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name              VARCHAR(255) NOT NULL,
  -- NOT NULL with a default so readers get exactly one shape: a JSON array.
  primary_muscles   JSON         NOT NULL DEFAULT (JSON_ARRAY()),
  secondary_muscles JSON         NOT NULL DEFAULT (JSON_ARRAY()),
  PRIMARY KEY (id),
  UNIQUE KEY uq_exercises_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Each user's own muscle labels for a catalog exercise. exercises.name is
-- shared on purpose, but its muscle columns were too: whoever first logged a
-- name (or first labelled a label-less row) chose the muscles every other user
-- saw in their history, friend views and program — on an open-signup instance,
-- anyone. Reads take the owner's row here when it has labels and fall back to
-- the catalog's; writes with labels go here, and still fill a blank catalog
-- row so users who never sent labels see something.
CREATE TABLE IF NOT EXISTS user_exercise_muscles (
  user_id           INT UNSIGNED NOT NULL,
  exercise_id       INT UNSIGNED NOT NULL,
  primary_muscles   JSON         NOT NULL DEFAULT (JSON_ARRAY()),
  secondary_muscles JSON         NOT NULL DEFAULT (JSON_ARRAY()),
  PRIMARY KEY (user_id, exercise_id),
  KEY idx_uem_exercise (exercise_id),
  CONSTRAINT fk_uem_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_uem_exercise FOREIGN KEY (exercise_id) REFERENCES exercises (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One program per user. The workout spreadsheet is parsed client-side; the
-- server stores the result as rows, not as one JSON document, because three
-- PATCH endpoints mutate individual exercises.
CREATE TABLE IF NOT EXISTS programs (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id           INT UNSIGNED NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  -- Ordered list of split names ("A","B",…) as the parser emitted them. An
  -- ordered array of labels with no attributes of its own — JSON is right here.
  split_order       JSON         NOT NULL DEFAULT (JSON_ARRAY()),
  -- Which day the user is currently on. NULL until they set one; the app
  -- falls back to its own local pointer in that case.
  current_day       INT UNSIGNED          DEFAULT NULL,
  uploaded_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_programs_user (user_id),
  CONSTRAINT fk_pg_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS program_days (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  program_id        INT UNSIGNED NOT NULL,
  day_number        INT          NOT NULL,
  title             VARCHAR(255) NOT NULL DEFAULT '',
  primary_muscles   JSON         NOT NULL DEFAULT (JSON_ARRAY()),
  secondary_muscles JSON         NOT NULL DEFAULT (JSON_ARRAY()),
  PRIMARY KEY (id),
  -- Re-uploading a program upserts on this key rather than deleting rows, so
  -- workouts.program_day_id survives a re-upload of the same day.
  UNIQUE KEY uq_pd_program_day (program_id, day_number),
  CONSTRAINT fk_pd_program FOREIGN KEY (program_id) REFERENCES programs (id) ON DELETE CASCADE,
  CONSTRAINT ck_pd_day CHECK (day_number >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS program_exercises (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  program_day_id INT UNSIGNED NOT NULL,
  split_name     VARCHAR(128) NOT NULL,
  position       INT          NOT NULL,   -- 0-based index within (day, split)
  -- The shared catalog row. Name and muscle groups are read from here, never
  -- duplicated — this is the link workout_sets already had and the program did not.
  exercise_id    INT UNSIGNED NOT NULL,
  -- The app's bundled-exercise-DB id (an opaque string), or NULL for a custom
  -- exercise. Not a foreign key: it identifies a row in the *client's* catalog.
  catalog_id     VARCHAR(64)           DEFAULT NULL,
  target_sets    INT          NOT NULL DEFAULT 0,
  target_reps    VARCHAR(32)           DEFAULT NULL,   -- free text: "10", "8-12"
  -- Per-machine setup for this exercise: machines[], selectedMachine,
  -- defaultMachine, bestAcrossMachines, machineMeta{}. Client-owned presentation
  -- state with an open shape — a JSON column, not five columns.
  machine        JSON         NOT NULL DEFAULT (JSON_OBJECT()),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pe_slot (program_day_id, split_name, position),
  KEY idx_pe_exercise (exercise_id),
  CONSTRAINT fk_pe_day FOREIGN KEY (program_day_id) REFERENCES program_days (id) ON DELETE CASCADE,
  -- RESTRICT, explicitly: the catalog must not be prunable out from under a
  -- program or a set history.
  CONSTRAINT fk_pe_exercise FOREIGN KEY (exercise_id) REFERENCES exercises (id) ON DELETE RESTRICT,
  CONSTRAINT ck_pe_sets CHECK (target_sets >= 0),
  CONSTRAINT ck_pe_position CHECK (position >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ═══════════════════════════════════════════════════════════════════════════
-- Workouts
-- ═══════════════════════════════════════════════════════════════════════════

-- Named `workouts`, not `sessions`: next to refresh_tokens, "sessions" reads as
-- login state. The REST mount stays /api/sessions.
CREATE TABLE IF NOT EXISTS workouts (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        INT UNSIGNED NOT NULL,
  -- Links history to the program day it was run from. SET NULL rather than
  -- CASCADE: deleting a program must never delete the workouts it produced.
  -- Muscle groups for a workout are read through this link.
  program_day_id INT UNSIGNED          DEFAULT NULL,
  -- day_number / day_title / split stay denormalized on purpose. They are the
  -- label the history list shows, and history has to stay readable after the
  -- program is edited or deleted.
  day_number     INT          NOT NULL,
  day_title      VARCHAR(255)          DEFAULT NULL,
  split          VARCHAR(128)          DEFAULT NULL,
  start_time     DATETIME     NOT NULL,
  end_time       DATETIME              DEFAULT NULL,   -- NULL = still in progress
  total_duration INT                   DEFAULT NULL,   -- seconds, set when ended
  -- Incremented in the same transaction that inserts a set, so it IS the set
  -- count. Saves a correlated COUNT(*) per row on every history page.
  completed_sets INT          NOT NULL DEFAULT 0,
  is_demo        TINYINT(1)   NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_w_user_start (user_id, start_time),
  KEY idx_w_user_split_start (user_id, split, start_time),
  KEY idx_w_program_day (program_day_id),
  -- Open workouts (end_time IS NULL) by age, for the stale-session sweep.
  KEY idx_w_open (end_time, start_time),
  CONSTRAINT fk_w_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_w_program_day FOREIGN KEY (program_day_id) REFERENCES program_days (id) ON DELETE SET NULL,
  CONSTRAINT ck_w_times CHECK (end_time IS NULL OR end_time >= start_time),
  CONSTRAINT ck_w_duration CHECK (total_duration IS NULL OR total_duration >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One recorded set. Not "timings" — it holds weight, reps, rir, note and the
-- machine it was performed on.
CREATE TABLE IF NOT EXISTS workout_sets (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  workout_id   INT UNSIGNED NOT NULL,
  exercise_id  INT UNSIGNED NOT NULL,
  set_index    INT          NOT NULL,
  start_time   DATETIME     NOT NULL,
  end_time     DATETIME     NOT NULL,
  set_duration INT                   DEFAULT NULL,   -- seconds, derived from the pair above
  rest_time    INT                   DEFAULT NULL,   -- seconds since the previous set ended
  weight       DECIMAL(7,2)          DEFAULT NULL,
  reps         INT                   DEFAULT NULL,
  note         TEXT                  DEFAULT NULL,
  is_warmup    TINYINT(1)   NOT NULL DEFAULT 0,
  rir          TINYINT UNSIGNED      DEFAULT NULL,   -- reps in reserve; 0 = failure
  machine_name VARCHAR(100)          DEFAULT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ws_workout_created (workout_id, created_at),
  -- Both columns are filtered together by renameExerciseInHistory.
  KEY idx_ws_workout_exercise (workout_id, exercise_id),
  KEY idx_ws_exercise (exercise_id),
  -- Covers the analytics volume sum without a row lookup per set.
  KEY idx_ws_workout_volume (workout_id, weight, reps),
  CONSTRAINT fk_ws_workout FOREIGN KEY (workout_id) REFERENCES workouts (id) ON DELETE CASCADE,
  CONSTRAINT fk_ws_exercise FOREIGN KEY (exercise_id) REFERENCES exercises (id) ON DELETE RESTRICT,
  CONSTRAINT ck_ws_times CHECK (end_time >= start_time),
  CONSTRAINT ck_ws_weight CHECK (weight IS NULL OR weight >= 0),
  CONSTRAINT ck_ws_reps CHECK (reps IS NULL OR reps >= 0),
  CONSTRAINT ck_ws_rir CHECK (rir IS NULL OR rir BETWEEN 0 AND 9)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Idempotency-Key replay store for the session write routes (start / set /
-- end). A 2xx response is kept for 48h so an offline-queue replay whose first
-- attempt did commit gets the original answer back instead of a duplicate row.
-- utf8mb4_bin: keys are opaque, "a" and "A" are different keys.
-- status 0 marks a request still in flight (the placeholder that stops two
-- concurrent retries both running); only a 2xx is ever stored as a response.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id    INT UNSIGNED      NOT NULL,
  -- 0 = the account owner; otherwise the acting trainer's users.id, so a
  -- trainer and their trainee never share a key space.
  actor_id   INT UNSIGNED      NOT NULL DEFAULT 0,
  idem_key   VARCHAR(64)       COLLATE utf8mb4_bin NOT NULL,
  route      VARCHAR(255)      NOT NULL,
  body_hash  CHAR(64)          NOT NULL,   -- SHA-256 of the JSON request body
  status     SMALLINT UNSIGNED NOT NULL,
  response   MEDIUMTEXT        NOT NULL,
  created_at DATETIME          NOT NULL,
  PRIMARY KEY (user_id, actor_id, idem_key),
  KEY idx_ik_created (created_at),
  CONSTRAINT fk_ik_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ═══════════════════════════════════════════════════════════════════════════
-- Body metrics — every scalar time series
-- ═══════════════════════════════════════════════════════════════════════════

-- body_weight, body_measurements, hydration_log, body_fat_measurements and
-- measurement_custom_values were five tables of the same shape: one number, per
-- user, per timestamp, charted over time. This is that table.
--
-- `metric` is a key like 'weight_kg', 'waist_cm', 'water_ml', 'body_fat_pct' —
-- or a user-defined key from metric_definitions. Adding a tracked metric is now
-- a constant in TypeScript, not DDL.
--
-- Rows sharing a (user_id, measured_at) are one measuring session: the body-fat
-- log writes body_fat_pct alongside the circumferences it was computed from, so
-- those circumferences also show up on their own charts for free.
CREATE TABLE IF NOT EXISTS measurements (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED  NOT NULL,
  metric      VARCHAR(64)   NOT NULL,
  value       DECIMAL(10,3) NOT NULL,
  measured_at DATETIME      NOT NULL,
  -- 0 for every reading metric; additive metrics (water_ml) number the entries
  -- that share one instant 0, 1, 2… so a second drink doesn't replace the first.
  entry_seq   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  note        TEXT                   DEFAULT NULL,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Unique, not just indexed: a device replaying a week of offline logs on
  -- reconnect must overwrite its own earlier rows, not double every point.
  -- logMetrics relies on this for ON DUPLICATE KEY UPDATE (at entry_seq 0).
  UNIQUE KEY uq_m_user_metric_at_seq (user_id, metric, measured_at, entry_seq),
  KEY idx_m_user_at (user_id, measured_at),
  CONSTRAINT fk_m_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ck_m_value CHECK (value > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Label/unit registry. Built-in metrics need no row here; a user-defined metric
-- gets one so the UI knows what to call it and in what unit.
CREATE TABLE IF NOT EXISTS metric_definitions (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  key_name   VARCHAR(64)  NOT NULL,
  label      VARCHAR(255) NOT NULL,
  unit       VARCHAR(32)           DEFAULT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_md_user_key (user_id, key_name),
  CONSTRAINT fk_md_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  -- A key names a pivot column in the grouped read, so it must be spellable as
  -- a bare SQL identifier. Enforced here as well as in the model.
  CONSTRAINT ck_md_key_name CHECK (key_name REGEXP '^[a-z][a-z0-9_]*$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ═══════════════════════════════════════════════════════════════════════════
-- Nutrition & supplements
-- ═══════════════════════════════════════════════════════════════════════════

-- A meal: four numbers that belong together, so not a measurements row. The
-- "HH:MM" display label that used to sit beside taken_at is gone — format it
-- from taken_at instead of storing presentation state that can disagree.
CREATE TABLE IF NOT EXISTS macros_intake (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      INT UNSIGNED NOT NULL,
  name         VARCHAR(255)          DEFAULT NULL,
  protein      DECIMAL(7,2) NOT NULL DEFAULT 0.00,
  carbs        DECIMAL(7,2) NOT NULL DEFAULT 0.00,
  fat          DECIMAL(7,2) NOT NULL DEFAULT 0.00,
  calories     DECIMAL(8,2) NOT NULL DEFAULT 0.00,
  error_margin DECIMAL(5,2) NOT NULL DEFAULT 0.00,   -- percent; the user's own uncertainty estimate
  taken_at     DATETIME     NOT NULL,
  note         TEXT                  DEFAULT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_mi_user_taken (user_id, taken_at),
  CONSTRAINT fk_mi_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ck_mi_values CHECK (protein >= 0 AND carbs >= 0 AND fat >= 0
                                 AND calories >= 0 AND error_margin >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS supplements (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          INT UNSIGNED NOT NULL,
  name             VARCHAR(255) NOT NULL,
  unit             VARCHAR(32)  NOT NULL DEFAULT 'g',
  default_amount   DECIMAL(8,2) NOT NULL DEFAULT 5.00,   -- per dose
  doses_per_day    TINYINT UNSIGNED  NOT NULL DEFAULT 1,
  dose_interval_minutes SMALLINT UNSIGNED DEFAULT NULL, -- minimum gap between doses; NULL = no timer
  reminder_enabled TINYINT(1)   NOT NULL DEFAULT 0,
  reminder_time    TIME                  DEFAULT NULL,
  color            VARCHAR(32)           DEFAULT NULL,
  icon             VARCHAR(64)           DEFAULT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Lets supplement_intake carry a composite FK, so a dose can never be filed
  -- under another user's supplement.
  UNIQUE KEY uq_sup_user_id (user_id, id),
  CONSTRAINT fk_sup_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ck_sup_amount CHECK (default_amount > 0),
  CONSTRAINT ck_sup_doses CHECK (doses_per_day BETWEEN 1 AND 10),
  CONSTRAINT ck_sup_interval CHECK (dose_interval_minutes IS NULL
                                    OR dose_interval_minutes BETWEEN 1 AND 1440)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS supplement_intake (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       INT UNSIGNED NOT NULL,
  supplement_id INT UNSIGNED NOT NULL,
  amount        DECIMAL(8,2) NOT NULL,
  taken_at      DATETIME     NOT NULL,
  note          TEXT                  DEFAULT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_si_user_taken (user_id, taken_at),
  KEY idx_si_user_supp_taken (user_id, supplement_id, taken_at),
  -- One composite FK instead of two independent ones: it cascades on user delete
  -- and on supplement delete, and makes a cross-user supplement_id unstorable.
  CONSTRAINT fk_si_supplement FOREIGN KEY (user_id, supplement_id)
    REFERENCES supplements (user_id, id) ON DELETE CASCADE,
  CONSTRAINT ck_si_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ═══════════════════════════════════════════════════════════════════════════
-- Health tracking
-- ═══════════════════════════════════════════════════════════════════════════

-- One soreness table. There were two (muscle_soreness and active_soreness)
-- storing the same fact with different valid ranges and no way to reconcile
-- them. The plain log endpoints and the follow-up/recovery endpoints are now
-- one feature over one table, at /api/tracking/soreness.
--
-- muscle_group is free text on purpose: a curated list gets first-class UI
-- treatment, but "IT band" and "Achilles tendon" have to be loggable too.
CREATE TABLE IF NOT EXISTS soreness (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      INT UNSIGNED NOT NULL,
  muscle_group VARCHAR(128) NOT NULL,
  intensity    TINYINT      NOT NULL,
  note         TEXT                  DEFAULT NULL,
  logged_at    DATETIME     NOT NULL,
  status       ENUM('active','recovering','recovered') NOT NULL DEFAULT 'active',
  recovered_at DATETIME              DEFAULT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sor_user_status (user_id, status),
  KEY idx_sor_user_muscle_logged (user_id, muscle_group, logged_at),
  KEY idx_sor_user_logged (user_id, logged_at),
  CONSTRAINT fk_sor_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  -- 0-10, one range, enforced once. The two old writers disagreed (1-10 vs 0-10).
  CONSTRAINT ck_sor_intensity CHECK (intensity BETWEEN 0 AND 10)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Append-only trail of how one soreness episode progressed. Immutable, hence
-- no updated_at.
CREATE TABLE IF NOT EXISTS soreness_follow_up (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  soreness_id INT UNSIGNED NOT NULL,
  intensity   TINYINT      NOT NULL,
  status      ENUM('still_sore','better','recovered') NOT NULL,
  note        TEXT                  DEFAULT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sfu_soreness_created (soreness_id, created_at),
  CONSTRAINT fk_sfu_soreness FOREIGN KEY (soreness_id) REFERENCES soreness (id) ON DELETE CASCADE,
  CONSTRAINT ck_sfu_intensity CHECK (intensity BETWEEN 0 AND 10)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS injuries (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       INT UNSIGNED NOT NULL,
  muscle_group  VARCHAR(128) NOT NULL,
  injury_type   ENUM('strain','sprain','tendonitis','fracture','dislocation',
                     'tear','overuse','surgery','other') NOT NULL,
  pain_level    TINYINT      NOT NULL,
  start_date    DATETIME     NOT NULL,
  recovery_date DATETIME              DEFAULT NULL,
  note          TEXT                  DEFAULT NULL,
  status        ENUM('active','recovering','recovered') NOT NULL DEFAULT 'active',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_inj_user_status (user_id, status),
  KEY idx_inj_user_muscle_created (user_id, muscle_group, created_at),
  KEY idx_inj_user_created (user_id, created_at),
  CONSTRAINT fk_inj_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ck_inj_pain CHECK (pain_level BETWEEN 0 AND 10),
  CONSTRAINT ck_inj_dates CHECK (recovery_date IS NULL OR recovery_date >= start_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS menstrual_cycle (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NOT NULL,
  cycle_start DATETIME     NOT NULL,
  -- Written by PATCH /menstrual/:id. Cycle *length* is derived from consecutive
  -- cycle_start values, so there is no stored duration_days to drift out of sync.
  cycle_end   DATETIME              DEFAULT NULL,
  symptoms    JSON         NOT NULL DEFAULT (JSON_ARRAY()),
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_mc_user_start (user_id, cycle_start),
  CONSTRAINT fk_mc_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ck_mc_dates CHECK (cycle_end IS NULL OR cycle_end >= cycle_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ═══════════════════════════════════════════════════════════════════════════
-- Notes & photos
-- ═══════════════════════════════════════════════════════════════════════════

-- A log of notes per muscle, not one note per muscle — hence no UNIQUE on
-- (user_id, muscle_group). Notes are created and deleted, never edited, so
-- updated_at currently equals created_at.
CREATE TABLE IF NOT EXISTS muscle_notes (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      INT UNSIGNED NOT NULL,
  muscle_group VARCHAR(128) NOT NULL,
  content      TEXT         NOT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_mn_user_muscle_updated (user_id, muscle_group, updated_at),
  CONSTRAINT fk_mn_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Metadata only. The bytes live in progress_photo_blobs so that listing photos
-- is physically incapable of dragging 10 MB rows through the buffer pool — and
-- so the account export needs no hand-written column whitelist.
CREATE TABLE IF NOT EXISTS progress_photos (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          INT UNSIGNED NOT NULL,
  mime_type        VARCHAR(64)  NOT NULL,
  file_size        INT UNSIGNED NOT NULL,
  -- SHA-256 hex of the stored bytes: the image's ETag, so a revalidation is
  -- answered 304 without reading the blob. NULL until backfilled on first read
  -- for photos from before it existed.
  content_hash     CHAR(64)              DEFAULT NULL,
  taken_at         DATETIME     NOT NULL,
  note             TEXT                  DEFAULT NULL,
  angle            ENUM('front','back','side','custom') NOT NULL DEFAULT 'custom',
  custom_side_name VARCHAR(255)          DEFAULT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pp_user_taken (user_id, taken_at),
  CONSTRAINT fk_pp_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ck_pp_size CHECK (file_size > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS progress_photo_blobs (
  photo_id INT UNSIGNED NOT NULL,
  data     LONGBLOB     NOT NULL,
  PRIMARY KEY (photo_id),
  CONSTRAINT fk_ppb_photo FOREIGN KEY (photo_id) REFERENCES progress_photos (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 400px JPEG for grid tiles. Its own table rather than a column on the blob
-- row so it needed no migration; photos from before it existed get theirs on
-- the first GET /:id/thumb.
CREATE TABLE IF NOT EXISTS progress_photo_thumbs (
  photo_id INT UNSIGNED NOT NULL,
  data     MEDIUMBLOB   NOT NULL,
  PRIMARY KEY (photo_id),
  CONSTRAINT fk_ppt_photo FOREIGN KEY (photo_id) REFERENCES progress_photos (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS progress_photo_muscles (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  photo_id     INT UNSIGNED NOT NULL,
  muscle_group VARCHAR(128) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ppm_photo_muscle (photo_id, muscle_group),
  CONSTRAINT fk_ppm_photo FOREIGN KEY (photo_id) REFERENCES progress_photos (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ═══════════════════════════════════════════════════════════════════════════
-- Social
-- ═══════════════════════════════════════════════════════════════════════════

-- A friendship is ONE row, stored as a canonically ordered pair:
-- user_id = LEAST(a,b), friend_id = GREATEST(a,b), with requested_by carrying
-- the direction that used to be encoded by which column held whom.
--
-- This is what makes uq_friendship actually sufficient. With mirrored (A,B) and
-- (B,A) rows both legal, the UNIQUE key prevented nothing — which is why an
-- advisory GET_LOCK guarded request creation and why every read had to OR across
-- both columns. The CHECK replaces the lock and makes self-friending impossible.
-- Every lookup is now:
--   WHERE user_id = LEAST(?,?) AND friend_id = GREATEST(?,?)
--
-- status has no 'declined': rejecting a request deletes the row.
CREATE TABLE IF NOT EXISTS friendships (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      INT UNSIGNED NOT NULL,
  friend_id    INT UNSIGNED NOT NULL,
  requested_by INT UNSIGNED NOT NULL,
  status       ENUM('pending','accepted') NOT NULL DEFAULT 'pending',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at  DATETIME              DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_friendship (user_id, friend_id),
  KEY idx_fr_user_status (user_id, status),
  KEY idx_fr_friend_status (friend_id, status),
  KEY idx_fr_requested_status (requested_by, status, created_at),
  CONSTRAINT fk_fr_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_fr_friend FOREIGN KEY (friend_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_fr_requested_by FOREIGN KEY (requested_by) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ck_fr_order CHECK (user_id < friend_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sharing_permissions (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  from_user_id    INT UNSIGNED NOT NULL,
  to_user_id      INT UNSIGNED NOT NULL,
  permission_type ENUM('history','analytics','program','joint_session',
                       'watch_session','trainer') NOT NULL,
  -- Per-grant options. JSON, not TEXT: the driver parses it on read and MySQL
  -- validates it on write.
  payload         JSON                  DEFAULT NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sp_triple (from_user_id, to_user_id, permission_type),
  KEY idx_sp_to (to_user_id),
  CONSTRAINT fk_sp_from FOREIGN KEY (from_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_sp_to FOREIGN KEY (to_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ck_sp_distinct CHECK (from_user_id <> to_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_blocks (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  blocker_id INT UNSIGNED NOT NULL,
  blocked_id INT UNSIGNED NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_block (blocker_id, blocked_id),
  KEY idx_blk_blocked (blocked_id),
  CONSTRAINT fk_blk_blocker FOREIGN KEY (blocker_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_blk_blocked FOREIGN KEY (blocked_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ck_blk_distinct CHECK (blocker_id <> blocked_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A self-hosted instance has no central moderator, so reports are stored here
-- for the operator to read with `bun run owngains reports`. Intentional.
CREATE TABLE IF NOT EXISTS user_reports (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Both NULL-able and SET NULL on delete: a report outlives either account,
  -- which is the point of keeping it. reported_uuid/_username are the
  -- snapshot that still names the reported user once their row is gone.
  reporter_id INT UNSIGNED          DEFAULT NULL,
  reported_id INT UNSIGNED          DEFAULT NULL,
  reported_uuid     CHAR(36) CHARACTER SET ascii DEFAULT NULL,
  reported_username VARCHAR(64)     DEFAULT NULL,
  reason      ENUM('harassment','spam','impersonation','inappropriate','other') NOT NULL,
  details     VARCHAR(1000)         DEFAULT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_rep_reporter (reporter_id, reported_id, created_at),
  KEY idx_rep_reported (reported_id),
  KEY idx_rep_created (created_at),
  CONSTRAINT fk_rep_reporter_sn FOREIGN KEY (reporter_id) REFERENCES users (id) ON DELETE SET NULL,
  -- No CHECK (reporter_id <> reported_id) any more: MySQL/MariaDB forbid a
  -- CHECK on a column with an ON DELETE SET NULL action. reportUser refuses a
  -- self-report instead.
  CONSTRAINT fk_rep_reported_sn FOREIGN KEY (reported_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Two friends working out in sync. created_by exists so the row cascades with
-- its owner; without it this table had no foreign key at all and needed a
-- periodic orphan sweep.
CREATE TABLE IF NOT EXISTS joint_sessions (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  created_by INT UNSIGNED NOT NULL,
  status     ENUM('active','ended') NOT NULL DEFAULT 'active',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_js_created_by (created_by),
  KEY idx_js_status_created (status, created_at),
  CONSTRAINT fk_js_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS joint_session_participants (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  joint_session_id INT UNSIGNED NOT NULL,
  user_id          INT UNSIGNED NOT NULL,
  workout_id       INT UNSIGNED          DEFAULT NULL,
  exercise_index   INT          NOT NULL DEFAULT 0,
  set_index        INT          NOT NULL DEFAULT 0,
  -- The day's exercise list. The single "current exercise name" column that used
  -- to sit beside this was the same state twice; the current name is now
  -- exercise_names -> element exercise_index.
  exercise_names   JSON         NOT NULL DEFAULT (JSON_ARRAY()),
  ready_for_next   TINYINT(1)   NOT NULL DEFAULT 0,
  last_updated     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_jsp_participant (joint_session_id, user_id),
  KEY idx_jsp_user (user_id),
  KEY idx_jsp_workout (workout_id),
  CONSTRAINT fk_jsp_session FOREIGN KEY (joint_session_id) REFERENCES joint_sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_jsp_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_jsp_workout FOREIGN KEY (workout_id) REFERENCES workouts (id) ON DELETE SET NULL,
  CONSTRAINT ck_jsp_index CHECK (exercise_index >= 0 AND set_index >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 'declined' IS stored here (unlike friendships): superseding a pending invite
-- marks it declined rather than deleting it, so the inviter's client sees why.
CREATE TABLE IF NOT EXISTS joint_session_invites (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  from_user_id    INT UNSIGNED NOT NULL,
  to_user_id      INT UNSIGNED NOT NULL,
  from_workout_id INT UNSIGNED          DEFAULT NULL,
  status          ENUM('pending','accepted','declined') NOT NULL DEFAULT 'pending',
  expires_at      DATETIME     NOT NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_jsi_to_status (to_user_id, status),
  KEY idx_jsi_from (from_user_id),
  KEY idx_jsi_expires (expires_at),
  CONSTRAINT fk_jsi_from FOREIGN KEY (from_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_jsi_to FOREIGN KEY (to_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_jsi_workout FOREIGN KEY (from_workout_id) REFERENCES workouts (id) ON DELETE SET NULL,
  CONSTRAINT ck_jsi_distinct CHECK (from_user_id <> to_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Failed-attempt counters for auth, shared across processes and restarts
-- (unlike the in-memory express-rate-limit buckets). `scope` is what is being
-- throttled ('signin' by the submitted username/email, 'reauth' by user uuid
-- for password re-checks); `subject_hash` is sha256 of the normalised subject,
-- so the table never holds a plaintext login name. A row is deleted on
-- success; stale ones are swept opportunistically.
CREATE TABLE IF NOT EXISTS auth_throttle (
  scope           VARCHAR(16)  CHARACTER SET ascii NOT NULL,
  subject_hash    CHAR(64)     CHARACTER SET ascii NOT NULL,
  failures        INT UNSIGNED NOT NULL DEFAULT 0,
  last_failure_at DATETIME     NOT NULL,
  locked_until    DATETIME              DEFAULT NULL,
  PRIMARY KEY (scope, subject_hash),
  KEY idx_at_last_failure (last_failure_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A declined (or cancelled) friend request leaves no friendships row, so this
-- remembers it long enough to stop the sender re-sending straight away.
-- kind 'declined' (the recipient said no) holds for 30 days, 'cancelled' (the
-- sender withdrew it) for an hour. Cleared when the pair become friends.
CREATE TABLE IF NOT EXISTS friend_request_cooldowns (
  requester_id INT UNSIGNED NOT NULL,
  recipient_id INT UNSIGNED NOT NULL,
  kind         ENUM('declined','cancelled') NOT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (requester_id, recipient_id),
  KEY idx_frc_recipient (recipient_id),
  KEY idx_frc_created (created_at),
  CONSTRAINT fk_frc_requester FOREIGN KEY (requester_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_frc_recipient FOREIGN KEY (recipient_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tombstones for deleted accounts, so restoring a backup taken before the
-- deletion doesn't bring the account back: the cleanup job deletes any users
-- row whose uuid is here. No FK — the users row is gone by design. Kept for
-- BACKUP_RETENTION_DAYS, the age of the oldest backup that can still contain
-- the account. scripts/backup.sh dumps this table as INSERT IGNORE rows, so a
-- restore merges tombstones instead of rolling them back.
CREATE TABLE IF NOT EXISTS deleted_accounts (
  uuid       CHAR(36) CHARACTER SET ascii NOT NULL,
  deleted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (uuid),
  KEY idx_da_deleted (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Append-only history of every consent given or withdrawn (GDPR Art. 7(1)):
-- users.terms_* and health_consent_at hold only the current state. Accepting
-- the Terms includes their 16+ age requirement. Goes with the account.
CREATE TABLE IF NOT EXISTS consent_events (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED    NOT NULL,
  kind       ENUM('terms','health') NOT NULL,
  -- Terms version for 'terms'; NULL for 'health'.
  version    VARCHAR(32)              DEFAULT NULL,
  granted    TINYINT(1)      NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ce_user (user_id),
  CONSTRAINT fk_ce_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tracking and supplement rows created by "Fill Demo Data", so removing it
-- deletes exactly those. The tracking tables carry no is_demo flag of their own.
CREATE TABLE IF NOT EXISTS demo_rows (
  user_id    INT UNSIGNED NOT NULL,
  table_name VARCHAR(64)  NOT NULL,
  row_id     INT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, table_name, row_id),
  CONSTRAINT fk_dr_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
