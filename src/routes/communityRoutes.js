import { Router } from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pool, one, query, withTransaction } from '../db.js'
import { requireAuth, setCommunity, clearCommunity, signCommunity } from '../lib/auth.js'
import {
  asyncHandler,
  badRequest,
  conflict,
  notFound,
  normaliseSlug,
  isValidSlug,
  isValidEmail,
  publicCommunity,
} from '../lib/util.js'
import { PRESET_ROLES } from '../lib/permissions.js'
import { UPLOAD_DIR } from '../lib/config.js'

const router = Router()

const LOGO_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const isHexColour = (v) => /^#[0-9a-fA-F]{6}$/.test(v)

// ---------------------------------------------------------------
// GET /api/communities/check?name=&slug=
// Live availability feedback for the create-community wizard.
// ---------------------------------------------------------------
router.get(
  '/communities/check',
  asyncHandler(async (req, res) => {
    const name = String(req.query.name || '').trim()
    const slug = normaliseSlug(req.query.slug)
    // The edit-community page passes its own slug so it is not blocked by itself.
    const excludeSlug = normaliseSlug(req.query.excludeSlug)
    const out = { name: null, slug: null }

    if (name) {
      const row = await one('SELECT id, slug FROM communities WHERE name = ?', [name])
      const own = !!row && !!excludeSlug && normaliseSlug(row.slug) === excludeSlug
      out.name = { value: name, available: !row || own }
    }

    if (slug) {
      const valid = isValidSlug(slug)
      const reserved = valid ? await one('SELECT reason FROM reserved_slugs WHERE slug = ?', [slug]) : null
      const taken = valid ? await one('SELECT id FROM communities WHERE slug = ?', [slug]) : null
      const takenByOther = !!taken && slug !== excludeSlug
      out.slug = {
        value: slug,
        valid,
        available: valid && !reserved && !takenByOther,
        reserved: !!reserved,
        reason: reserved?.reason || null,
        taken: takenByOther,
      }
    }

    res.json(out)
  }),
)

// ---------------------------------------------------------------
// POST /api/communities   { name, slug, logoUrl?, accentColor? }
// Creator becomes Owner (active member). Auto-selects the community.
// ---------------------------------------------------------------
router.post(
  '/communities',
  requireAuth,
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').trim()
    const slug = normaliseSlug(req.body?.slug)
    const logoUrl = req.body?.logoUrl ? String(req.body.logoUrl) : null
    const accentColor = req.body?.accentColor ? String(req.body.accentColor) : null

    if (name.length < 3 || name.length > 100) {
      throw badRequest('Community name must be 3–100 characters', { field: 'name' })
    }
    if (!isValidSlug(slug)) {
      throw badRequest('Choose a URL of 3–63 characters (letters, numbers and hyphens)', { field: 'slug' })
    }
    if (accentColor && !isHexColour(accentColor)) {
      throw badRequest('Accent colour must be a hex value like #0b1f42', { field: 'accentColor' })
    }

    const reserved = await one('SELECT reason FROM reserved_slugs WHERE slug = ?', [slug])
    if (reserved) throw conflict('That URL is reserved', { field: 'slug', reason: reserved.reason })

    const takenSlug = await one('SELECT id FROM communities WHERE slug = ?', [slug])
    if (takenSlug) throw conflict('That URL is already taken', { field: 'slug' })

    const takenName = await one('SELECT id FROM communities WHERE name = ?', [name])
    if (takenName) throw conflict('That community name is already taken', { field: 'name' })

    let communityId
    try {
      communityId = await withTransaction(async (conn) => {
        const [ins] = await conn.query(
          'INSERT INTO communities (slug, name, logo_url, accent_color, created_by) VALUES (?, ?, ?, ?, ?)',
          [slug, name, logoUrl, accentColor, req.user.id],
        )
        const id = ins.insertId

        let ownerRoleId = null
        for (const preset of PRESET_ROLES) {
          const [role] = await conn.query(
            'INSERT INTO roles (community_id, `key`, name, position, is_owner, is_default, permissions) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
              id,
              preset.key,
              preset.name,
              preset.position,
              preset.is_owner,
              preset.is_default,
              JSON.stringify(preset.permissions),
            ],
          )
          if (preset.is_owner) ownerRoleId = role.insertId
        }

        await conn.query(
          `INSERT INTO memberships (user_id, community_id, role_id, display_name, status, joined_at, accepted_at)
           VALUES (?, ?, ?, ?, 'active', NOW(), NOW())`,
          [req.user.id, id, ownerRoleId, req.user.username || req.user.email],
        )

        return id
      })
    } catch (err) {
      if (err?.code === 'ER_DUP_ENTRY') throw conflict('That name or URL is already taken')
      throw err
    }

    const community = await one('SELECT * FROM communities WHERE id = ?', [communityId])
    setCommunity(res, signCommunity(community.id))
    res.status(201).json({ community: publicCommunity(community) })
  }),
)

// ---------------------------------------------------------------
// GET /api/communities/:slug   (public — feeds the community site)
// ---------------------------------------------------------------
router.get(
  '/communities/:slug',
  asyncHandler(async (req, res) => {
    const community = await one(
      'SELECT id, slug, name, tagline, description, logo_url, accent_color, theme FROM communities WHERE slug = ?',
      [normaliseSlug(req.params.slug)],
    )
    if (!community) throw notFound('Community not found')
    res.json({ community: publicCommunity(community) })
  }),
)

// ---------------------------------------------------------------
// POST /api/communities/:slug/apply
// ---------------------------------------------------------------
router.post(
  '/communities/:slug/apply',
  asyncHandler(async (req, res) => {
    const community = await one('SELECT id FROM communities WHERE slug = ?', [normaliseSlug(req.params.slug)])
    if (!community) throw notFound('Community not found')

    const name = String(req.body?.name || '').trim()
    const email = String(req.body?.email || '').trim().toLowerCase()
    const answers = req.body?.answers ?? null

    if (!name) throw badRequest('Your name is required', { field: 'name' })
    if (name.length > 100) throw badRequest('Name is too long', { field: 'name' })
    if (!isValidEmail(email)) throw badRequest('Enter a valid email address', { field: 'email' })

    const duplicate = await one(
      "SELECT id FROM applications WHERE community_id = ? AND applicant_email = ? AND status = 'pending'",
      [community.id, email],
    )
    if (duplicate) throw conflict('You already have a pending application for this community')

    await pool.query(
      'INSERT INTO applications (community_id, applicant_name, applicant_email, answers) VALUES (?, ?, ?, ?)',
      [community.id, name, email, answers ? JSON.stringify(answers) : null],
    )
    res.status(201).json({ ok: true })
  }),
)

// ---------------------------------------------------------------
// POST /api/uploads/logo   { dataUrl }  -> { url }
// (no multipart dependency; the client sends a data: URL)
// ---------------------------------------------------------------
router.post(
  '/uploads/logo',
  requireAuth,
  asyncHandler(async (req, res) => {
    const dataUrl = String(req.body?.dataUrl || '')
    const match = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl)
    if (!match) throw badRequest('Provide an image as a data URL')

    const ext = LOGO_TYPES[match[1].toLowerCase()]
    if (!ext) throw badRequest('Only PNG, JPEG, WebP or GIF images are allowed')

    const buffer = Buffer.from(match[2], 'base64')
    if (buffer.length === 0) throw badRequest('The image is empty')
    if (buffer.length > 2 * 1024 * 1024) throw badRequest('Image must be 2 MB or smaller')

    const dir = path.join(UPLOAD_DIR, 'logos')
    await fs.mkdir(dir, { recursive: true })
    const filename = `${crypto.randomUUID()}.${ext}`
    await fs.writeFile(path.join(dir, filename), buffer)

    res.status(201).json({ url: `/uploads/logos/${filename}` })
  }),
)

// ---------------------------------------------------------------
// POST /api/community/select   { communityId }  -> sets the cookie
// POST /api/community/deselect
// ---------------------------------------------------------------
router.post(
  '/community/select',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = Number(req.body?.communityId)
    if (!communityId) throw badRequest('communityId is required')

    const membership = await one(
      "SELECT id FROM memberships WHERE user_id = ? AND community_id = ? AND status = 'active'",
      [req.user.id, communityId],
    )
    if (!membership) throw conflict('You are not an active member of that community')

    const community = await one('SELECT id, slug, name FROM communities WHERE id = ?', [communityId])
    if (!community) throw notFound('Community not found')

    setCommunity(res, signCommunity(community.id))
    res.json({ community: { id: community.id, slug: community.slug, name: community.name } })
  }),
)

router.post('/community/deselect', (req, res) => {
  clearCommunity(res)
  res.json({ ok: true })
})

export default router
