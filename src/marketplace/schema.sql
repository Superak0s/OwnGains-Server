-- Skin marketplace schema, kept in the server's database (every table is skin*).
-- Every statement is CREATE TABLE IF NOT EXISTS and re-runs on every boot.

CREATE TABLE IF NOT EXISTS skins (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- NULL once the author deleted their account: the skin stays published anonymized.
  author_uuid      CHAR(36) CHARACTER SET ascii DEFAULT NULL,
  author_name      VARCHAR(64)  DEFAULT NULL,
  name             VARCHAR(60)  NOT NULL,
  description      VARCHAR(500) NOT NULL DEFAULT '',
  body             MEDIUMTEXT   NOT NULL,
  has_theme        BOOLEAN      NOT NULL,
  has_boards       BOOLEAN      NOT NULL,
  -- JSON array of up to four colors. rgba() values contain commas.
  swatch           VARCHAR(255) NOT NULL DEFAULT '[]',
  version          INT UNSIGNED NOT NULL DEFAULT 1,
  downloads        INT UNSIGNED NOT NULL DEFAULT 0,
  unique_downloads INT UNSIGNED NOT NULL DEFAULT 0,
  rating_sum       INT UNSIGNED NOT NULL DEFAULT 0,
  rating_count     INT UNSIGNED NOT NULL DEFAULT 0,
  taken_down_at    DATETIME     DEFAULT NULL,
  -- Server demo data: the users.uuid of the one account that may see this skin.
  demo_for         CHAR(36) CHARACTER SET ascii DEFAULT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_skins_author (author_uuid),
  KEY idx_skins_unique_downloads (unique_downloads),
  KEY idx_skins_created (created_at),
  KEY idx_skins_demo_for (demo_for)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Added after the table was first created. MariaDB skips both when present.
ALTER TABLE skins
  ADD COLUMN IF NOT EXISTS demo_for CHAR(36) CHARACTER SET ascii DEFAULT NULL AFTER taken_down_at,
  ADD KEY IF NOT EXISTS idx_skins_demo_for (demo_for);

CREATE TABLE IF NOT EXISTS skin_ratings (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  skin_id    INT UNSIGNED NOT NULL,
  -- HMAC of the rater's account id, so one account keeps one rating even after it is anonymized.
  rater_key  BINARY(32)   NOT NULL,
  stars      TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_skin_ratings (skin_id, rater_key),
  CONSTRAINT fk_skin_ratings_skin FOREIGN KEY (skin_id) REFERENCES skins (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS skin_downloads (
  skin_id INT UNSIGNED NOT NULL,
  -- HMAC of skin id and install id. The raw install id is never stored.
  hash    BINARY(32)   NOT NULL,
  PRIMARY KEY (skin_id, hash),
  CONSTRAINT fk_skin_downloads_skin FOREIGN KEY (skin_id) REFERENCES skins (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS skin_reports (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  skin_id       INT UNSIGNED NOT NULL,
  -- Same HMAC as skin_ratings.rater_key: one report per account and skin.
  reporter_key  BINARY(32)   NOT NULL,
  reason        VARCHAR(500) NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_skin_reports (skin_id, reporter_key),
  CONSTRAINT fk_skin_reports_skin FOREIGN KEY (skin_id) REFERENCES skins (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
