import nodemailer from 'nodemailer'
import { MAIL_FROM, PUBLIC_URL } from './config.js'

// Accept a few common spellings so the settings can be copied straight from
// another app without renaming anything.
const pick = (...names) =>
  names.map((n) => process.env[n]).find((v) => v != null && v !== '')

const SMTP_HOST = pick('SMTP_HOST', 'MAIL_HOST', 'EMAIL_HOST', 'SMTP_SERVER')
const SMTP_PORT = pick('SMTP_PORT', 'MAIL_PORT', 'EMAIL_PORT') || '587'
const SMTP_SECURE = pick('SMTP_SECURE', 'MAIL_SECURE', 'SMTP_SSL')
const SMTP_USER = pick('SMTP_USER', 'SMTP_USERNAME', 'MAIL_USER', 'MAIL_USERNAME')
const SMTP_PASS = pick('SMTP_PASS', 'SMTP_PASSWORD', 'MAIL_PASS', 'MAIL_PASSWORD')

let transporter = null

const smtpPort = Number(SMTP_PORT)
const smtpSecure = String(SMTP_SECURE).toLowerCase() === 'true' || smtpPort === 465

if (SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: smtpPort,
    secure: smtpSecure,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    // Fail fast (15s) instead of hanging silently for minutes on a blocked port.
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  })
  console.log(
    `[mail] SMTP configured: ${SMTP_HOST}:${smtpPort} secure=${smtpSecure} user=${SMTP_USER || '(none)'} from=${MAIL_FROM}`,
  )
  // Proves the credentials work at boot, so a bad password is obvious.
  transporter
    .verify()
    .then(() => console.log('[mail] SMTP login OK — mail can be sent'))
    .catch((err) => console.error('[mail] SMTP login FAILED:', err.message))
} else {
  console.log(
    '[mail] No SMTP_HOST / MAIL_HOST set — verification codes and invite links will be logged instead of emailed',
  )
}

// True when a real SMTP transport is configured (exposed on /api/health).
export const MAIL_ENABLED = Boolean(transporter)

// Where mail is pointed, exposed on /api/health for troubleshooting.
export const SMTP_TARGET = SMTP_HOST
  ? { host: SMTP_HOST, port: smtpPort, secure: smtpSecure }
  : null

export async function sendMail({ to, subject, text, html }) {
  if (!transporter) {
    console.log(`[mail] would send to ${to}: ${subject}\n${text}`)
    return false
  }
  await transporter.sendMail({ from: MAIL_FROM, to, subject, text, html })
  console.log(`[mail] sent "${subject}" to ${to}`)
  return true
}

// Used by /api/health?mail=1 to prove (or disprove) the SMTP login on demand.
export async function verifyMail() {
  if (!transporter) return { ok: false, error: 'no SMTP transport configured (log-only)' }
  try {
    await transporter.verify()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

export function inviteEmail({ communityName, token, email }) {
  const link = `${PUBLIC_URL}/invite/${token}`
  const subject = `You've been invited to ${communityName} on KGM Cloud ROMS`
  const text =
    `Your application to ${communityName} was approved.\n\n` +
    `Set up your profile here:\n${link}\n\n` +
    `Sent to ${email}. If this wasn't you, you can ignore this email.`
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:auto">
      <h2 style="color:#0b1f42">You've been invited to ${escapeHtml(communityName)}</h2>
      <p>Your application was approved. Click below to set up the name you'll use in this community.</p>
      <p style="margin:24px 0">
        <a href="${link}" style="background:#0b1f42;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">
          Set up my profile
        </a>
      </p>
      <p style="color:#64748b;font-size:13px">Or paste this link into your browser:<br>${link}</p>
      <p style="color:#94a3b8;font-size:12px">Sent to ${escapeHtml(email)}. If this wasn't you, you can ignore this email.</p>
    </div>`
  return { subject, text, html }
}

export function verificationEmail({ code, email }) {
  const subject = 'Your KGM Cloud ROMS verification code'
  const text =
    `Welcome to KGM Cloud ROMS!\n\n` +
    `Your verification code is: ${code}\n\n` +
    `Enter it to finish setting up your account. The code expires in 15 minutes.\n\n` +
    `If this wasn't you, you can ignore this email.`
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:auto">
      <h2 style="color:#0b1f42">Welcome to KGM Cloud ROMS</h2>
      <p>Thanks for signing up. Enter the code below to verify your email address.</p>
      <p style="margin:28px 0;text-align:center">
        <span style="display:inline-block;background:#0b1f42;color:#fff;font-size:30px;font-weight:800;letter-spacing:10px;padding:16px 24px 16px 34px;border-radius:12px">${code}</span>
      </p>
      <p style="color:#64748b;font-size:13px">The code expires in 15 minutes.</p>
      <p style="color:#94a3b8;font-size:12px">Sent to ${escapeHtml(email)}. If this wasn't you, you can ignore this email.</p>
    </div>`
  return { subject, text, html }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
}
