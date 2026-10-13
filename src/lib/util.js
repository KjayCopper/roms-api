// ---------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

export const badRequest = (msg, extra) => new HttpError(400, msg, extra)
export const unauthorized = (msg = 'Not authenticated') => new HttpError(401, msg)
export const forbidden = (msg = 'Not allowed') => new HttpError(403, msg)
export const notFound = (msg = 'Not found') => new HttpError(404, msg)
export const conflict = (msg, extra) => new HttpError(409, msg, extra)

// Wrap async route handlers so thrown errors reach the error middleware.
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next)

// ---- slug / input validation ----

// 3–63 chars, lowercase letters/numbers/hyphens, no leading/trailing hyphen.
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/

export const normaliseSlug = (v) => String(v ?? '').trim().toLowerCase()

export const isValidSlug = (slug) => SLUG_RE.test(slug)

export const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/

export const isValidEmail = (email) =>
  typeof email === 'string' && email.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)

// ---- serialisers ----

export function publicUser(u) {
  if (!u) return null
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    isPlatformAdmin: !!u.is_platform_admin,
  }
}

export function publicCommunity(c) {
  if (!c) return null
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    tagline: c.tagline ?? null,
    description: c.description ?? null,
    logoUrl: c.logo_url ?? null,
    accentColor: c.accent_color ?? null,
  }
}
