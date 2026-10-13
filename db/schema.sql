-- ============================================================
--  KGM Cloud ROMS — multi-tenant schema
--  MySQL / MariaDB  (run in phpMyAdmin)
--
--  HOW TO RUN:
--    1. In phpMyAdmin create/select the target database
--       (suggested name: `roms`).
--    2. Import/paste this whole file and execute.
--    3. Point roms-api's DB_NAME at that database.
--
--  Safe to re-run: every statement is IF NOT EXISTS / INSERT IGNORE.
-- ============================================================

SET NAMES utf8mb4;

-- ------------------------------------------------------------
-- Global identity — one row per person, shared across all
-- communities. A user can be in many communities with a
-- different role/name in each.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username          VARCHAR(64)     NULL,            -- chosen at account creation / invite accept
  email             VARCHAR(255)    NOT NULL,
  password_hash     CHAR(128)       NULL,            -- NULL = shadow account (invited, not yet set up)
  salt              CHAR(32)        NULL,
  is_platform_admin TINYINT(1)      NOT NULL DEFAULT 0,
  email_verified    TINYINT(1)      NOT NULL DEFAULT 0,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_login_at     DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- Communities (tenants) — each one maps to a subdomain.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS communities (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug         VARCHAR(63)     NOT NULL,            -- subdomain label, lowercase: scotlandrblx
  name         VARCHAR(100)    NOT NULL,
  tagline      VARCHAR(160)    NULL,
  description  TEXT            NULL,
  logo_url     VARCHAR(255)    NULL,
  accent_color CHAR(7)         NULL,                -- e.g. #0b1f42
  created_by   BIGINT UNSIGNED NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_communities_slug (slug),
  UNIQUE KEY uq_communities_name (name),
  KEY fk_communities_created_by (created_by),
  CONSTRAINT fk_communities_created_by FOREIGN KEY (created_by)
    REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- Roles — custom per community. `permissions` is a JSON array
-- of permission keys, e.g. ["members.view","members.manage"].
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  community_id BIGINT UNSIGNED NOT NULL,
  `key`        VARCHAR(32)     NOT NULL,            -- stable id: owner/admin/moderator/member
  name         VARCHAR(64)     NOT NULL,            -- display name
  position     INT             NOT NULL DEFAULT 0,  -- higher = more senior
  is_owner     TINYINT(1)      NOT NULL DEFAULT 0,  -- built-in, undeletable
  is_default   TINYINT(1)      NOT NULL DEFAULT 0,  -- auto-assigned on join
  permissions  JSON            NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_roles_community_key (community_id, `key`),
  CONSTRAINT fk_roles_community FOREIGN KEY (community_id)
    REFERENCES communities(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- Memberships — the user <-> community join, carrying the
-- per-community persona (display_name) and invite state.
-- status: invited -> active  (+ suspended / rejected / left)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memberships (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id           BIGINT UNSIGNED NOT NULL,
  community_id      BIGINT UNSIGNED NOT NULL,
  role_id           BIGINT UNSIGNED NULL,
  display_name      VARCHAR(64)     NULL,           -- per-community roleplay name (set once, at accept)
  status            ENUM('invited','active','suspended','rejected','left')
                                    NOT NULL DEFAULT 'invited',
  invite_token_hash CHAR(64)        NULL,           -- sha256 of the emailed invite token
  invite_expires_at DATETIME        NULL,
  invited_at        DATETIME        NULL,
  accepted_at       DATETIME        NULL,
  joined_at         DATETIME        NULL,
  assigned_by       BIGINT UNSIGNED NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_memberships_user_community (user_id, community_id),
  KEY idx_memberships_invite_token (invite_token_hash),
  KEY fk_memberships_role (role_id),
  KEY fk_memberships_assigned_by (assigned_by),
  CONSTRAINT fk_memberships_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_memberships_community FOREIGN KEY (community_id)
    REFERENCES communities(id) ON DELETE CASCADE,
  CONSTRAINT fk_memberships_role FOREIGN KEY (role_id)
    REFERENCES roles(id) ON DELETE SET NULL,
  CONSTRAINT fk_memberships_assigned_by FOREIGN KEY (assigned_by)
    REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- Applications — public "apply to join" submissions.
-- No account required; reviewer approves then an invite is sent.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS applications (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  community_id      BIGINT UNSIGNED NOT NULL,
  applicant_name    VARCHAR(100)    NOT NULL,
  applicant_email   VARCHAR(255)    NOT NULL,
  applicant_user_id BIGINT UNSIGNED NULL,           -- linked if they already have an account
  answers           JSON            NULL,           -- the form responses
  status            ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  reviewed_by       BIGINT UNSIGNED NULL,
  reviewed_at       DATETIME        NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_applications_community_status (community_id, status),
  KEY fk_applications_user (applicant_user_id),
  KEY fk_applications_reviewed_by (reviewed_by),
  CONSTRAINT fk_applications_community FOREIGN KEY (community_id)
    REFERENCES communities(id) ON DELETE CASCADE,
  CONSTRAINT fk_applications_user FOREIGN KEY (applicant_user_id)
    REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_applications_reviewed_by FOREIGN KEY (reviewed_by)
    REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- Reserved slugs — subdomains nobody may claim when creating a
-- community. Keep this in sync with your Cosmos/ServApp hosts.
-- (Specific Cosmos routes win over the wildcard anyway, so this
--  is about avoiding dead/confusing communities, not security.)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reserved_slugs (
  slug   VARCHAR(63)  NOT NULL,
  reason VARCHAR(160) NULL,
  PRIMARY KEY (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO reserved_slugs (slug, reason) VALUES
  ('www',       'apex alias'),
  ('api',       'platform API host'),
  ('roms',      'portal host'),
  ('romsapi',   'ROMS API host'),
  ('kgmpma',    'phpMyAdmin'),
  ('pma',       'phpMyAdmin alias'),
  ('dash',      'Cosmos dashboard'),
  ('cosmos',    'Cosmos'),
  ('cosmos-ui', 'Cosmos UI'),
  ('admin',     'reserved'),
  ('mail',      'mail services'),
  ('smtp',      'mail services'),
  ('imap',      'mail services'),
  ('pop',       'mail services'),
  ('webmail',   'mail services'),
  ('ftp',       'infrastructure'),
  ('ns',        'infrastructure'),
  ('ns1',       'infrastructure'),
  ('ns2',       'infrastructure'),
  ('cpanel',    'infrastructure'),
  ('whm',       'infrastructure'),
  ('app',       'reserved'),
  ('portal',    'reserved'),
  ('auth',      'reserved'),
  ('login',     'reserved'),
  ('register',  'reserved'),
  ('dashboard', 'reserved'),
  ('static',    'reserved'),
  ('assets',    'reserved'),
  ('cdn',       'reserved'),
  ('dev',       'reserved'),
  ('staging',   'reserved'),
  ('test',      'reserved'),
  ('status',    'reserved'),
  ('support',   'reserved'),
  ('help',      'reserved'),
  ('docs',      'reserved'),
  ('blog',      'reserved');

-- ------------------------------------------------------------
-- Email verification — 6-digit codes for the sign-up flow.
-- One active code per user (replaced whenever a new one is sent).
-- ------------------------------------------------------------
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
