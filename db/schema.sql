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
  theme        ENUM('light','dark') NOT NULL DEFAULT 'light', -- owner's pick, applied to all members
  discord_url  VARCHAR(255)    NULL,                -- optional invite; shows a Join Discord button
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
-- Services — top-level units inside a community (Police,
-- Ambulance, Fire, ...). Departments, ranks and applications
-- will hang off these in later migrations.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS services (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  community_id BIGINT UNSIGNED NOT NULL,
  name         VARCHAR(80)     NOT NULL,
  slug         VARCHAR(63)     NOT NULL,            -- stable key, e.g. roads-policing
  description  VARCHAR(500)    NULL,
  colour       CHAR(7)         NULL,                -- optional hex, e.g. #014b7f
  position     INT             NOT NULL DEFAULT 0,  -- display order, lower first
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_services_community_name (community_id, name),
  UNIQUE KEY uq_services_community_slug (community_id, slug),
  CONSTRAINT fk_services_community FOREIGN KEY (community_id)
    REFERENCES communities(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- Roles - custom per community. `permissions` is a JSON array
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

-- ------------------------------------------------------------
-- Community website pages — the site editor's draft/published
-- layout. A default layout is published when a community is made.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_pages (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  community_id BIGINT UNSIGNED NOT NULL,
  page_slug    VARCHAR(63)     NOT NULL DEFAULT 'home',
  draft        JSON            NOT NULL,
  published    JSON            NOT NULL,
  published_at DATETIME        NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_community_pages (community_id, page_slug),
  CONSTRAINT fk_community_pages_community FOREIGN KEY (community_id)
    REFERENCES communities(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- Service structure — departments, ranks and service members.
-- Rank permissions are scoped by the member's assignment:
-- department_id NULL = service-wide, otherwise that department.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS departments (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_id   BIGINT UNSIGNED NOT NULL,
  name         VARCHAR(80)     NOT NULL,
  slug         VARCHAR(63)     NOT NULL,
  description  VARCHAR(500)    NULL,
  position     INT             NOT NULL DEFAULT 0,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_departments_service_name (service_id, name),
  UNIQUE KEY uq_departments_service_slug (service_id, slug),
  CONSTRAINT fk_departments_service FOREIGN KEY (service_id)
    REFERENCES services(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ranks (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_id      BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(80)     NOT NULL,
  position        INT             NOT NULL DEFAULT 0,
  all_departments TINYINT(1)      NOT NULL DEFAULT 1,
  permissions     JSON            NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ranks_service_name (service_id, name),
  CONSTRAINT fk_ranks_service FOREIGN KEY (service_id)
    REFERENCES services(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rank_departments (
  rank_id       BIGINT UNSIGNED NOT NULL,
  department_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (rank_id, department_id),
  KEY idx_rank_departments_department (department_id),
  CONSTRAINT fk_rank_departments_rank FOREIGN KEY (rank_id)
    REFERENCES ranks(id) ON DELETE CASCADE,
  CONSTRAINT fk_rank_departments_department FOREIGN KEY (department_id)
    REFERENCES departments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_members (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  membership_id BIGINT UNSIGNED NOT NULL,
  service_id    BIGINT UNSIGNED NOT NULL,
  department_id BIGINT UNSIGNED NULL,
  rank_id       BIGINT UNSIGNED NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_service_members_membership_service (membership_id, service_id),
  KEY idx_service_members_service (service_id),
  KEY idx_service_members_department (department_id),
  KEY idx_service_members_rank (rank_id),
  CONSTRAINT fk_service_members_membership FOREIGN KEY (membership_id)
    REFERENCES memberships(id) ON DELETE CASCADE,
  CONSTRAINT fk_service_members_service FOREIGN KEY (service_id)
    REFERENCES services(id) ON DELETE CASCADE,
  CONSTRAINT fk_service_members_department FOREIGN KEY (department_id)
    REFERENCES departments(id) ON DELETE SET NULL,
  CONSTRAINT fk_service_members_rank FOREIGN KEY (rank_id)
    REFERENCES ranks(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
