-- ============================================================
-- 007 — central recruitment
--
-- A vacancy is a posting for a service, department and/or rank.
-- Vacancies can be internal, external or both. External applications are
-- accepted from the public site; internal ones are accepted in the portal.
--
-- Scoping follows the existing service rank model:
--   * community applications.manage -> every vacancy in the community
--   * service-wide rank permission  -> every vacancy in that service
--   * department-scoped rank        -> vacancies for that department
--
-- Safe to run once in phpMyAdmin. Re-running is harmless.
-- ============================================================

CREATE TABLE IF NOT EXISTS recruitment_vacancies (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  community_id  BIGINT UNSIGNED NOT NULL,
  service_id    BIGINT UNSIGNED NULL,               -- NULL = community-wide vacancy
  department_id BIGINT UNSIGNED NULL,               -- optional posting location
  rank_id       BIGINT UNSIGNED NULL,               -- optional rank being recruited
  title         VARCHAR(120)    NOT NULL,
  description   TEXT            NULL,
  audience      ENUM('internal','external','both') NOT NULL DEFAULT 'internal',
  status        ENUM('draft','open','closed')       NOT NULL DEFAULT 'open',
  closes_at     DATETIME        NULL,
  created_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_recruitment_vacancies_community (community_id, status, created_at),
  KEY idx_recruitment_vacancies_service (service_id, status),
  KEY idx_recruitment_vacancies_department (department_id),
  KEY idx_recruitment_vacancies_rank (rank_id),
  KEY fk_recruitment_vacancies_created_by (created_by),
  CONSTRAINT fk_recruitment_vacancies_community FOREIGN KEY (community_id)
    REFERENCES communities(id) ON DELETE CASCADE,
  CONSTRAINT fk_recruitment_vacancies_service FOREIGN KEY (service_id)
    REFERENCES services(id) ON DELETE CASCADE,
  CONSTRAINT fk_recruitment_vacancies_department FOREIGN KEY (department_id)
    REFERENCES departments(id) ON DELETE SET NULL,
  CONSTRAINT fk_recruitment_vacancies_rank FOREIGN KEY (rank_id)
    REFERENCES ranks(id) ON DELETE SET NULL,
  CONSTRAINT fk_recruitment_vacancies_created_by FOREIGN KEY (created_by)
    REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS recruitment_applications (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  vacancy_id        BIGINT UNSIGNED NOT NULL,
  community_id      BIGINT UNSIGNED NOT NULL,
  applicant_user_id BIGINT UNSIGNED NULL,
  applicant_name    VARCHAR(100)    NOT NULL,
  applicant_email   VARCHAR(255)    NOT NULL,
  message           TEXT            NULL,
  status            ENUM('pending','shortlisted','accepted','rejected','withdrawn')
                                    NOT NULL DEFAULT 'pending',
  reviewed_by       BIGINT UNSIGNED NULL,
  reviewed_at       DATETIME        NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_recruitment_applications_vacancy_user (vacancy_id, applicant_user_id),
  KEY idx_recruitment_applications_community_status (community_id, status, created_at),
  KEY idx_recruitment_applications_vacancy (vacancy_id, status),
  KEY fk_recruitment_applications_user (applicant_user_id),
  KEY fk_recruitment_applications_reviewer (reviewed_by),
  CONSTRAINT fk_recruitment_applications_vacancy FOREIGN KEY (vacancy_id)
    REFERENCES recruitment_vacancies(id) ON DELETE CASCADE,
  CONSTRAINT fk_recruitment_applications_community FOREIGN KEY (community_id)
    REFERENCES communities(id) ON DELETE CASCADE,
  CONSTRAINT fk_recruitment_applications_user FOREIGN KEY (applicant_user_id)
    REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_recruitment_applications_reviewer FOREIGN KEY (reviewed_by)
    REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
