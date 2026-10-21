// Recruitment access rules.
//
// Community permissions win everywhere. Otherwise a service rank with
// applications.manage can manage vacancies for its service, or just its
// department when the member's posting is department-scoped.
import { query } from '../db.js'
import { parsePermissions } from './permissions.js'

export async function loadRecruitmentAssignments(req) {
  const rows = await query(
    `SELECT sm.service_id, sm.department_id, r.permissions
       FROM service_members sm
       LEFT JOIN ranks r ON r.id = sm.rank_id
      WHERE sm.membership_id = ?`,
    [req.membership.id],
  )

  return rows.map((row) => ({
    serviceId: Number(row.service_id),
    departmentId: row.department_id == null ? null : Number(row.department_id),
    permissions: new Set(parsePermissions(row.permissions)),
  }))
}

export function hasGlobal(req, key) {
  return Array.isArray(req.permissions) && req.permissions.includes(key)
}

export function canManageVacancy(req, assignments, vacancy) {
  if (!vacancy) return false
  if (hasGlobal(req, 'applications.manage')) return true
  if (vacancy.service_id == null) return false

  const assignment = assignments.find(
    (item) => item.serviceId === Number(vacancy.service_id),
  )
  if (!assignment || !assignment.permissions.has('applications.manage')) return false
  if (assignment.departmentId == null) return true

  return (
    vacancy.department_id != null &&
    Number(vacancy.department_id) === assignment.departmentId
  )
}

export function canViewVacancy(req, assignments, vacancy) {
  if (!vacancy) return false
  if (hasGlobal(req, 'applications.view') || hasGlobal(req, 'applications.manage')) return true
  if (canManageVacancy(req, assignments, vacancy)) return true

  // Community-wide internal vacancies are visible to every member of the
  // community. External-only postings are public, not portal content.
  if (vacancy.service_id == null) return vacancy.audience !== 'external'

  const assignment = assignments.find(
    (item) => item.serviceId === Number(vacancy.service_id),
  )
  if (!assignment) return false
  if (
    assignment.permissions.has('applications.view') ||
    assignment.permissions.has('applications.manage')
  ) {
    return true
  }

  // Ordinary service members can see internal/both postings for their service.
  return vacancy.audience !== 'external'
}

export function canApplyToVacancy(req, assignments, vacancy, existingApplication = null) {
  if (!vacancy || vacancy.status !== 'open') return false
  if (vacancy.closes_at && new Date(vacancy.closes_at).getTime() < Date.now()) return false
  if (!['internal', 'both'].includes(vacancy.audience)) return false
  if (existingApplication && existingApplication.status !== 'withdrawn') return false

  if (vacancy.service_id == null) return true
  return assignments.some((item) => item.serviceId === Number(vacancy.service_id))
}

export function canCreateVacancy(req, assignments, { serviceId, departmentId }) {
  if (hasGlobal(req, 'applications.manage')) return true
  if (!serviceId) return false

  const assignment = assignments.find((item) => item.serviceId === Number(serviceId))
  if (!assignment || !assignment.permissions.has('applications.manage')) return false
  if (assignment.departmentId == null) return true

  return departmentId != null && Number(departmentId) === assignment.departmentId
}
