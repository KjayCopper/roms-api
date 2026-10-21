-- ============================================================
-- 006 — service structure: departments, ranks, members
--
-- A service (Police, Fire, ...) owns:
--   * departments — e.g. Roads Policing, Response
--   * ranks       — e.g. Chief Constable, Inspector, PC
--   * members     — a community membership assigned to the service,
--                   optionally to a department and a rank
--
-- Rank permissions are scoped by the member's assignment:
--   * department_id NULL  -> permissions apply across the service
--   * department_id set   -> permissions apply to that department
--
-- Safe to run once in phpMyAdmin. Re-running is harmless.
-- ============================================================

CREATE TABLE IF NOT EXISTS departments (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_id   BIGINT UNSIGNED NOT NULL,
  name         VARCHAR(80)     NOT NULL,
  slug         VARCHAR(63)     NOT NULL,            -- stable key, e.g. roads-policing
  description  VARCHAR(500)    NULL,
  position     INT             NOT NULL DEFAULT 0,  -- display order, lower first
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
  position        INT             NOT NULL DEFAULT 0,  -- higher = more senior
  all_departments TINYINT(1)      NOT NULL DEFAULT 1,  -- can this rank be held in any department?
  permissions     JSON            NULL,                -- array of permission keys
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ranks_service_name (service_id, name),
  CONSTRAINT fk_ranks_service FOREIGN KEY (service_id)
    REFERENCES services(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which departments a department-limited rank can be held in.
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
  department_id BIGINT UNSIGNED NULL,   -- NULL = service-wide posting
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
