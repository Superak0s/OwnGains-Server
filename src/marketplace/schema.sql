-- Skin marketplace schema. Its own database, never the server's. Every
-- statement is CREATE TABLE IF NOT EXISTS and re-runs on every boot.

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
  swatch           VARCHAR(64)  NOT NULL DEFAULT '',
  version          INT UNSIGNED NOT NULL DEFAULT 1,
  downloads        INT UNSIGNED NOT NULL DEFAULT 0,
  unique_downloads INT UNSIGNED NOT NULL DEFAULT 0,
  rating_sum       INT UNSIGNED NOT NULL DEFAULT 0,
  rating_count     INT UNSIGNED NOT NULL DEFAULT 0,
  taken_down_at    DATETIME     DEFAULT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_skins_author (author_uuid),
  KEY idx_skins_unique_downloads (unique_downloads),
  KEY idx_skins_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS skin_ratings (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  skin_id    INT UNSIGNED NOT NULL,
  -- NULL once the rater is anonymized. The stars still count in the average.
  rater_uuid CHAR(36) CHARACTER SET ascii DEFAULT NULL,
  stars      TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_skin_ratings (skin_id, rater_uuid),
  KEY idx_skin_ratings_rater (rater_uuid),
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
  reporter_uuid CHAR(36) CHARACTER SET ascii DEFAULT NULL,
  reason        VARCHAR(500) NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_skin_reports_reporter (reporter_uuid),
  CONSTRAINT fk_skin_reports_skin FOREIGN KEY (skin_id) REFERENCES skins (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
