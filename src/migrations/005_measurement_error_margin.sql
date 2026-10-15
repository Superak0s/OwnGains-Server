ALTER TABLE measurements
  ADD COLUMN error_margin DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER note,
  ADD CONSTRAINT ck_m_error_margin CHECK (error_margin BETWEEN 0 AND 100);
