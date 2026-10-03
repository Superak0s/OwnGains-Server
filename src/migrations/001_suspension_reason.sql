ALTER TABLE users ADD COLUMN disabled_reason VARCHAR(500) DEFAULT NULL AFTER disabled_at;
