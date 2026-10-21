// Resolves a service and the caller's place inside it.
//
// Community roles grant community-wide permissions. Service ranks grant
// permissions inside one service, scoped by the member's assignment:
//
//   department_id NULL -> the permission applies service-wide
//   department_id set  -> the permission applies to that department only
//
// A community permission always wins, so owners keep full access without
// having to join every service.
import { one } from '../db.js'
import { parsePermissions } from './permissions.js'

export async function serviceAccess(req, serviceRef) {
  const service = await one(
    'SELECT * FROM services WHERE community_id = ? AND (slug = ? OR id = ?)',
    [req.community.id, String(serviceRef ?? ''), Number(serviceRef) || 0],
  )
  if (!service) return null

  const membership = await one(
    `SELECT sm.id, sm.membership_id, sm.department_id, sm.rank_id,
            d.name AS department_name, d.slug AS department_slug,
            r.name AS rank_name, r.position AS rank_position,
            r.permissions AS rank_permissions, r.all_departments
       FROM service_members sm
       LEFT JOIN departments d ON d.id = sm.department_id
       LEFT JOIN ranks r ON r.id = sm.rank_id
      WHERE sm.membership_id = ? AND sm.service_id = ?`,
    [req.membership.id, service.id],
  )

  const global = new Set(req.permissions || [])
  const rankPermissions = parsePermissions(membership?.rank_permissions)
  const isMember = !!membership
  const serviceWide = isMember && membership.department_id == null
  const canSeeAll = global.has('services.view') || global.has('services.manage')

  // opts.serviceWideOnly -> ignore department-scoped ranks
  // opts.departmentId     -> require a department-scoped rank to match
  function can(key, opts = {}) {
    if (global.has(key)) return true
    if (!isMember || !rankPermissions.includes(key)) return false
    if (opts.serviceWideOnly) return serviceWide
    if (serviceWide) return true
    if (opts.departmentId == null) return false
    return String(membership.department_id) === String(opts.departmentId)
  }

  const access = {
    service,
    membership: membership
      ? {
          id: membership.id,
          membershipId: membership.membership_id,
          departmentId: membership.department_id,
          departmentName: membership.department_name,
          departmentSlug: membership.department_slug,
          rankId: membership.rank_id,
          rankName: membership.rank_name,
          rankPosition: membership.rank_position,
          allDepartments: !!membership.all_departments,
        }
      : null,
    isMember,
    rankPermissions,
    hasGlobal: (key) => global.has(key),
    can,
    canView: canSeeAll || isMember,
    // Can they see every department in this service?
    canViewAll: canSeeAll || serviceWide,
    canManage: can('services.manage', { serviceWideOnly: true }),
    canManageMembers: can('members.manage'),
    canManageServiceWideMembers: can('members.manage', { serviceWideOnly: true }),
  }

  return access
}

export function canViewDepartment(access, departmentId) {
  if (access.canViewAll) return true
  return (
    !!access.membership &&
    access.membership.departmentId != null &&
    String(access.membership.departmentId) === String(departmentId)
  )
}

// Shape returned to the portal for a service category.
export function serviceSummary(access, departments) {
  const visible = access.canViewAll
    ? departments
    : departments.filter(
        (department) => String(department.id) === String(access.membership?.departmentId),
      )

  return {
    id: access.service.id,
    name: access.service.name,
    slug: access.service.slug,
    description: access.service.description ?? null,
    colour: access.service.colour ?? null,
    position: access.service.position,
    isMember: access.isMember,
    membership: access.membership
      ? {
          departmentId: access.membership.departmentId,
          departmentName: access.membership.departmentName,
          departmentSlug: access.membership.departmentSlug,
          rankId: access.membership.rankId,
          rankName: access.membership.rankName,
        }
      : null,
    permissions: access.rankPermissions,
    canManage: access.canManage,
    canManageMembers: access.canManageMembers,
    canManageServiceWideMembers: access.canManageServiceWideMembers,
    departments: visible.map((department) => ({
      id: department.id,
      name: department.name,
      slug: department.slug,
    })),
  }
}

export function accessView(access) {
  return {
    isMember: access.isMember,
    canManage: access.canManage,
    canManageMembers: access.canManageMembers,
    canManageServiceWideMembers: access.canManageServiceWideMembers,
    membership: access.membership,
    permissions: access.rankPermissions,
  }
}
