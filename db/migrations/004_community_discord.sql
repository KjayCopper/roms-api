-- ============================================================
-- 004 — community Discord invite
--
-- When set, the community's site shows a "Join Discord" button.
-- ============================================================

ALTER TABLE communities
  ADD COLUMN discord_url VARCHAR(255) NULL AFTER theme;
