-- ============================================================
-- 008 — service logos
--
-- Services only had a colour, so the public vacancy board had no
-- way to show which service a vacancy belonged to. This adds an
-- optional logo, uploaded through the portal and stored as a
-- path under /uploads.
--
-- Safe to run more than once: the column is only added when it is
-- missing.
-- ============================================================

SET @has_logo_url := (
  SELECT COUNT(*)
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'services'
     AND COLUMN_NAME = 'logo_url'
);

SET @add_logo_url := IF(
  @has_logo_url = 0,
  'ALTER TABLE services ADD COLUMN logo_url VARCHAR(255) NULL AFTER colour',
  'SELECT ''services.logo_url already exists'''
);

PREPARE stmt FROM @add_logo_url;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
