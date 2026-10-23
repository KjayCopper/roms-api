// ---------------------------------------------------------------
// Permissions catalogue + preset roles.
//
// Roles are fully custom per community; these presets are just
// what gets seeded when a community is created.
// ---------------------------------------------------------------

export const PERMISSIONS = [
  'community.settings', // rename, logo, accent colour, tagline
  'community.roles',    // create/edit/delete roles
  'services.view',      // see the community's services
  'services.manage',    // create/edit services, ranks and departments
  'members.view',
  'members.manage',     // assign roles, remove members
  'applications.view',
  'applications.manage',// approve / reject
]

// Permissions that can be granted to a community role. Service-level
// permissions (services.*, members.*, applications.*) are deliberately NOT
// here: they are granted through service ranks, not community roles.
export const COMMUNITY_ROLE_PERMISSIONS = ['community.settings', 'community.roles']

export const ALL_PERMISSIONS = [...PERMISSIONS]

// Permissions that can be attached to a service rank. Community-wide
// permissions (settings, roles) deliberately aren't delegable through a rank.
export const RANK_PERMISSION_OPTIONS = [
  { key: 'services.view', label: 'View the service', group: 'Service' },
  {
    key: 'services.manage',
    label: 'Manage settings, departments and ranks',
    group: 'Service',
  },
  { key: 'members.view', label: 'View the service roster', group: 'Members' },
  { key: 'members.manage', label: 'Add members and assign ranks', group: 'Members' },
  {
    key: 'applications.view',
    label: 'View recruitment vacancies and applications',
    group: 'Recruitment',
  },
  {
    key: 'applications.manage',
    label: 'Create vacancies and manage applications',
    group: 'Recruitment',
  },
]

export const RANK_PERMISSIONS = RANK_PERMISSION_OPTIONS.map((option) => option.key)

export const PRESET_ROLES = [
  {
    key: 'owner',
    name: 'Owner',
    position: 100,
    is_owner: 1,
    is_default: 0,
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'admin',
    name: 'Admin',
    position: 80,
    is_owner: 0,
    is_default: 0,
    permissions: ['community.settings', 'community.roles'],
  },
  {
    key: 'moderator',
    name: 'Moderator',
    position: 50,
    is_owner: 0,
    is_default: 0,
    permissions: [],
  },
  {
    key: 'member',
    name: 'Member',
    position: 10,
    is_owner: 0,
    is_default: 1,
    permissions: [],
  },
]

// mysql2 may hand back JSON columns already parsed, or as a string.
export function parsePermissions(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

// Effective permissions for a role row. Owners always have everything.
export function effectivePermissions(role) {
  if (!role) return []
  if (role.is_owner) return ALL_PERMISSIONS
  // Community roles can only ever grant community-level permissions.
  return parsePermissions(role.permissions).filter((p) =>
    COMMUNITY_ROLE_PERMISSIONS.includes(p),
  )
}

export function sanitisePermissions(list) {
  if (!Array.isArray(list)) return []
  return [...new Set(list.filter((p) => COMMUNITY_ROLE_PERMISSIONS.includes(p)))]
}

// Rank permissions are a narrower set than community permissions.
export function sanitiseRankPermissions(list) {
  if (!Array.isArray(list)) return []
  return [...new Set(list.filter((p) => RANK_PERMISSIONS.includes(p)))]
}
