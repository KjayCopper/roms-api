import { Router } from 'express'
import { pool, one } from '../db.js'
import {
  hashPassword,
  newSalt,
  sha256,
  signSession,
  setSession,
  setCommunity,
  signCommunity,
} from '../lib/auth.js'
import {
  asyncHandler,
  badRequest,
  conflict,
  notFound,
  unauthorized,
  isValidEmail,
  USERNAME_RE,
} from '../lib/util.js'

const router = Router()

async function inviteByToken(token) {
  if (!token) return null
  return one(
    `SELECT m.id, m.community_id, m.user_id, m.status, m.display_name, m.invite_expires_at,
            u.email, u.username, u.password_hash,
            c.slug AS community_slug, c.name AS community_name,
            c.logo_url, c.accent_color, c.tagline
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       JOIN communities c ON c.id = m.community_id
      WHERE m.invite_token_hash = ?
      LIMIT 1`,
    [sha256(token)],
  )
}

// ---------------------------------------------------------------
// GET /api/invites/:token   -> what the accept page needs
// ---------------------------------------------------------------
router.get(
  '/invites/:token',
  asyncHandler(async (req, res) => {
    const invite = await inviteByToken(req.params.token)
    if (!invite || invite.status !== 'invited') throw notFound('This invite is no longer valid')
    if (invite.invite_expires_at && new Date(invite.invite_expires_at) < new Date()) {
      throw badRequest('This invite has expired')
    }

    res.json({
      invite: {
        community: {
          slug: invite.community_slug,
          name: invite.community_name,
          tagline: invite.tagline ?? null,
          logoUrl: invite.logo_url ?? null,
          accentColor: invite.accent_color ?? null,
        },
        email: invite.email,
        accountExists: !!invite.password_hash,
      },
    })
  }),
)

// ---------------------------------------------------------------
// POST /api/invites/accept
//   - new account:   { token, username, password, displayName }
//   - existing user: { token, displayName }   (must be logged in)
// ---------------------------------------------------------------
router.post(
  '/invites/accept',
  asyncHandler(async (req, res) => {
    const token = String(req.body?.token || '')
    const displayName = String(req.body?.displayName || '').trim()

    const invite = await inviteByToken(token)
    if (!invite || invite.status !== 'invited') throw notFound('This invite is no longer valid')
    if (invite.invite_expires_at && new Date(invite.invite_expires_at) < new Date()) {
      throw badRequest('This invite has expired')
    }
    if (!displayName) throw badRequest('Choose the name you will use in this community', { field: 'displayName' })
    if (displayName.length > 64) throw badRequest('That name is too long', { field: 'displayName' })

    if (invite.password_hash) {
      // Existing account — must be logged in as the invited user.
      if (!req.user || req.user.id !== invite.user_id) {
        throw unauthorized('Please log in to accept this invite')
      }
    } else {
      // Shadow account — set up username + password now.
      const username = String(req.body?.username || '').trim()
      const password = String(req.body?.password || '')
      if (!USERNAME_RE.test(username)) {
        throw badRequest('Username must be 3–32 characters (letters, numbers, . _ -)', { field: 'username' })
      }
      if (password.length < 8) throw badRequest('Password must be at least 8 characters', { field: 'password' })

      const taken = await one('SELECT id FROM users WHERE username = ? AND id <> ?', [username, invite.user_id])
      if (taken) throw conflict('That username is taken', { field: 'username' })

      const salt = newSalt()
      await pool.query(
        'UPDATE users SET username = ?, password_hash = ?, salt = ?, email_verified = 1 WHERE id = ?',
        [username, hashPassword(password, salt), salt, invite.user_id],
      )
      setSession(res, signSession(invite.user_id))
    }

    await pool.query(
      `UPDATE memberships
          SET display_name = ?, status = 'active', accepted_at = NOW(),
              joined_at = COALESCE(joined_at, NOW()),
              invite_token_hash = NULL, invite_expires_at = NULL
        WHERE id = ?`,
      [displayName, invite.id],
    )

    // Drop them straight into the community.
    setCommunity(res, signCommunity(invite.community_id))
    res.json({ ok: true, communityId: invite.community_id, communitySlug: invite.community_slug })
  }),
)

export default router
