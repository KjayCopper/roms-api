-- ============================================================
-- 003 — community website pages
--
-- Each community gets one (or more) editable page. `draft` is what
-- the site editor writes; `published` is what visitors see. A
-- community is created with a default layout already published.
-- ============================================================

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
