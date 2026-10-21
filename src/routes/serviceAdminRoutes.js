// Service administration: dashboard, departments, ranks and the service roster.
//
// Access is resolved by serviceAccess(): community permissions apply
// everywhere, while rank permissions apply only inside the member's service
// (and department, when their posting is department-scoped).
import { Router } from 'express'
import { pool, one, query, withTransaction } from '../db.js'
import { requireAuth, communityContext } from '../lib/auth.js'
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../lib/util.js'
import {
  RANK_PERMISSION_OPTIONS,
  sanitiseRankPermissions,
} from '../lib/permissions.js'
import { accessView, canViewDepartment, serviceAccess } from '../lib/serviceAccess.js'

const router = Router()
const ctx = communityContext

const MAX_NAME = 80
const MAX_DESCRIPTION = 500

function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

function readName(value, label = 'Name') {
  const name = String(value ?? '').trim()
  if (!name || name.length > MAX_NAME) {
    throw badRequest(`${label} is required (max ${MAX_NAME} characters)`, { field: 'name' })
  }
  return name
}

function readDescription(value) {
  if (value == null || value === '') return null
  const description = String(value).trim()
  if (description.length > MAX_DESCRIPTION) {
    throw badRequest(`Description is too long (max ${MAX_DESCRIPTION} characters)`, {
      field: 'description',
    })
  }
  return description
}

function readPosition(value, fallback) {
  if (value == null || value === '') return fallback
  const position = Number(value)
  if (!Number.isFinite(position)) {
    throw badRequest('Position must be a number', { field: 'position' })
  }
  return Math.trunc(position)
}

function readBoolean(value, fallback) {
  if (value === undefined) return fallback
  return value === true || value === 1 || value === '1'
}

async function uniqueDepartmentSlug(serviceId, base, excludeId = null) {
  const root = slugify(base) || 'department'
  let slug = root
  let n = 2
  for (;;) {
    const existing = await one(
      `SELECT id FROM departments
        WHERE service_id = ? AND slug = ?${excludeId ? ' AND id <> ?' : ''}`,
      excludeId ? [serviceId, slug, excludeId] : [serviceId, slug],
    )
    if (!existing) return slug
    const suffix = `-${n++}`
    slug = `${root.slice(0, 63 - suffix.length)}${suffix}`
  }
}

async function accessOrThrow(req) {
  const access = await serviceAccess(req, req.params.serviceId)
  if (!access) throw notFound('Service not found')
  if (!access.canView) throw forbidden('You do not have access to this service')
  return access
}

function requireManage(access) {
  if (!access.canManage) throw forbidden('Missing permission: services.manage')
}

async function findDepartment(serviceId, id) {
  const department = await one('SELECT * FROM departments WHERE id = ? AND service_id = ?', [
    id,
    serviceId,
  ])
  if (!department) throw notFound('Department not found')
  return department
}

async function findRank(serviceId, id) {
  const rank = await one('SELECT * FROM ranks WHERE id = ? AND service_id = ?', [id, serviceId])
  if (!rank) throw notFound('Rank not found')
  return rank
}

async function findServiceMember(serviceId, id) {
  const member = await loadMember(serviceId, id)
  if (!member) throw notFound('Service member not found')
  return member
}

function serviceView(service) {
  return {
    id: service.id,
    name: service.name,
    slug: service.slug,
    description: service.description ?? null,
    colour: service.colour ?? null,
    position: service.position,
  }
}

function departmentView(department) {
  return {
    id: department.id,
    name: department.name,
    slug: department.slug,
    description: department.description ?? null,
    position: department.position,
    memberCount: Number(department.member_count ?? 0),
  }
}

function memberView(row) {
  return {
    id: row.id,
    membershipId: row.membership_id,
    displayName: row.display_name || row.username || row.email,
    username: row.username ?? null,
    email: row.email,
    departmentId: row.department_id,
    departmentName: row.department_name ?? null,
    departmentSlug: row.department_slug ?? null,
    rankId: row.rank_id,
    rankName: row.rank_name ?? null,
    rankPosition: row.rank_position ?? null,
    createdAt: row.created_at,
  }
}

const MEMBER_COLUMNS = `
  sm.id, sm.membership_id, sm.department_id, sm.rank_id, sm.created_at,
  m.display_name, u.email, u.username,
  d.name AS department_name, d.slug AS department_slug,
  r.name AS rank_name, r.position AS rank_position`

async function loadMember(serviceId, id) {
  const row = await one(
    `SELECT ${MEMBER_COLUMNS}
       FROM service_members sm
       JOIN memberships m ON m.id = sm.membership_id
       JOIN users u ON u.id = m.user_id
       LEFT JOIN departments d ON d.id = sm.department_id
       LEFT JOIN ranks r ON r.id = sm.rank_id
      WHERE sm.service_id = ? AND sm.id = ?`,
    [serviceId, id],
  )
  return row ? memberView(row) : null
}

async function loadMembers(serviceId, departmentId = null) {
  const rows = await query(
    `SELECT ${MEMBER_COLUMNS}
       FROM service_members sm
       JOIN memberships m ON m.id = sm.membership_id
       JOIN users u ON u.id = m.user_id
       LEFT JOIN departments d ON d.id = sm.department_id
       LEFT JOIN ranks r ON r.id = sm.rank_id
      WHERE sm.service_id = ?${departmentId ? ' AND sm.department_id = ?' : ''}
      ORDER BY r.position DESC, COALESCE(m.display_name, u.username, u.email) ASC`,
    departmentId ? [serviceId, departmentId] : [serviceId],
  )
  return rows.map(memberView)
}

async function loadDepartments(serviceId) {
  const rows = await query(
    `SELECT d.id, d.name, d.slug, d.description, d.position,
            (SELECT COUNT(*) FROM service_members sm WHERE sm.department_id = d.id) AS member_count
       FROM departments d
      WHERE d.service_id = ?
      ORDER BY d.position ASC, d.name ASC`,
    [serviceId],
  )
  return rows.map(departmentView)
}

async function loadRanks(serviceId) {
  const rows = await query(
    `SELECT r.id, r.name, r.position, r.all_departments,
            r.permissions, r.created_at, r.updated_at,
            (SELECT COUNT(*) FROM service_members sm WHERE sm.rank_id = r.id) AS member_count
       FROM ranks r
      WHERE r.service_id = ?
      ORDER BY r.position DESC, r.name ASC`,
    [serviceId],
  )
  const links = await query(
    `SELECT rd.rank_id, rd.department_id
       FROM rank_departments rd
       JOIN ranks r ON r.id = rd.rank_id
      WHERE r.service_id = ?`,
    [serviceId],
  )
  const linksByRank = new Map()
  for (const link of links) {
    if (!linksByRank.has(link.rank_id)) linksByRank.set(link.rank_id, [])
    linksByRank.get(link.rank_id).push(link.department_id)
  }

  return rows.map((rank) => ({
    id: rank.id,
    name: rank.name,
    position: rank.position,
    allDepartments: !!rank.all_departments,
    permissions: parseRankPermissions(rank.permissions),
    departmentIds: linksByRank.get(rank.id) || [],
    memberCount: Number(rank.member_count ?? 0),
    createdAt: rank.created_at,
    updatedAt: rank.updated_at,
  }))
}

function parseRankPermissions(value) {
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

async function readDepartmentIds(serviceId, value) {
  if (value === undefined) return null
  if (!Array.isArray(value)) throw badRequest('Departments must be a list', { field: 'departmentIds' })

  const ids = [...new Set(value.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
  if (!ids.length) return []

  const rows = await query(
    `SELECT id FROM departments
      WHERE service_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    [serviceId, ...ids],
  )
  if (rows.length !== ids.length) {
    throw badRequest('One or more departments do not belong to this service', {
      field: 'departmentIds',
    })
  }
  return ids
}

async function syncRankDepartments(conn, rankId, departmentIds) {
  await conn.query('DELETE FROM rank_departments WHERE rank_id = ?', [rankId])
  if (!departmentIds.length) return
  await conn.query(
    `INSERT INTO rank_departments (rank_id, department_id) VALUES ${departmentIds
      .map(() => '(?, ?)')
      .join(', ')}`,
    departmentIds.flatMap((departmentId) => [rankId, departmentId]),
  )
}

async function assertRankForDepartment(serviceId, rankId, departmentId) {
  if (!rankId) return null
  const rank = await findRank(serviceId, rankId)
  if (!rank.all_departments) {
    if (departmentId == null) {
      throw badRequest('That rank only applies to specific departments')
    }
    const link = await one(
      'SELECT 1 AS ok FROM rank_departments WHERE rank_id = ? AND department_id = ?',
      [rank.id, departmentId],
    )
    if (!link) throw badRequest('That rank does not apply to the chosen department')
  }
  return rank
}

// Community managers and service heads can assign any rank. Everyone else
// must stay at or below their own rank and can only hand out permissions they
// hold themselves.
function canAssignFreely(access) {
  return (
    access.hasGlobal('members.manage') ||
    access.hasGlobal('services.manage') ||
    access.canManage
  )
}

function assertRankAssignable(access, rank) {
  if (!rank || canAssignFreely(access)) return

  const held = new Set(access.rankPermissions)
  const extra = parseRankPermissions(rank.permissions).filter(
    (permission) => !held.has(permission),
  )
  if (extra.length) {
    throw forbidden('You cannot assign a rank with permissions you do not hold')
  }

  const ownPosition = access.membership?.rankPosition
  if (ownPosition != null && rank.position > ownPosition) {
    throw forbidden('You cannot assign a rank more senior than your own')
  }
}

async function readDepartment(serviceId, value) {
  if (value == null || value === '') return null
  const department = await one('SELECT * FROM departments WHERE id = ? AND service_id = ?', [
    Number(value),
    serviceId,
  ])
  if (!department) throw badRequest('Department not found in this service', { field: 'departmentId' })
  return department
}

// ---------------------------------------------------------------
// GET /api/dashboard/services/:serviceId
// Service dashboard.
// ---------------------------------------------------------------
router.get(
  '/dashboard/services/:serviceId',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const access = await accessOrThrow(req)
    const { service } = access

    const counts = await one(
      `SELECT
         (SELECT COUNT(*) FROM service_members WHERE service_id = ?) AS members,
         (SELECT COUNT(*) FROM departments WHERE service_id = ?) AS departments,
         (SELECT COUNT(*) FROM ranks WHERE service_id = ?) AS ranks`,
      [service.id, service.id, service.id],
    )

    let departments = await loadDepartments(service.id)
    if (!access.canViewAll) {
      departments = departments.filter(
        (department) => String(department.id) === String(access.membership?.departmentId),
      )
    }

    res.json({
      service: serviceView(service),
      departments,
      counts: {
        members: Number(counts?.members ?? 0),
        departments: Number(counts?.departments ?? 0),
        ranks: Number(counts?.ranks ?? 0),
      },
      access: accessView(access),
    })
  }),
)

// ---------------------------------------------------------------
// Departments
// ---------------------------------------------------------------
router.get(
  '/dashboard/services/:serviceId/departments',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const access = await accessOrThrow(req)
    let departments = await loadDepartments(access.service.id)
    if (!access.canViewAll) {
      departments = departments.filter(
        (department) => String(department.id) === String(access.membership?.departmentId),
      )
    }
    res.json({ departments })
  }),
)

router.post(
  '/dashboard/services/:serviceId/departments',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const access = await accessOrThrow(req)
    requireManage(access)
    const { service } = access

    const name = readName(req.body?.name, 'Department name')
    const description = readDescription(req.body?.description)

    const existing = await one('SELECT id FROM departments WHERE service_id = ? AND name = ?', [
      service.id,
      name,
    ])
    if (existing) throw conflict('A department with that name already exists', { field: 'name' })

    const slug = await uniqueDepartmentSlug(service.id, name)
    const next = await one(
      'SELECT COALESCE(MAX(position), 0) + 10 AS position FROM departments WHERE service_id = ?',
      [service.id],
    )
    const position = readPosition(req.body?.position, next.position)

    const [result] = await pool.query(
      `INSERT INTO departments (service_id, name, slug, description, position)
       VALUES (?, ?, ?, ?, ?)`,
      [service.id, name, slug, description, position],
    )

    const department = await one('SELECT * FROM departments WHERE id = ?', [result.insertId])
    res.status(201).json({ department: departmentView(department) })
  }),
)

router.patch(
  '/dashboard/services/:serviceId/departments/:departmentId',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const access = await accessOrThrow(req)
    requireManage(access)
    const department = await findDepartment(access.service.id, req.params.departmentId)

    const name = req.body?.name != null ? readName(req.body.name, 'Department name') : department.name
    if (name !== department.name) {
      const existing = await one(
        'SELECT id FROM departments WHERE service_id = ? AND name = ? AND id <> ?',
        [access.service.id, name, department.id],
      )
      if (existing) throw conflict('A department with that name already exists', { field: 'name' })
    }

    const description =
      req.body?.description !== undefined
        ? readDescription(req.body.description)
        : department.description
    const position =
      req.body?.position !== undefined
        ? readPosition(req.body.position, department.position)
        : department.position

    await pool.query(
      'UPDATE departments SET name = ?, description = ?, position = ? WHERE id = ?',
      [name, description, position, department.id],
    )
    const updated = await one('SELECT * FROM departments WHERE id = ?', [department.id])
    res.json({ department: departmentView(updated) })
  }),
)

router.delete(
  '/dashboard/services/:serviceId/departments/:departmentId',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const access = await accessOrThrow(req)
    requireManage(access)
    const department = await findDepartment(access.service.id, req.params.departmentId)

    const cleared = await withTransaction(async (conn) => {
      // A department deletion makes its members service-wide. Clear their rank
      // first so a department-scoped permission can never become service-wide.
      const [result] = await conn.query(
        'UPDATE service_members SET rank_id = NULL WHERE department_id = ?',
        [department.id],
      )
      await conn.query('DELETE FROM departments WHERE id = ?', [department.id])
      return result.affectedRows
    })

    res.json({ ok: true, ranksCleared: cleared })
  }),
)

// ---------------------------------------------------------------
// GET /api/dashboard/services/:serviceId/departments/:departmentId
// Department page (by id or slug).
// ---------------------------------------------------------------
router.get(
  '/dashboard/services/:serviceId/departments/:departmentId',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const access = await accessOrThrow(req)
    const department = await one(
      'SELECT * FROM departments WHERE service_id = ? AND (slug = ? OR id = ?)',
      [
        access.service.id,
        String(req.params.departmentId ?? ''),
        Number(req.params.departmentId) || 0,
      ],
    )
    if (!department) throw notFound('Department not found')
    if (!canViewDepartment(access, department.id)) {
      throw forbidden('You do not have access to this department')
    }

    const members = await loadMembers(access.service.id, department.id)

    res.json({
      service: serviceView(access.service),
      department: { ...departmentView({ ...department, member_count: members.length }) },
      members,
      access: accessView(access),
    })
  }),
)

// ---------------------------------------------------------------
// Ranks
// ---------------------------------------------------------------
router.get(
  '/dashboard/services/:serviceId/ranks',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const access = await accessOrThrow(req)
    res.json({
      ranks: await loadRanks(access.service.id),
      departments: await loadDepartments(access.service.id),
      availablePermissions: RANK_PERMISSION_OPTIONS,
    })
  }),
)

router.post(
  '/dashboard/services/:serviceId/ranks',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const access = await accessOrThrow(req)
    requireManage(access)
    const { service } = access

    const name = readName(req.body?.name, 'Rank name')
    const existing = await one('SELECT id FROM ranks WHERE service_id = ? AND name = ?', [
      service.id,
      name,
    ])
    if (existing) throw conflict('A rank with that name already exists', { field: 'name' })

    const allDepartments = readBoolean(req.body?.allDepartments, true)
    const departmentIds = (await readDepartmentIds(service.id, req.body?.departmentIds)) || []
    if (!allDepartments && !departmentIds.length) {
      throw badRequest('Choose at least one department for this rank', { field: 'departmentIds' })
    }

    const next = await one(
      'SELECT COALESCE(MAX(position), 0) + 10 AS position FROM ranks WHERE service_id = ?',
      [service.id],
    )
    const position = readPosition(req.body?.position, next.position)
    const permissions = sanitiseRankPermissions(req.body?.permissions)

    const rankId = await withTransaction(async (conn) => {
      const [result] = await conn.query(
        `INSERT INTO ranks (service_id, name, position, all_departments, permissions)
         VALUES (?, ?, ?, ?, ?)`,
        [service.id, name, position, allDepartments ? 1 : 0, JSON.stringify(permissions)],
      )
      await syncRankDepartments(conn, result.insertId, allDepartments ? [] : departmentIds)
      return result.insertId
    })

    const rank = (await loadRanks(service.id)).find((item) => item.id === rankId)
    res.status(201).json({ rank })
  }),
)

router.patch(
  '/dashboard/services/:serviceId/ranks/:rankId',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const access = await accessOrThrow(req)
    requireManage(access)
    const rank = await findRank(access.service.id, req.params.rankId)

    const name = req.body?.name != null ? readName(req.body.name, 'Rank name') : rank.name
    if (name !== rank.name) {
      const existing = await one(
        'SELECT id FROM ranks WHERE service_id = ? AND name = ? AND id <> ?',
        [access.service.id, name, rank.id],
      )
      if (existing) throw conflict('A rank with that name already exists', { field: 'name' })
    }

    const allDepartments =
      req.body?.allDepartments !== undefined
        ? readBoolean(req.body.allDepartments, !!rank.all_departments)
        : !!rank.all_departments
    const providedDepartments = await readDepartmentIds(
      access.service.id,
      req.body?.departmentIds,
    )
    let departmentIds = providedDepartments
    if (departmentIds == null) {
      const links = await query('SELECT department_id FROM rank_departments WHERE rank_id = ?', [
        rank.id,
      ])
      departmentIds = links.map((link) => link.department_id)
    }
    if (!allDepartments && !departmentIds.length) {
      throw badRequest('Choose at least one department for this rank', { field: 'departmentIds' })
    }

    // Moving a rank to a narrower set of departments must not silently strand
    // members outside its scope.
    if (!allDepartments) {
      const placeholders = departmentIds.map(() => '?').join(',')
      const stranded = await one(
        `SELECT COUNT(*) AS count
           FROM service_members
          WHERE rank_id = ?
            AND (department_id IS NULL OR department_id NOT IN (${placeholders}))`,
        [rank.id, ...departmentIds],
      )
      if (Number(stranded?.count ?? 0) > 0) {
        throw conflict(
          `${stranded.count} member(s) holding this rank are outside those departments. Move them first.`,
        )
      }
    }

    const position =
      req.body?.position !== undefined
        ? readPosition(req.body.position, rank.position)
        : rank.position
    const permissions =
      req.body?.permissions !== undefined
        ? sanitiseRankPermissions(req.body.permissions)
        : parseRankPermissions(rank.permissions)

    await withTransaction(async (conn) => {
      await conn.query(
        `UPDATE ranks
            SET name = ?, position = ?, all_departments = ?, permissions = ?
          WHERE id = ?`,
        [
          name,
          position,
          allDepartments ? 1 : 0,
          JSON.stringify(permissions),
          rank.id,
        ],
      )
      if (allDepartments || providedDepartments != null) {
        await syncRankDepartments(conn, rank.id, allDepartments ? [] : departmentIds)
      }
    })

    const updated = (await loadRanks(access.service.id)).find((item) => item.id === rank.id)
    res.json({ rank: updated })
  }),
)

router.delete(
  '/dashboard/services/:serviceId/ranks/:rankId',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const access = await accessOrThrow(req)
    requireManage(access)
    const rank = await findRank(access.service.id, req.params.rankId)
    await pool.query('DELETE FROM ranks WHERE id = ?', [rank.id])
    res.json({ ok: true })
  }),
)

// ---------------------------------------------------------------
// Service members
// ---------------------------------------------------------------
router.get(
  '/dashboard/services/:serviceId/members',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const access = await accessOrThrow(req)
    let departments = await loadDepartments(access.service.id)
    if (!access.canViewAll) {
      departments = departments.filter(
        (department) => String(department.id) === String(access.membership?.departmentId),
      )
    }
    res.json({
      service: serviceView(access.service),
      members: await loadMembers(access.service.id),
      ranks: await loadRanks(access.service.id),
      departments,
      access: accessView(access),
    })
  }),
)

router.get(
  '/dashboard/services/:serviceId/candidates',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const access = await accessOrThrow(req)
    if (!access.canManageMembers) throw forbidden('Missing permission: members.manage')

    const q = String(req.query.q || '').trim()
    const like = `%${q}%`
    const rows = await query(
      `SELECT m.id AS membership_id, m.display_name, u.email, u.username
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN service_members sm
           ON sm.membership_id = m.id AND sm.service_id = ?
        WHERE m.community_id = ? AND m.status = 'active' AND sm.id IS NULL
          AND (? = '' OR m.display_name LIKE ? OR u.email LIKE ? OR u.username LIKE ?)
        ORDER BY COALESCE(m.display_name, u.username, u.email) ASC
        LIMIT 25`,
      [access.service.id, req.community.id, q, like, like, like],
    )

    res.json({
      candidates: rows.map((row) => ({
        membershipId: row.membership_id,
        displayName: row.display_name || row.username || row.email,
        username: row.username ?? null,
        email: row.email,
      })),
    })
  }),
)

router.post(
  '/dashboard/services/:serviceId/members',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const access = await accessOrThrow(req)
    if (!access.canManageMembers) throw forbidden('Missing permission: members.manage')
    const { service } = access

    const membershipId = Number(req.body?.membershipId)
    if (!Number.isInteger(membershipId) || membershipId <= 0) {
      throw badRequest('Choose a community member', { field: 'membershipId' })
    }
    const membership = await one(
      'SELECT id, status FROM memberships WHERE id = ? AND community_id = ?',
      [membershipId, req.community.id],
    )
    if (!membership || membership.status !== 'active') {
      throw badRequest('Choose an active community member', { field: 'membershipId' })
    }

    const existing = await one(
      'SELECT id FROM service_members WHERE membership_id = ? AND service_id = ?',
      [membershipId, service.id],
    )
    if (existing) throw conflict('That member is already in this service')

    const department = await readDepartment(service.id, req.body?.departmentId)
    const departmentId = department?.id ?? null

    if (!access.canManageServiceWideMembers) {
      if (departmentId == null) {
        throw forbidden('You can only add members to your own department')
      }
      if (!access.can('members.manage', { departmentId })) {
        throw forbidden('You can only add members to your own department')
      }
    }

    const rankId = req.body?.rankId ? Number(req.body.rankId) : null
    const rank = await assertRankForDepartment(service.id, rankId, departmentId)
    assertRankAssignable(access, rank)

    const [result] = await pool.query(
      'INSERT INTO service_members (membership_id, service_id, department_id, rank_id) VALUES (?, ?, ?, ?)',
      [membershipId, service.id, departmentId, rankId],
    )

    res.status(201).json({ member: await findServiceMember(service.id, result.insertId) })
  }),
)

router.patch(
  '/dashboard/services/:serviceId/members/:memberId',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const access = await accessOrThrow(req)
    if (!access.canManageMembers) throw forbidden('Missing permission: members.manage')
    const { service } = access

    const current = await findServiceMember(service.id, req.params.memberId)
    const department =
      req.body?.departmentId !== undefined
        ? await readDepartment(service.id, req.body.departmentId)
        : current.departmentId != null
          ? await readDepartment(service.id, current.departmentId)
          : null
    const departmentId = department?.id ?? null

    if (!access.canManageServiceWideMembers) {
      if (!access.can('members.manage', { departmentId: current.departmentId })) {
        throw forbidden('You can only manage members in your own department')
      }
      if (String(departmentId ?? '') !== String(current.departmentId ?? '')) {
        throw forbidden('You cannot move members between departments')
      }
    }

    // Don't let a restricted manager edit someone more senior than them.
    if (!canAssignFreely(access) && current.rankId) {
      const currentRank = await findRank(service.id, current.rankId)
      const ownPosition = access.membership?.rankPosition
      if (ownPosition != null && currentRank.position > ownPosition) {
        throw forbidden('You cannot manage a member more senior than your own rank')
      }
    }

    const rankId =
      req.body?.rankId !== undefined
        ? req.body.rankId
          ? Number(req.body.rankId)
          : null
        : current.rankId
    const rank = await assertRankForDepartment(service.id, rankId, departmentId)
    assertRankAssignable(access, rank)

    await pool.query(
      'UPDATE service_members SET department_id = ?, rank_id = ? WHERE id = ?',
      [departmentId, rankId, current.id],
    )

    res.json({ member: await findServiceMember(service.id, current.id) })
  }),
)

router.delete(
  '/dashboard/services/:serviceId/members/:memberId',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const access = await accessOrThrow(req)
    if (!access.canManageServiceWideMembers) {
      throw forbidden('Only a service-wide manager can remove a member from the service')
    }
    const member = await findServiceMember(access.service.id, req.params.memberId)
    await pool.query('DELETE FROM service_members WHERE id = ?', [member.id])
    res.json({ ok: true })
  }),
)

export default router
