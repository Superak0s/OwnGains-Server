ALTER TABLE supplement_intake ADD COLUMN local_date DATE NULL AFTER taken_at;
UPDATE supplement_intake SET local_date = DATE(taken_at) WHERE local_date IS NULL;
ALTER TABLE supplement_intake MODIFY local_date DATE NOT NULL;
ALTER TABLE soreness ADD COLUMN local_date DATE NULL AFTER logged_at;
UPDATE soreness SET local_date = DATE(logged_at) WHERE local_date IS NULL;
ALTER TABLE soreness MODIFY local_date DATE NOT NULL;
