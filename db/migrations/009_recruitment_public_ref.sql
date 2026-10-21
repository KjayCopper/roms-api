-- ============================================================
-- 009 — public application links
--
-- External vacancies are published as /application/<ref>. The
-- reference is a random 32 character token, so the numeric id is
-- never exposed and the links cannot be guessed or enumerated.
--
-- Safe to run more than once: the column and the index are only
-- added when they are missing, and existing rows are backfilled.
-- ============================================================

-- 1. Add the column (if it is not there yet)
SET @has_public_ref := (
  SELECT COUNT(*)
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'recruitment_vacancies'
     AND COLUMN_NAME = 'public_ref'
);

SET @add_public_ref := IF(
  @has_public_ref = 0,
  'ALTER TABLE recruitment_vacancies ADD COLUMN public_ref CHAR(32) NULL AFTER id',
  'SELECT ''recruitment_vacancies.public_ref already exists'''
);

PREPARE stmt FROM @add_public_ref;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Give every existing vacancy a reference
UPDATE recruitment_vacancies
   SET public_ref = LOWER(MD5(CONCAT(id, ':', RAND(), ':', NOW())))
 WHERE public_ref IS NULL;

-- 3. Make it required
SET @public_ref_nullable := (
  SELECT IS_NULLABLE
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'recruitment_vacancies'
     AND COLUMN_NAME = 'public_ref'
);

SET @require_public_ref := IF(
  @public_ref_nullable = 'YES',
  'ALTER TABLE recruitment_vacancies MODIFY public_ref CHAR(32) NOT NULL',
  'SELECT ''recruitment_vacancies.public_ref is already required'''
);

PREPARE stmt FROM @require_public_ref;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 4. One reference per vacancy
SET @has_public_ref_index := (
  SELECT COUNT(*)
    FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'recruitment_vacancies'
     AND INDEX_NAME = 'uq_recruitment_vacancies_public_ref'
);

SET @add_public_ref_index := IF(
  @has_public_ref_index = 0,
  'ALTER TABLE recruitment_vacancies ADD UNIQUE KEY uq_recruitment_vacancies_public_ref (public_ref)',
  'SELECT ''uq_recruitment_vacancies_public_ref already exists'''
);

PREPARE stmt FROM @add_public_ref_index;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
