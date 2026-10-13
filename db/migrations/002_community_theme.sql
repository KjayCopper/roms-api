-- ============================================================
-- 002 — per-community theme
--
-- The community owner picks light or dark; it applies to every
-- member of that community. Existing communities default to light.
-- ============================================================

ALTER TABLE communities
  ADD COLUMN theme ENUM('light', 'dark') NOT NULL DEFAULT 'light' AFTER accent_color;
