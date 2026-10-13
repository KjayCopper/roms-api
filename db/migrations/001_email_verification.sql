-- ============================================================
--  KGM Cloud ROMS — migration 001
--  Email verification codes for the account sign-up flow.
--
--  Run once in phpMyAdmin against the `roms` database.
--  (Re-running db/schema.sql also creates this table.)
-- ============================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS email_verifications (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  code_hash  CHAR(64)        NOT NULL,   -- sha256 of the 6-digit code
  expires_at DATETIME        NOT NULL,
  attempts   INT             NOT NULL DEFAULT 0,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_email_verifications_user (user_id),
  CONSTRAINT fk_email_verifications_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
