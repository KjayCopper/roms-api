import { Router } from 'express'
import { pool, one, query, withTransaction } from '../db.js'
import {
  authenticate,
  requireAuth,
  hashPassword,
  newSalt,
  verifyPassword,
  signSession,
  setSession,
  clearSession,
  clearCommunity,
  generateCode,
  sha256,
  safeEqual,
} from '../lib/auth.js'
import {
  asyncHandler,
  badRequest,
  conflict,
  HttpError,
  publicUser,
  isValidEmail,
} from '../lib/util.js'
import { effectivePermissions } from '../lib/permissions.js'
import { sendMail, verificationEmail } from '../lib/mail.js'
import {
  VERIFICATION_TTL_MS,
  VERIFY_MAX_ATTEMPTS,
  RESEND_COOLDOWN_MS,
} from '../lib/config.js'

const router = Router()

const normaliseEmail = (v) => String(v ?? '').trim().toLowerCase()

function membershipView(m) {
  return {
    id: m.id,
    communityId: m.community_id,
    community: {
      id: m.community_id,
      slug: m.slug,
      name: m.name,
      tagline: m.tagline ?? null,
      logoUrl: m.logo_url ?? null,
      accentColor: m.accent_color ?? null,
    },
    displayName: m.display_name ?? null,
    status: m.status,
    role: m.role_id
      ? { id: m.role_id, key: m.role_key, name: m.role_name, position: m.role_position, isOwner: !!m.is_owner }
      : null,
    permissions: effectivePermissions({ is_owner: m.is_owner, permissions: m.role_permissions }),
  }
}

async function membershipsFor(userId) {
  const rows = await query(
    `SELECT m.id, m.community_id, m.display_name, m.status, m.role_id,
            c.slug, c.name, c.tagline, c.logo_url, c.accent_color,
            r.key AS role_key, r.name AS role_name, r.position AS role_position,
            r.is_owner, r.permissions AS role_permissions
       FROM memberships m
       JOIN communities c ON c.id = m.community_id
       LEFT JOIN roles r ON r.id = m.role_id
      WHERE m.user_id = ? AND m.status IN ('active','invited','suspended')
      ORDER BY c.name`,
    [userId],
  )
  return rows.map(membershipView)
}

// Creates (or replaces) a 6-digit code for a user and returns the plain code.
async function issueVerificationCode(userId) {
  const code = generateCode(6)
  const expires = new Date(Date.now() + VERIFICATION_TTL_MS)
  await pool.query(
    `INSERT INTO email_verifications (user_id, code_hash, expires_at, attempts)
     VALUES (?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE code_hash = VALUES(code_hash),
                             expires_at = VALUES(expires_at),
                             attempts = 0,
                             created_at = NOW()`,
    [userId, sha256(code), expires],
  )
  return code
}

// ---------------------------------------------------------------
// POST /api/auth/register   { email, password }
// Creates an unverified account and emails a 6-digit code.
// No session yet — the account only becomes usable after /verify.
// ---------------------------------------------------------------
router.post(
  '/auth/register',
  asyncHandler(async (req, res) => {
    const email = normaliseEmail(req.body?.email)
    const password = String(req.body?.password || '')

    if (!isValidEmail(email)) throw badRequest('Enter a valid email address', { field: 'email' })
    if (password.length < 8) throw badRequest('Password must be at least 8 characters', { field: 'password' })

    const existing = await one('SELECT id, password_hash, email_verified FROM users WHERE email = ?', [email])
    if (existing && existing.password_hash && existing.email_verified) {
      throw conflict('That email is already registered — try signing in', {
        field: 'email',
        code: 'already_registered',
      })
    }

    let userId
    const salt = newSalt()
    if (existing) {
      // Either an unfinished sign-up or a shadow account created by an approval — claim it.
      await pool.query('UPDATE users SET password_hash = ?, salt = ?, email_verified = 0 WHERE id = ?', [
        hashPassword(password, salt),
        salt,
        existing.id,
      ])
      userId = existing.id
    } else {
      const [result] = await pool.query(
        'INSERT INTO users (email, password_hash, salt) VALUES (?, ?, ?)',
        [email, hashPassword(password, salt), salt],
      )
      userId = result.insertId
    }

    const code = await issueVerificationCode(userId)
    let emailed = false
    try {
      emailed = await sendMail({ to: email, ...verificationEmail({ code, email }) })
    } catch (err) {
      console.error('verification email failed:', err.message)
    }

    res.status(201).json({ ok: true, email, requiresVerification: true, emailed })
  }),
)

// ---------------------------------------------------------------
// POST /api/auth/verify   { email, code }
// ---------------------------------------------------------------
router.post(
  '/auth/verify',
  asyncHandler(async (req, res) => {
    const email = normaliseEmail(req.body?.email)
    const code = String(req.body?.code || '').trim()

    if (!isValidEmail(email)) throw badRequest('Enter a valid email address', { field: 'email' })
    if (!/^\d{6}$/.test(code)) throw badRequest('Enter the 6-digit code', { field: 'code' })

    const user = await one('SELECT id, email_verified FROM users WHERE email = ?', [email])
    if (!user) throw badRequest('We could not find that account', { code: 'no_account' })
    if (user.email_verified) {
      throw badRequest('This account is already verified — please sign in', { code: 'already_verified' })
    }

    const record = await one(
      'SELECT code_hash, expires_at, attempts FROM email_verifications WHERE user_id = ?',
      [user.id],
    )
    if (!record) throw badRequest('That code has expired — request a new one', { code: 'code_expired' })

    if (new Date(record.expires_at).getTime() < Date.now()) {
      await pool.query('DELETE FROM email_verifications WHERE user_id = ?', [user.id])
      throw badRequest('That code has expired — request a new one', { code: 'code_expired' })
    }
    if (record.attempts >= VERIFY_MAX_ATTEMPTS) {
      await pool.query('DELETE FROM email_verifications WHERE user_id = ?', [user.id])
      throw new HttpError(429, 'Too many attempts — request a new code', { code: 'too_many_attempts' })
    }
    if (!safeEqual(sha256(code), record.code_hash)) {
      await pool.query('UPDATE email_verifications SET attempts = attempts + 1 WHERE user_id = ?', [user.id])
      throw badRequest('That code is not right', { field: 'code', code: 'bad_code' })
    }

    await withTransaction(async (conn) => {
      await conn.query('UPDATE users SET email_verified = 1 WHERE id = ?', [user.id])
      await conn.query('DELETE FROM email_verifications WHERE user_id = ?', [user.id])
    })

    setSession(res, signSession(user.id))
    const full = await one('SELECT * FROM users WHERE id = ?', [user.id])
    res.json({ user: publicUser(full), memberships: await membershipsFor(user.id) })
  }),
)

// ---------------------------------------------------------------
// POST /api/auth/resend   { email }
// Always replies ok so it can't be used to probe for accounts.
// ---------------------------------------------------------------
router.post(
  '/auth/resend',
  asyncHandler(async (req, res) => {
    const email = normaliseEmail(req.body?.email)
    if (!isValidEmail(email)) throw badRequest('Enter a valid email address', { field: 'email' })

    const user = await one('SELECT id, email_verified FROM users WHERE email = ?', [email])
    if (user && !user.email_verified) {
      const record = await one('SELECT created_at FROM email_verifications WHERE user_id = ?', [user.id])
      if (record && Date.now() - new Date(record.created_at).getTime() < RESEND_COOLDOWN_MS) {
        throw new HttpError(429, 'Please wait a moment before requesting another code', { code: 'cooldown' })
      }
      const code = await issueVerificationCode(user.id)
      try {
        await sendMail({ to: email, ...verificationEmail({ code, email }) })
      } catch (err) {
        console.error('verification email failed:', err.message)
      }
    }

    res.json({ ok: true })
  }),
)

// ---------------------------------------------------------------
// POST /api/auth/login   { identifier, password }   (email OR username)
// ---------------------------------------------------------------
router.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
    const identifier = String(req.body?.identifier ?? req.body?.email ?? req.body?.username ?? '').trim()
    const password = String(req.body?.password || '')
    if (!identifier || !password) throw badRequest('Enter your email and password')

    const user = await one('SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1', [
      identifier.toLowerCase(),
      identifier,
    ])
    if (!user || !user.password_hash || !verifyPassword(password, user.salt, user.password_hash)) {
      throw badRequest('Invalid email or password')
    }
    if (!user.email_verified) {
      throw new HttpError(403, 'Please verify your email to continue', {
        code: 'email_unverified',
        email: user.email,
      })
    }

    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id])
    setSession(res, signSession(user.id))
    res.json({ user: publicUser(user), memberships: await membershipsFor(user.id) })
  }),
)

// ---------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------
router.post('/auth/logout', (req, res) => {
  clearSession(res)
  clearCommunity(res)
  res.json({ ok: true })
})

// ---------------------------------------------------------------
// GET /api/auth/me  -> user + memberships (+ pending invites)
// ---------------------------------------------------------------
router.get(
  '/auth/me',
  authenticate,
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: publicUser(req.user), memberships: await membershipsFor(req.user.id) })
  }),
)

export default router
