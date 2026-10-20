import { Router } from 'express'
import { pool, one, query } from '../db.js'
import { requireAuth, communityContext, requirePermission } from '../lib/auth.js'
import { asyncHandler, badRequest, conflict, notFound } from '../lib/util.js'

// Community services (Police, Ambulance, Fire, ...). Departments, ranks and
// applications will hang off these later.
const router = Router()
const ctx = communityContext

const MAX_NAME = 80
const MAX_DESCRIPTION = 500
const isHexColour = (v) => /^#[0-9a-fA-F]{6}$/.test(v)

const SELECT_COLUMNS =
  'id, name, slug, description, colour, position, created_at, updated_at'

function serviceView(service) {
  return {
    id: service.id,
    name: service.name,
    slug: service.slug,
    description: service.description ?? null,
    colour: service.colour ?? null,
    position: service.position,
    createdAt: service.created_at,
    updatedAt: service.updated_at,
  }
}

// "Roads Policing" -> "roads-policing". The slug is generated once and then
// stays put, so renaming a service doesn't break anything that links to it.
function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

async function uniqueSlug(communityId, base) {
  const root = slugify(base) || 'service'
  let slug = root
  let n = 2
  while (
    await one('SELECT id FROM services WHERE community_id = ? AND slug = ?', [communityId, slug])
  ) {
    const suffix = `-${n++}`
    slug = `${root.slice(0, 63 - suffix.length)}${suffix}`
  }
  return slug
}

function readName(value) {
  const name = String(value ?? '').trim()
  if (!name || name.length > MAX_NAME) {
    throw badRequest(`Service name is required (max ${MAX_NAME} characters)`, { field: 'name' })
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

function readColour(value) {
  if (value == null || value === '') return null
  const colour = String(value).trim()
  if (!isHexColour(colour)) {
    throw badRequest('Colour must be a hex value like #014b7f', { field: 'colour' })
  }
  return colour
}

async function findService(communityId, id) {
  const service = await one('SELECT * FROM services WHERE id = ? AND community_id = ?', [
    id,
    communityId,
  ])
  if (!service) throw notFound('Service not found')
  return service
}

// ---------------------------------------------------------------
// GET /api/dashboard/services
// ---------------------------------------------------------------
router.get(
  '/dashboard/services',
  requireAuth,
  ctx,
  requirePermission('services.view'),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT ${SELECT_COLUMNS}
         FROM services
        WHERE community_id = ?
        ORDER BY position ASC, name ASC`,
      [req.community.id],
    )
    res.json({ services: rows.map(serviceView) })
  }),
)

// ---------------------------------------------------------------
// POST /api/dashboard/services
// ---------------------------------------------------------------
router.post(
  '/dashboard/services',
  requireAuth,
  ctx,
  requirePermission('services.manage'),
  asyncHandler(async (req, res) => {
    const name = readName(req.body?.name)
    const description = readDescription(req.body?.description)
    const colour = readColour(req.body?.colour)

    const existing = await one('SELECT id FROM services WHERE community_id = ? AND name = ?', [
      req.community.id,
      name,
    ])
    if (existing) throw conflict('A service with that name already exists', { field: 'name' })

    const slug = await uniqueSlug(req.community.id, name)
    const next = await one(
      'SELECT COALESCE(MAX(position), 0) + 10 AS position FROM services WHERE community_id = ?',
      [req.community.id],
    )

    const [result] = await pool.query(
      `INSERT INTO services (community_id, name, slug, description, colour, position)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.community.id, name, slug, description, colour, next.position],
    )
    const service = await one(`SELECT ${SELECT_COLUMNS} FROM services WHERE id = ?`, [
      result.insertId,
    ])
    res.status(201).json({ service: serviceView(service) })
  }),
)

// ---------------------------------------------------------------
// PATCH /api/dashboard/services/:id
// ---------------------------------------------------------------
router.patch(
  '/dashboard/services/:id',
  requireAuth,
  ctx,
  requirePermission('services.manage'),
  asyncHandler(async (req, res) => {
    const service = await findService(req.community.id, req.params.id)

    const name = req.body?.name != null ? readName(req.body.name) : service.name
    if (name !== service.name) {
      const existing = await one(
        'SELECT id FROM services WHERE community_id = ? AND name = ? AND id <> ?',
        [req.community.id, name, service.id],
      )
      if (existing) throw conflict('A service with that name already exists', { field: 'name' })
    }

    const description =
      req.body?.description !== undefined ? readDescription(req.body.description) : service.description
    const colour = req.body?.colour !== undefined ? readColour(req.body.colour) : service.colour

    await pool.query('UPDATE services SET name = ?, description = ?, colour = ? WHERE id = ?', [
      name,
      description,
      colour,
      service.id,
    ])

    const updated = await one(`SELECT ${SELECT_COLUMNS} FROM services WHERE id = ?`, [service.id])
    res.json({ service: serviceView(updated) })
  }),
)

// ---------------------------------------------------------------
// DELETE /api/dashboard/services/:id
// ---------------------------------------------------------------
router.delete(
  '/dashboard/services/:id',
  requireAuth,
  ctx,
  requirePermission('services.manage'),
  asyncHandler(async (req, res) => {
    const service = await findService(req.community.id, req.params.id)
    await pool.query('DELETE FROM services WHERE id = ?', [service.id])
    res.json({ ok: true })
  }),
)

export default router
