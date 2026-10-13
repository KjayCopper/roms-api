import path from 'node:path'

// ---------------------------------------------------------------
// Config (env names unchanged from before; new ones added)
// ---------------------------------------------------------------
export const PORT = Number(process.env.PORT || 3000)

export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads')

// Base URL of the portal, used to build invite links.
export const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://roms.kgmcloud.co.uk').replace(/\/+$/, '')

// Accepts SMTP_FROM (preferred) or MAIL_FROM / EMAIL_FROM.
export const MAIL_FROM =
  process.env.SMTP_FROM ||
  process.env.MAIL_FROM ||
  process.env.EMAIL_FROM ||
  'KGM Cloud ROMS <noreply@kgmcloud.co.uk>'

export const INVITE_TTL_MS = Number(process.env.INVITE_TTL_MS || 14 * 24 * 60 * 60 * 1000) // 14 days

export const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000) // 7 days

// Sign-up email verification
export const VERIFICATION_TTL_MS = Number(process.env.VERIFICATION_TTL_MS || 15 * 60 * 1000) // 15 minutes
export const VERIFY_MAX_ATTEMPTS = Number(process.env.VERIFY_MAX_ATTEMPTS || 6)
export const RESEND_COOLDOWN_MS = Number(process.env.RESEND_COOLDOWN_MS || 60 * 1000) // 60 seconds

// Set LOG_VERIFICATION_CODES=true to also print codes to the log even when
// SMTP is configured. Useful while email delivery is being set up — leave off
// in production once mail works.
export const LOG_CODES = String(process.env.LOG_VERIFICATION_CODES || '').toLowerCase() === 'true'

// Secure cookies only over HTTPS (on by default in production).
export const COOKIE_SECURE =
  process.env.COOKIE_SECURE != null
    ? String(process.env.COOKIE_SECURE) === 'true'
    : process.env.NODE_ENV === 'production'

export const SESSION_COOKIE = 'roms_session'
export const COMMUNITY_COOKIE = 'roms_community'
