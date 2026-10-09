ALTER TABLE users
  ADD COLUMN google_sub VARCHAR(64) DEFAULT NULL AFTER demo_owner_id,
  ADD COLUMN has_password TINYINT(1) NOT NULL DEFAULT 1 AFTER google_sub,
  ADD UNIQUE KEY uq_users_google_sub (google_sub);
