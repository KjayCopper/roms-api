import { Router } from 'express'
import { pool, one, query, withTransaction } from '../db.js'
import {
  requireAuth,
  communityContext,
  requirePermission,
  randomToken,
  sha256,
} from '../lib/auth.js'
import {
  asyncHandler,
  badRequest,
  notFound,
  conflict,
  forbidden,
  normaliseSlug,
  publicCommunity,
} from '../lib/util.js'
import { PERMISSIONS, effectivePermissions, sanitisePermissions } from '../lib/permissions.js'
import { sendMail, inviteEmail } from '../lib/mail.js'
import { INVITE_TTL_MS } from '../lib/config.js'

const router = Router()

// Every /dashboard route needs a session + a selected community.
const ctx = communityContext

const isHexColour = (v) => /^#[0-9a-fA-F]{6}$/.test(v)

function roleView(role) {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    position: role.position,
    isOwner: !!role.is_owner,
    isDefault: !!role.is_default,
    permissions: effectivePermissions(role),
  }
}

// ---------------------------------------------------------------
// GET /api/dashboard  -> context for the selected community
// ---------------------------------------------------------------
router.get(
  '/dashboard',
  requireAuth,
  ctx,
  asyncHandler(async (req, res) => {
    res.json({
      community: publicCommunity(req.community),
      role: req.role,
      permissions: req.permissions,
    })
  }),
)

// ---------------------------------------------------------------
// Applications
// ---------------------------------------------------------------
router.get(
  '/dashboard/applications',
  requireAuth,
  ctx,
  requirePermission('applications.view'),
  asyncHandler(async (req, res) => {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status)
      ? req.query.status
      : 'pending'
    const rows = await query(
      `SELECT id, applicant_name, applicant_email, answers, status, reviewed_at, created_at
         FROM applications
        WHERE community_id = ? AND status = ?
        ORDER BY created_at DESC`,
      [req.community.id, status],
    )
    res.json({
      applications: rows.map((a) => ({
        id: a.id,
        name: a.applicant_name,
        email: a.applicant_email,
        answers: a.answers ?? null,
        status: a.status,
        reviewedAt: a.reviewed_at,
        createdAt: a.created_at,
      })),
    })
  }),
)

router.post(
  '/dashboard/applications/:id/approve',
  requireAuth,
  ctx,
  requirePermission('applications.manage'),
  asyncHandler(async (req, res) => {
    const application = await one('SELECT * FROM applications WHERE id = ? AND community_id = ?', [
      req.params.id,
      req.community.id,
    ])
    if (!application) throw notFound('Application not found')
    if (application.status !== 'pending') throw badRequest('This application has already been reviewed')

    const email = application.applicant_email.toLowerCase()

    const outcome = await withTransaction(async (conn) => {
      // Find or create the user for this email (shadow account if new).
      const [users] = await conn.query('SELECT id FROM users WHERE email = ?', [email])
      let userId = users[0]?.id
      if (!userId) {
        const [ins] = await conn.query('INSERT INTO users (email) VALUES (?)', [email])
        userId = ins.insertId
      }

      const [memberships] = await conn.query(
        'SELECT id, status FROM memberships WHERE user_id = ? AND community_id = ?',
        [userId, req.community.id],
      )
      const existing = memberships[0]

      if (existing && existing.status === 'active') {
        await conn.query("UPDATE applications SET status = 'approved', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?", [
          req.user.id,
          application.id,
        ])
        return { alreadyMember: true }
      }

      const [defaults] = await conn.query(
        'SELECT id FROM roles WHERE community_id = ? AND is_default = 1 LIMIT 1',
        [req.community.id],
      )
      const defaultRoleId = defaults[0]?.id || null

      const token = randomToken(32)
      const expires = new Date(Date.now() + INVITE_TTL_MS)

      if (existing) {
        await conn.query(
          `UPDATE memberships
              SET status = 'invited', role_id = ?, invite_token_hash = ?, invite_expires_at = ?,
                  invited_at = NOW(), assigned_by = ?
            WHERE id = ?`,
          [defaultRoleId, sha256(token), expires, req.user.id, existing.id],
        )
      } else {
        await conn.query(
          `INSERT INTO memberships
             (user_id, community_id, role_id, status, invite_token_hash, invite_expires_at, invited_at, assigned_by)
           VALUES (?, ?, ?, 'invited', ?, ?, NOW(), ?)`,
          [userId, req.community.id, defaultRoleId, sha256(token), expires, req.user.id],
        )
      }

      await conn.query("UPDATE applications SET status = 'approved', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?", [
        req.user.id,
        application.id,
      ])
      return { token, email, alreadyMember: false }
    })

    let emailed = false
    if (outcome.token) {
      try {
        emailed = await sendMail({
          to: outcome.email,
          ...inviteEmail({ communityName: req.community.name, token: outcome.token, email: outcome.email }),
        })
      } catch (err) {
        console.error('invite email failed:', err.message)
      }
    }

    res.json({
      ok: true,
      alreadyMember: !!outcome.alreadyMember,
      invited: !!outcome.token,
      emailed,
    })
  }),
)

router.post(
  '/dashboard/applications/:id/reject',
  requireAuth,
  ctx,
  requirePermission('applications.manage'),
  asyncHandler(async (req, res) => {
    const application = await one('SELECT id, status FROM applications WHERE id = ? AND community_id = ?', [
      req.params.id,
      req.community.id,
    ])
    if (!application) throw notFound('Application not found')
    if (application.status !== 'pending') throw badRequest('This application has already been reviewed')
    await pool.query("UPDATE applications SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?", [
      req.user.id,
      application.id,
    ])
    res.json({ ok: true })
  }),
)

// ---------------------------------------------------------------
// Members
// ---------------------------------------------------------------
router.get(
  '/dashboard/members',
  requireAuth,
  ctx,
  requirePermission('members.view'),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT m.user_id, m.display_name, m.status, m.joined_at,
              u.username, u.email,
              r.id AS role_id, r.key AS role_key, r.name AS role_name, r.position, r.is_owner
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN roles r ON r.id = m.role_id
        WHERE m.community_id = ?
        ORDER BY r.position DESC, m.display_name ASC`,
      [req.community.id],
    )
    res.json({
      members: rows.map((m) => ({
        userId: m.user_id,
        username: m.username,
        email: m.email,
        displayName: m.display_name,
        status: m.status,
        joinedAt: m.joined_at,
        role: m.role_id
          ? { id: m.role_id, key: m.role_key, name: m.role_name, position: m.position, isOwner: !!m.is_owner }
          : null,
      })),
    })
  }),
)

router.patch(
  '/dashboard/members/:userId',
  requireAuth,
  ctx,
  requirePermission('members.manage'),
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.userId)
    const roleId = req.body?.roleId != null ? Number(req.body.roleId) : null
    if (!roleId) throw badRequest('roleId is required')

    const membership = await one(
      `SELECT m.id, r.is_owner FROM memberships m
        LEFT JOIN roles r ON r.id = m.role_id
       WHERE m.user_id = ? AND m.community_id = ?`,
      [userId, req.community.id],
    )
    if (!membership) throw notFound('Member not found')

    const role = await one('SELECT id, is_owner FROM roles WHERE id = ? AND community_id = ?', [
      roleId,
      req.community.id,
    ])
    if (!role) throw badRequest('Unknown role')

    if (membership.is_owner && !req.role?.isOwner) throw forbidden("Only the owner can change the owner's role")
    if (role.is_owner && !req.role?.isOwner) throw forbidden('Only the owner can assign the owner role')

    await pool.query('UPDATE memberships SET role_id = ?, assigned_by = ? WHERE id = ?', [
      role.id,
      req.user.id,
      membership.id,
    ])
    res.json({ ok: true })
  }),
)

router.delete(
  '/dashboard/members/:userId',
  requireAuth,
  ctx,
  requirePermission('members.manage'),
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.userId)
    if (userId === req.user.id) throw badRequest('You cannot remove yourself')

    const membership = await one(
      `SELECT m.id, r.is_owner FROM memberships m
        LEFT JOIN roles r ON r.id = m.role_id
       WHERE m.user_id = ? AND m.community_id = ?`,
      [userId, req.community.id],
    )
    if (!membership) throw notFound('Member not found')
    if (membership.is_owner) throw forbidden('The owner cannot be removed')

    await pool.query('DELETE FROM memberships WHERE id = ?', [membership.id])
    res.json({ ok: true })
  }),
)

// ---------------------------------------------------------------
// Roles (custom per community)
// ---------------------------------------------------------------
router.get(
  '/dashboard/roles',
  requireAuth,
  ctx,
  requirePermission('members.view'),
  asyncHandler(async (req, res) => {
    const rows = await query(
      'SELECT id, `key`, name, position, is_owner, is_default, permissions FROM roles WHERE community_id = ? ORDER BY position DESC, name',
      [req.community.id],
    )
    res.json({ roles: rows.map(roleView), permissions: PERMISSIONS })
  }),
)

router.post(
  '/dashboard/roles',
  requireAuth,
  ctx,
  requirePermission('community.roles'),
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').trim()
    const position = Number.isFinite(Number(req.body?.position)) ? Number(req.body.position) : 0
    const permissions = sanitisePermissions(req.body?.permissions)
    if (!name || name.length > 64) throw badRequest('Role name is required (max 64 characters)', { field: 'name' })

    const baseKey = normaliseSlug(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'role'
    let key = baseKey
    let n = 2
    while (await one('SELECT id FROM roles WHERE community_id = ? AND `key` = ?', [req.community.id, key])) {
      key = `${baseKey}-${n++}`
    }

    const [result] = await pool.query(
      'INSERT INTO roles (community_id, `key`, name, position, is_owner, is_default, permissions) VALUES (?, ?, ?, ?, 0, 0, ?)',
      [req.community.id, key, name, position, JSON.stringify(permissions)],
    )
    const role = await one(
      'SELECT id, `key`, name, position, is_owner, is_default, permissions FROM roles WHERE id = ?',
      [result.insertId],
    )
    res.status(201).json({ role: roleView(role) })
  }),
)

router.patch(
  '/dashboard/roles/:id',
  requireAuth,
  ctx,
  requirePermission('community.roles'),
  asyncHandler(async (req, res) => {
    const role = await one('SELECT * FROM roles WHERE id = ? AND community_id = ?', [req.params.id, req.community.id])
    if (!role) throw notFound('Role not found')
    if (role.is_owner) throw forbidden('The owner role cannot be edited')

    const name = req.body?.name != null ? String(req.body.name).trim() : role.name
    const position = req.body?.position != null ? Number(req.body.position) : role.position
    if (!name || name.length > 64) throw badRequest('Role name is required (max 64 characters)', { field: 'name' })

    if (req.body?.permissions != null) {
      await pool.query('UPDATE roles SET name = ?, position = ?, permissions = ? WHERE id = ?', [
        name,
        position,
        JSON.stringify(sanitisePermissions(req.body.permissions)),
        role.id,
      ])
    } else {
      await pool.query('UPDATE roles SET name = ?, position = ? WHERE id = ?', [name, position, role.id])
    }

    const updated = await one(
      'SELECT id, `key`, name, position, is_owner, is_default, permissions FROM roles WHERE id = ?',
      [role.id],
    )
    res.json({ role: roleView(updated) })
  }),
)

router.delete(
  '/dashboard/roles/:id',
  requireAuth,
  ctx,
  requirePermission('community.roles'),
  asyncHandler(async (req, res) => {
    const role = await one('SELECT * FROM roles WHERE id = ? AND community_id = ?', [req.params.id, req.community.id])
    if (!role) throw notFound('Role not found')
    if (role.is_owner) throw forbidden('The owner role cannot be deleted')

    const fallback = await one('SELECT id FROM roles WHERE community_id = ? AND is_default = 1 LIMIT 1', [
      req.community.id,
    ])

    await withTransaction(async (conn) => {
      await conn.query('UPDATE memberships SET role_id = ? WHERE role_id = ? AND community_id = ?', [
        fallback?.id ?? null,
        role.id,
        req.community.id,
      ])
      await conn.query('DELETE FROM roles WHERE id = ?', [role.id])
    })
    res.json({ ok: true })
  }),
)

// ---------------------------------------------------------------
// Community settings
// ---------------------------------------------------------------
router.patch(
  '/dashboard/community',
  requireAuth,
  ctx,
  requirePermission('community.settings'),
  asyncHandler(async (req, res) => {
    const fields = {}
    if (req.body?.name != null) {
      const name = String(req.body.name).trim()
      if (name.length < 3 || name.length > 100) throw badRequest('Name must be 3–100 characters', { field: 'name' })
      fields.name = name
    }
    if (req.body?.tagline != null) fields.tagline = String(req.body.tagline).slice(0, 160) || null
    if (req.body?.description != null) fields.description = String(req.body.description) || null
    if (req.body?.logoUrl != null) fields.logo_url = String(req.body.logoUrl) || null
    if (req.body?.accentColor != null) {
      const colour = String(req.body.accentColor)
      if (colour && !isHexColour(colour)) {
        throw badRequest('Accent colour must be a hex value like #0b1f42', { field: 'accentColor' })
      }
      fields.accent_color = colour || null
    }

    if (fields.name) {
      const taken = await one('SELECT id FROM communities WHERE name = ? AND id <> ?', [fields.name, req.community.id])
      if (taken) throw conflict('That community name is already taken', { field: 'name' })
    }

    const keys = Object.keys(fields)
    if (keys.length) {
      const setSql = keys.map((k) => `${k} = ?`).join(', ')
      await pool.query(`UPDATE communities SET ${setSql} WHERE id = ?`, [...keys.map((k) => fields[k]), req.community.id])
    }

    const community = await one('SELECT * FROM communities WHERE id = ?', [req.community.id])
    res.json({ community: publicCommunity(community) })
  }),
)

export default router
