-- ============================================================
-- 005 — community services
--
-- A service is a top-level unit inside a community, e.g. Police,
-- Ambulance or Fire. Departments, ranks and applications will
-- hang off it in later migrations.
--
-- Safe to run once in phpMyAdmin. Re-running is harmless.
-- ============================================================

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
