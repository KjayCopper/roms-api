import crypto from 'node:crypto'
import {
  COOKIE_SECURE,
  COMMUNITY_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from './config.js'
import { one } from '../db.js'
import { asyncHandler, forbidden, unauthorized } from './util.js'
import { effectivePermissions } from './permissions.js'

const SECRET = process.env.JWT_SECRET || 'change-me-to-a-long-random-string'

// ---------------------------------------------------------------
// Passwords (built-in scrypt — no extra dependencies)
// ---------------------------------------------------------------
export function newSalt() {
  return crypto.randomBytes(16).toString('hex')
}

export function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex')
}

export function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false
  const actual = Buffer.from(hashPassword(password, salt), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex')
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

export function generateCode(digits = 6) {
  return String(crypto.randomInt(0, 10 ** digits)).padStart(digits, '0')
}

// Constant-time comparison for short secrets (verification codes, hashes).
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}

// ---------------------------------------------------------------
// Signed tokens (stateless, HMAC)
//   session:   { typ:'session',   sub: userId,     exp }
//   community: { typ:'community', cid: communityId, exp }
// ---------------------------------------------------------------
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verify(token) {
  const [body, sig] = String(token || '').split('.')
  if (!body || !sig) return null
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url')
  const a = Buffer.from(expected)
  const b = Buffer.from(sig)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (!data.exp || data.exp < Date.now()) return null
    return data
  } catch {
    return null
  }
}

export const signSession = (userId) =>
  sign({ typ: 'session', sub: userId, exp: Date.now() + SESSION_TTL_MS })

export const signCommunity = (communityId) =>
  sign({ typ: 'community', cid: communityId, exp: Date.now() + SESSION_TTL_MS })

// ---------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------
export function parseCookies(req) {
  const header = req.headers?.cookie || ''
  const out = {}
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i === -1) continue
    const key = part.slice(0, i).trim()
    if (!key) continue
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim())
    } catch {
      out[key] = part.slice(i + 1).trim()
    }
  }
  return out
}

function baseCookie(extra = {}) {
  return { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax', path: '/', ...extra }
}

export const setSession = (res, token) => res.cookie(SESSION_COOKIE, token, baseCookie({ maxAge: SESSION_TTL_MS }))
export const clearSession = (res) => res.clearCookie(SESSION_COOKIE, baseCookie())
export const setCommunity = (res, token) => res.cookie(COMMUNITY_COOKIE, token, baseCookie({ maxAge: SESSION_TTL_MS }))
export const clearCommunity = (res) => res.clearCookie(COMMUNITY_COOKIE, baseCookie())

// ---------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------
export async function loadUser(id) {
  return one(
    `SELECT id, username, email, password_hash, is_platform_admin, created_at, last_login_at
       FROM users WHERE id = ?`,
    [id],
  )
}

// Populates req.user when a valid session cookie / bearer token is present.
export const authenticate = asyncHandler(async (req, _res, next) => {
  const cookies = parseCookies(req)
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const token = cookies[SESSION_COOKIE] || bearer || null
  const data = token ? verify(token) : null
  req.user = data && data.typ === 'session' ? await loadUser(data.sub) : null
  next()
})

export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized('You must be logged in'))
  next()
}

// Resolves the selected community (from the signed community cookie) and the
// caller's membership + effective permissions. Must run after authenticate.
export const communityContext = asyncHandler(async (req, _res, next) => {
  const data = verify(parseCookies(req)[COMMUNITY_COOKIE])
  if (!data || data.typ !== 'community') return next(forbidden('No community selected'))
  const community = await one('SELECT * FROM communities WHERE id = ?', [data.cid])
  if (!community) return next(forbidden('No community selected'))
  const membership = await one(
    `SELECT m.id, m.user_id, m.community_id, m.role_id, m.display_name, m.status,
            r.key AS role_key, r.name AS role_name, r.position AS role_position,
            r.is_owner, r.permissions
       FROM memberships m
       LEFT JOIN roles r ON r.id = m.role_id
      WHERE m.user_id = ? AND m.community_id = ?`,
    [req.user.id, community.id],
  )
  if (!membership || membership.status !== 'active') {
    return next(forbidden('You are not a member of this community'))
  }
  req.community = community
  req.membership = membership
  req.role = membership.role_id
    ? {
        id: membership.role_id,
        key: membership.role_key,
        name: membership.role_name,
        position: membership.role_position,
        isOwner: !!membership.is_owner,
        permissions: membership.permissions,
      }
    : null
  req.permissions = effectivePermissions({ is_owner: membership.is_owner, permissions: membership.permissions })
  next()
})

export function requirePermission(key) {
  return (req, _res, next) => {
    if (!req.permissions || !req.permissions.includes(key)) {
      return next(forbidden(`Missing permission: ${key}`))
    }
    next()
  }
}
