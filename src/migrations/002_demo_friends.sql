ALTER TABLE users
  ADD COLUMN demo_owner_id INT UNSIGNED DEFAULT NULL AFTER health_consent_at,
  ADD KEY idx_users_demo_owner (demo_owner_id),
  ADD CONSTRAINT fk_users_demo_owner FOREIGN KEY (demo_owner_id) REFERENCES users (id) ON DELETE CASCADE;
