// Central recruitment: vacancies, internal applications and review.
//
// This is deliberately separate from the community "applications" table,
// which is the public request-to-join flow. Recruitment applications belong
// to a vacancy and can be reviewed by community, service or department staff.
import { Router } from 'express'
import crypto from 'node:crypto'
import { pool, one, query } from '../db.js'
import { requireAuth, communityContext } from '../lib/auth.js'
import {
  asyncHandler,
  badRequest,
  conflict,
  forbidden,
  isValidEmail,
  normaliseSlug,
  notFound,
} from '../lib/util.js'
import {
  canApplyToVacancy,
  canCreateVacancy,
  canManageVacancy,
  canViewVacancy,
  hasGlobal,
  loadRecruitmentAssignments,
} from '../lib/recruitmentAccess.js'

const router = Router()
const ctx = communityContext

const AUDIENCES = ['internal', 'external', 'both']
const VACANCY_STATUSES = ['draft', 'open', 'closed']
const APPLICATION_STATUSES = ['pending', 'shortlisted', 'accepted', 'rejected', 'withdrawn']
const REVIEW_STATUSES = ['shortlisted', 'accepted', 'rejected']

const MAX_TITLE = 120
const MAX_DESCRIPTION = 5000
const MAX_MESSAGE = 4000

// Public application links use a random reference instead of the numeric id,
// so the id is never published and the links cannot be guessed.
const PUBLIC_REF_PATTERN = /^[a-f0-9]{32}$/

function newPublicRef() {
  return crypto.randomBytes(16).toString('hex')
}

function readPublicRef(value) {
  const ref = String(value ?? '').trim().toLowerCase()
  if (!PUBLIC_REF_PATTERN.test(ref)) throw notFound('Vacancy not found')
  return ref
}

function readText(value, label, max, { required = false } = {}) {
  const text = String(value ?? '').trim()
  if (required && !text) throw badRequest(`${label} is required`)
  if (text.length > max) throw badRequest(`${label} is too long (max ${max} characters)`)
  return text || null
}

function readEnum(value, allowed, fallback, label) {
  const text = String(value ?? '').trim()
  if (!text && fallback != null) return fallback
  if (!allowed.includes(text)) throw badRequest(`Choose a valid ${label}`)
  return text
}

function readId(value, field) {
  if (value == null || value === '') return null
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid selection', { field })
  return id
}

function readDate(value, field = 'closesAt') {
  if (value == null || value === '') return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw badRequest('Choose a valid closing date', { field })
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:00`
}

async function readPlacement(communityId, { serviceId, departmentId, rankId }) {
  if (!serviceId) {
    if (departmentId || rankId) {
      throw badRequest('Choose a service before choosing a department or rank')
    }
    return { service: null, department: null, rank: null }
  }

  const service = await one(
    'SELECT id, name, slug, colour FROM services WHERE id = ? AND community_id = ?',
    [serviceId, communityId],
  )
  if (!service) throw badRequest('That service was not found', { field: 'serviceId' })

  let department = null
  if (departmentId) {
    department = await one(
      'SELECT id, name, slug FROM departments WHERE id = ? AND service_id = ?',
      [departmentId, service.id],
    )
    if (!department) {
      throw badRequest('That department does not belong to the chosen service', {
        field: 'departmentId',
      })
    }
  }

  let rank = null
  if (rankId) {
    rank = await one(
      'SELECT id, name, position, all_departments FROM ranks WHERE id = ? AND service_id = ?',
      [rankId, service.id],
    )
    if (!rank) throw badRequest('That rank does not belong to the chosen service', { field: 'rankId' })

    if (!rank.all_departments) {
      if (!department) {
        throw badRequest('That rank only applies to specific departments', { field: 'rankId' })
      }
      const link = await one(
        'SELECT 1 AS ok FROM rank_departments WHERE rank_id = ? AND department_id = ?',
        [rank.id, department.id],
      )
      if (!link) {
        throw badRequest('That rank does not apply to the chosen department', { field: 'rankId' })
      }
    }
  }

  return { service, department, rank }
}

const VACANCY_SELECT = `
  SELECT v.id, v.public_ref, v.community_id, v.service_id, v.department_id, v.rank_id,
         v.title, v.description, v.audience, v.status, v.closes_at,
         v.created_at, v.updated_at,
         s.name AS service_name, s.slug AS service_slug, s.colour AS service_colour,
         s.logo_url AS service_logo,
         d.name AS department_name, d.slug AS department_slug,
         r.name AS rank_name, r.position AS rank_position,
         (SELECT COUNT(*) FROM recruitment_applications a
           WHERE a.vacancy_id = v.id AND a.status <> 'withdrawn') AS applicant_count,
         mine.id AS my_application_id, mine.status AS my_application_status
    FROM recruitment_vacancies v
    LEFT JOIN services s ON s.id = v.service_id
    LEFT JOIN departments d ON d.id = v.department_id
    LEFT JOIN ranks r ON r.id = v.rank_id
    LEFT JOIN recruitment_applications mine
      ON mine.vacancy_id = v.id AND mine.applicant_user_id = ?`

function vacancyView(row) {
  return {
    id: row.id,
    publicRef: row.public_ref ?? null,
    applicationUrl: row.public_ref ? `/application/${row.public_ref}` : null,
    title: row.title,
    description: row.description ?? null,
    audience: row.audience,
    status: row.status,
    closesAt: row.closes_at ?? null,
    createdAt: row.created_at,
    applicantCount: Number(row.applicant_count ?? 0),
    service: row.service_id
      ? {
          id: row.service_id,
          name: row.service_name,
          slug: row.service_slug,
          colour: row.service_colour ?? null,
          logoUrl: row.service_logo ?? null,
        }
      : null,
    department: row.department_id
      ? { id: row.department_id, name: row.department_name, slug: row.department_slug }
      : null,
    rank: row.rank_id
      ? { id: row.rank_id, name: row.rank_name, position: row.rank_position }
      : null,
  }
}

const APPLICATION_SELECT = `
  SELECT a.id, a.vacancy_id, a.community_id, a.applicant_user_id,
         a.applicant_name, a.applicant_email, a.message, a.status,
         a.reviewed_by, a.reviewed_at, a.created_at, a.updated_at,
         v.title AS vacancy_title, v.status AS vacancy_status, v.audience AS vacancy_audience,
         v.service_id, v.department_id, v.rank_id,
         s.name AS service_name, s.slug AS service_slug, s.colour AS service_colour,
         s.logo_url AS service_logo,
         d.name AS department_name, d.slug AS department_slug,
         r.name AS rank_name, r.position AS rank_position
    FROM recruitment_applications a
    JOIN recruitment_vacancies v ON v.id = a.vacancy_id
    LEFT JOIN services s ON s.id = v.service_id
    LEFT JOIN departments d ON d.id = v.department_id
    LEFT JOIN ranks r ON r.id = v.rank_id`

function applicationView(row) {
  return {
    id: row.id,
    status: row.status,
    message: row.message ?? null,
    applicantName: row.applicant_name,
    applicantEmail: row.applicant_email,
    hasAccount: !!row.applicant_user_id,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at ?? null,
    vacancy: {
      id: row.vacancy_id,
      title: row.vacancy_title,
      status: row.vacancy_status,
      audience: row.vacancy_audience,
      service: row.service_id
        ? {
            id: row.service_id,
            name: row.service_name,
            slug: row.service_slug,
            colour: row.service_colour ?? null,
            logoUrl: row.service_logo ?? null,
          }
        : null,
      department: row.department_id
        ? { id: row.department_id, name: row.department_name, slug: row.department_slug }
        : null,
      rank: row.rank_id
        ? { id: row.rank_id, name: row.rank_name, position: row.rank_position }
        : null,
    },
  }
}

async function loadVacancy(id, communityId, userId) {
  return one(`${VACANCY_SELECT} WHERE v.id = ? AND v.community_id = ?`, [
    userId,
    id,
    communityId,
  ])
}

async function loadApplication(id, communityId) {
  return one(`${APPLICATION_SELECT} WHERE a.id = ? AND a.community_id = ?`, [id, communityId])
}

async function publicCommunityBySlug(value) {
  return one('SELECT id, slug FROM communities WHERE slug = ?', [normaliseSlug(value)])
}

function publicVacancyView(row) {
  return {
    ref: row.public_ref,
    applicationUrl: `/application/${row.public_ref}`,
    title: row.title,
    description: row.description ?? null,
    closesAt: row.closes_at ?? null,
    open: row.is_open === undefined ? true : !!Number(row.is_open),
    service: row.service_id
      ? {
          name: row.service_name,
          slug: row.service_slug,
          colour: row.service_colour ?? null,
          logoUrl: row.service_logo ?? null,
        }
      : null,
    department: row.department_id ? { name: row.department_name } : null,
    rank: row.rank_id ? { name: row.rank_name } : null,
  }
}

// The public list and the public application page read the same columns.
const PUBLIC_VACANCY_SELECT = `
  SELECT v.public_ref, v.title, v.description, v.closes_at,
         v.service_id, v.department_id, v.rank_id, v.audience, v.status,
         (v.status = 'open' AND (v.closes_at IS NULL OR v.closes_at >= NOW())) AS is_open,
         s.name AS service_name, s.slug AS service_slug, s.colour AS service_colour,
         s.logo_url AS service_logo,
         d.name AS department_name,
         r.name AS rank_name
    FROM recruitment_vacancies v
    LEFT JOIN services s ON s.id = v.service_id
    LEFT JOIN departments d ON d.id = v.department_id
    LEFT JOIN ranks r ON r.id = v.rank_id`

function canManageAny(req, assignments) {
  return (
    hasGlobal(req, 'applications.manage') ||
    assignments.some((assignment) => assignment.permissions.has('applications.manage'))
  )
}

async function loadOptions(req, assignments) {
  const globalManage = hasGlobal(req, 'applications.manage')
  const manageable = globalManage
    ? []
    : assignments.filter((assignment) => assignment.permissions.has('applications.manage'))
  if (!globalManage && !manageable.length) {
    return { services: [], globalManage, canManageAny: false }
  }

  const serviceRows = await query(
    `SELECT id, name, slug, colour, position
       FROM services
      WHERE community_id = ?
      ORDER BY position ASC, name ASC`,
    [req.community.id],
  )
  const serviceIds = serviceRows.map((service) => Number(service.id))
  if (!serviceIds.length) return { services: [], globalManage, canManageAny: false }

  const placeholders = serviceIds.map(() => '?').join(',')
  const departments = await query(
    `SELECT id, service_id, name, slug, position
       FROM departments
      WHERE service_id IN (${placeholders})
      ORDER BY position ASC, name ASC`,
    serviceIds,
  )
  const ranks = await query(
    `SELECT id, service_id, name, position, all_departments
       FROM ranks
      WHERE service_id IN (${placeholders})
      ORDER BY position DESC, name ASC`,
    serviceIds,
  )
  const links = await query(
    `SELECT rd.rank_id, rd.department_id
       FROM rank_departments rd
       JOIN ranks r ON r.id = rd.rank_id
      WHERE r.service_id IN (${placeholders})`,
    serviceIds,
  )

  const departmentsByService = new Map()
  for (const department of departments) {
    if (!departmentsByService.has(Number(department.service_id))) {
      departmentsByService.set(Number(department.service_id), [])
    }
    departmentsByService.get(Number(department.service_id)).push({
      id: department.id,
      name: department.name,
      slug: department.slug,
    })
  }

  const departmentsByRank = new Map()
  for (const link of links) {
    if (!departmentsByRank.has(Number(link.rank_id))) departmentsByRank.set(Number(link.rank_id), [])
    departmentsByRank.get(Number(link.rank_id)).push(Number(link.department_id))
  }

  const services = serviceRows
    .filter((service) => {
      if (globalManage) return true
      return manageable.some((assignment) => assignment.serviceId === Number(service.id))
    })
    .map((service) => {
      const serviceAssignments = globalManage
        ? []
        : manageable.filter((assignment) => assignment.serviceId === Number(service.id))
      const serviceWide =
        globalManage || serviceAssignments.some((assignment) => assignment.departmentId == null)
      const allowedDepartments = serviceWide
        ? null
        : new Set(serviceAssignments.map((assignment) => assignment.departmentId))

      const availableDepartments = (departmentsByService.get(Number(service.id)) || []).filter(
        (department) => serviceWide || allowedDepartments.has(Number(department.id)),
      )
      const availableRanks = ranks
        .filter((rank) => Number(rank.service_id) === Number(service.id))
        .filter((rank) => {
          if (serviceWide) return true
          if (rank.all_departments) return true
          return (departmentsByRank.get(Number(rank.id)) || []).some((departmentId) =>
            allowedDepartments.has(departmentId),
          )
        })
        .map((rank) => ({
          id: rank.id,
          name: rank.name,
          position: rank.position,
          allDepartments: !!rank.all_departments,
          departmentIds: departmentsByRank.get(Number(rank.id)) || [],
        }))

      return {
        id: service.id,
        name: service.name,
        slug: service.slug,
        colour: service.colour ?? null,
        canServiceWide: serviceWide,
        lockedDepartmentId:
          !serviceWide && allowedDepartments.size === 1 ? [...allowedDepartments][0] : null,
        departments: availableDepartments,
        ranks: availableRanks,
      }
    })

  return {
    services,
    globalManage,
    canManageAny: globalManage || manageable.length > 0,
  }
}

// ---------------------------------------------------------------
// GET /api/dashboard/recruitment/vacancies
// ---------------------------------------------------------------
router.get(
  '/dashboard/recruitment/vacancies',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const assignments = await loadRecruitmentAssignments(req)
    const rows = await query(
      `${VACANCY_SELECT} WHERE v.community_id = ? ORDER BY v.created_at DESC`,
      [req.user.id, req.community.id],
    )

    const vacancies = rows
      .filter((row) => canViewVacancy(req, assignments, row))
      .map((row) => {
        const existing = row.my_application_id
          ? { status: row.my_application_status }
          : null
        return {
          ...vacancyView(row),
          canManage: canManageVacancy(req, assignments, row),
          canApply: canApplyToVacancy(req, assignments, row, existing),
          alreadyApplied: !!existing && existing.status !== 'withdrawn',
          myApplicationStatus: row.my_application_status ?? null,
        }
      })

    res.json({
      vacancies,
      canManageAny: canManageAny(req, assignments),
      globalManage: hasGlobal(req, 'applications.manage'),
    })
  }),
)

// ---------------------------------------------------------------
// GET /api/dashboard/recruitment/options
// ---------------------------------------------------------------
router.get(
  '/dashboard/recruitment/options',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const assignments = await loadRecruitmentAssignments(req)
    res.json(await loadOptions(req, assignments))
  }),
)

// ---------------------------------------------------------------
// Vacancy management
// ---------------------------------------------------------------
router.post(
  '/dashboard/recruitment/vacancies',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const assignments = await loadRecruitmentAssignments(req)
    const serviceId = readId(req.body?.serviceId, 'serviceId')
    const departmentId = readId(req.body?.departmentId, 'departmentId')
    const rankId = readId(req.body?.rankId, 'rankId')
    const placement = await readPlacement(req.community.id, { serviceId, departmentId, rankId })

    if (
      !canCreateVacancy(req, assignments, {
        serviceId: placement.service?.id ?? null,
        departmentId: placement.department?.id ?? null,
      })
    ) {
      throw forbidden('You cannot create a vacancy for that service or department')
    }

    const title = readText(req.body?.title, 'Title', MAX_TITLE, { required: true })
    const description = readText(req.body?.description, 'Description', MAX_DESCRIPTION)
    const audience = readEnum(req.body?.audience, AUDIENCES, 'internal', 'audience')
    const status = readEnum(req.body?.status, VACANCY_STATUSES, 'open', 'status')
    const closesAt = readDate(req.body?.closesAt)

    const [result] = await pool.query(
      `INSERT INTO recruitment_vacancies
         (public_ref, community_id, service_id, department_id, rank_id, title, description,
          audience, status, closes_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newPublicRef(),
        req.community.id,
        placement.service?.id ?? null,
        placement.department?.id ?? null,
        placement.rank?.id ?? null,
        title,
        description,
        audience,
        status,
        closesAt,
        req.user.id,
      ],
    )

    const vacancy = await loadVacancy(result.insertId, req.community.id, req.user.id)
    res.status(201).json({
      vacancy: {
        ...vacancyView(vacancy),
        canManage: true,
        canApply: false,
        alreadyApplied: false,
        myApplicationStatus: null,
      },
    })
  }),
)

router.patch(
  '/dashboard/recruitment/vacancies/:id',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const assignments = await loadRecruitmentAssignments(req)
    const existing = await one(
      'SELECT * FROM recruitment_vacancies WHERE id = ? AND community_id = ?',
      [req.params.id, req.community.id],
    )
    if (!existing) throw notFound('Vacancy not found')
    if (!canManageVacancy(req, assignments, existing)) {
      throw forbidden('You cannot manage that vacancy')
    }

    const serviceId =
      req.body?.serviceId !== undefined ? readId(req.body.serviceId, 'serviceId') : existing.service_id
    const departmentId =
      req.body?.departmentId !== undefined
        ? readId(req.body.departmentId, 'departmentId')
        : existing.department_id
    const rankId =
      req.body?.rankId !== undefined ? readId(req.body.rankId, 'rankId') : existing.rank_id
    const placement = await readPlacement(req.community.id, {
      serviceId,
      departmentId,
      rankId,
    })

    if (
      !canCreateVacancy(req, assignments, {
        serviceId: placement.service?.id ?? null,
        departmentId: placement.department?.id ?? null,
      })
    ) {
      throw forbidden('You cannot move this vacancy to that service or department')
    }

    const title =
      req.body?.title !== undefined
        ? readText(req.body.title, 'Title', MAX_TITLE, { required: true })
        : existing.title
    const description =
      req.body?.description !== undefined
        ? readText(req.body.description, 'Description', MAX_DESCRIPTION)
        : existing.description
    const audience =
      req.body?.audience !== undefined
        ? readEnum(req.body.audience, AUDIENCES, 'internal', 'audience')
        : existing.audience
    const status =
      req.body?.status !== undefined
        ? readEnum(req.body.status, VACANCY_STATUSES, 'open', 'status')
        : existing.status
    const closesAt =
      req.body?.closesAt !== undefined
        ? readDate(req.body.closesAt)
        : existing.closes_at

    await pool.query(
      `UPDATE recruitment_vacancies
          SET service_id = ?, department_id = ?, rank_id = ?, title = ?, description = ?,
              audience = ?, status = ?, closes_at = ?
        WHERE id = ?`,
      [
        placement.service?.id ?? null,
        placement.department?.id ?? null,
        placement.rank?.id ?? null,
        title,
        description,
        audience,
        status,
        closesAt,
        existing.id,
      ],
    )

    const vacancy = await loadVacancy(existing.id, req.community.id, req.user.id)
    const myApplication = vacancy.my_application_id
      ? { status: vacancy.my_application_status }
      : null
    res.json({
      vacancy: {
        ...vacancyView(vacancy),
        canManage: true,
        canApply: canApplyToVacancy(req, assignments, vacancy, myApplication),
        alreadyApplied: !!myApplication && myApplication.status !== 'withdrawn',
        myApplicationStatus: vacancy.my_application_status ?? null,
      },
    })
  }),
)

router.delete(
  '/dashboard/recruitment/vacancies/:id',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const assignments = await loadRecruitmentAssignments(req)
    const vacancy = await one(
      'SELECT * FROM recruitment_vacancies WHERE id = ? AND community_id = ?',
      [req.params.id, req.community.id],
    )
    if (!vacancy) throw notFound('Vacancy not found')
    if (!canManageVacancy(req, assignments, vacancy)) {
      throw forbidden('You cannot delete that vacancy')
    }

    await pool.query('DELETE FROM recruitment_vacancies WHERE id = ?', [vacancy.id])
    res.json({ ok: true })
  }),
)

// ---------------------------------------------------------------
// Internal applications
// ---------------------------------------------------------------
router.post(
  '/dashboard/recruitment/vacancies/:id/apply',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const assignments = await loadRecruitmentAssignments(req)
    const vacancy = await one(
      'SELECT * FROM recruitment_vacancies WHERE id = ? AND community_id = ?',
      [req.params.id, req.community.id],
    )
    if (!vacancy) throw notFound('Vacancy not found')
    if (!canViewVacancy(req, assignments, vacancy)) throw notFound('Vacancy not found')

    const existing = await one(
      'SELECT id, status FROM recruitment_applications WHERE vacancy_id = ? AND applicant_user_id = ?',
      [vacancy.id, req.user.id],
    )
    if (!canApplyToVacancy(req, assignments, vacancy, existing)) {
      throw badRequest('You cannot apply to this vacancy')
    }

    const message = readText(req.body?.message, 'Message', MAX_MESSAGE)
    const name =
      req.membership.display_name || req.user.username || req.user.email || 'Applicant'

    let applicationId
    if (existing) {
      applicationId = existing.id
      await pool.query(
        `UPDATE recruitment_applications
            SET applicant_name = ?, applicant_email = ?, message = ?, status = 'pending',
                reviewed_by = NULL, reviewed_at = NULL
          WHERE id = ?`,
        [name, req.user.email, message, applicationId],
      )
    } else {
      const [result] = await pool.query(
        `INSERT INTO recruitment_applications
           (vacancy_id, community_id, applicant_user_id, applicant_name, applicant_email, message)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [vacancy.id, req.community.id, req.user.id, name, req.user.email, message],
      )
      applicationId = result.insertId
    }

    const application = await loadApplication(applicationId, req.community.id)
    res.status(201).json({ application: applicationView(application) })
  }),
)

router.get(
  '/dashboard/recruitment/applications',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const rows = await query(
      `${APPLICATION_SELECT}
        WHERE a.community_id = ? AND a.applicant_user_id = ?
        ORDER BY a.created_at DESC`,
      [req.community.id, req.user.id],
    )
    res.json({ applications: rows.map(applicationView) })
  }),
)

router.post(
  '/dashboard/recruitment/applications/:id/withdraw',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const application = await one(
      `SELECT id, status FROM recruitment_applications
        WHERE id = ? AND community_id = ? AND applicant_user_id = ?`,
      [req.params.id, req.community.id, req.user.id],
    )
    if (!application) throw notFound('Application not found')
    if (!['pending', 'shortlisted'].includes(application.status)) {
      throw badRequest('This application can no longer be withdrawn')
    }

    await pool.query("UPDATE recruitment_applications SET status = 'withdrawn' WHERE id = ?", [
      application.id,
    ])
    res.json({ ok: true })
  }),
)

// ---------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------
router.get(
  '/dashboard/recruitment/manage',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const assignments = await loadRecruitmentAssignments(req)
    if (!canManageAny(req, assignments)) {
      throw forbidden('Missing permission: applications.manage')
    }

    const status = APPLICATION_STATUSES.includes(req.query.status) ? req.query.status : null
    const rows = await query(
      `${APPLICATION_SELECT}
        WHERE a.community_id = ?${status ? ' AND a.status = ?' : ''}
        ORDER BY a.created_at DESC`,
      status ? [req.community.id, status] : [req.community.id],
    )

    const applications = rows
      .filter((row) => canManageVacancy(req, assignments, row))
      .map(applicationView)

    res.json({ applications })
  }),
)

router.patch(
  '/dashboard/recruitment/applications/:id',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    const assignments = await loadRecruitmentAssignments(req)
    const application = await one(
      `${APPLICATION_SELECT} WHERE a.id = ? AND a.community_id = ?`,
      [req.params.id, req.community.id],
    )
    if (!application) throw notFound('Application not found')
    if (!canManageVacancy(req, assignments, application)) {
      throw forbidden('You cannot review that application')
    }

    const status = readEnum(req.body?.status, REVIEW_STATUSES, null, 'application status')
    if (application.status === 'withdrawn') {
      throw badRequest('This application was withdrawn')
    }
    if (application.status === 'accepted' && status !== 'accepted') {
      throw badRequest('This application has already been accepted')
    }

    // Reviewing an application does not change the service roster. Membership
    // changes stay behind members.manage on the service Members page, so an
    // applications.manage holder cannot assign ranks indirectly.
    await pool.query(
      `UPDATE recruitment_applications
          SET status = ?, reviewed_by = ?, reviewed_at = NOW()
        WHERE id = ?`,
      [status, req.user.id, application.id],
    )

    const updated = await loadApplication(application.id, req.community.id)
    res.json({ application: applicationView(updated) })
  }),
)

// ---------------------------------------------------------------
// Public recruitment (community website)
// ---------------------------------------------------------------
router.get(
  '/communities/:slug/vacancies',
  asyncHandler(async (req, res) => {
    const community = await publicCommunityBySlug(req.params.slug)
    if (!community) throw notFound('Community not found')

    const rows = await query(
      `${PUBLIC_VACANCY_SELECT}
        WHERE v.community_id = ?
          AND v.status = 'open'
          AND v.audience IN ('external', 'both')
          AND (v.closes_at IS NULL OR v.closes_at >= NOW())
        ORDER BY v.created_at DESC`,
      [community.id],
    )

    res.json({ vacancies: rows.map(publicVacancyView) })
  }),
)

// ---------------------------------------------------------------
// GET /api/communities/:slug/application/:ref
//
// The public application page. The reference is the only thing in
// the address, so the numeric id is never published.
// ---------------------------------------------------------------
router.get(
  '/communities/:slug/application/:ref',
  asyncHandler(async (req, res) => {
    const community = await publicCommunityBySlug(req.params.slug)
    if (!community) throw notFound('Community not found')
    const ref = readPublicRef(req.params.ref)

    const row = await one(`${PUBLIC_VACANCY_SELECT} WHERE v.public_ref = ? AND v.community_id = ?`, [
      ref,
      community.id,
    ])
    if (!row) throw notFound('Vacancy not found')
    // Internal-only and draft vacancies are never published.
    if (row.audience === 'internal' || row.status === 'draft') {
      throw notFound('Vacancy not found')
    }

    res.json({ vacancy: publicVacancyView(row) })
  }),
)

// ---------------------------------------------------------------
// POST /api/communities/:slug/application/:ref/apply
// ---------------------------------------------------------------
router.post(
  '/communities/:slug/application/:ref/apply',
  asyncHandler(async (req, res) => {
    const community = await publicCommunityBySlug(req.params.slug)
    if (!community) throw notFound('Community not found')
    const ref = readPublicRef(req.params.ref)

    const vacancy = await one(
      `SELECT v.id
         FROM recruitment_vacancies v
        WHERE v.public_ref = ?
          AND v.community_id = ?
          AND v.status = 'open'
          AND v.audience IN ('external', 'both')
          AND (v.closes_at IS NULL OR v.closes_at >= NOW())`,
      [ref, community.id],
    )
    if (!vacancy) throw notFound('Vacancy not found or no longer open')

    const name = String(req.body?.name ?? '').trim()
    const email = String(req.body?.email ?? '').trim().toLowerCase()
    const message = readText(req.body?.message, 'Message', MAX_MESSAGE)

    if (!name) throw badRequest('Your name is required', { field: 'name' })
    if (name.length > 100) throw badRequest('Name is too long', { field: 'name' })
    if (!isValidEmail(email)) throw badRequest('Enter a valid email address', { field: 'email' })

    const duplicate = await one(
      `SELECT id FROM recruitment_applications
        WHERE vacancy_id = ? AND applicant_email = ? AND status <> 'withdrawn'`,
      [vacancy.id, email],
    )
    if (duplicate) throw conflict('You already have an application for this vacancy')

    await pool.query(
      `INSERT INTO recruitment_applications
         (vacancy_id, community_id, applicant_user_id, applicant_name, applicant_email, message)
       VALUES (?, ?, NULL, ?, ?, ?)`,
      [vacancy.id, community.id, name, email, message],
    )

    res.status(201).json({ ok: true })
  }),
)

export default router
