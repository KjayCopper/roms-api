import nodemailer from 'nodemailer'
import { MAIL_FROM, PUBLIC_URL } from './config.js'

const { SMTP_HOST, SMTP_PORT = '587', SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env

let transporter = null

if (SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: String(SMTP_SECURE) === 'true' || Number(SMTP_PORT) === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  })
} else {
  console.log('[mail] SMTP_HOST not set — invite links will be logged instead of emailed')
}

export async function sendMail({ to, subject, text, html }) {
  if (!transporter) {
    console.log(`[mail] would send to ${to}: ${subject}\n${text}`)
    return false
  }
  await transporter.sendMail({ from: MAIL_FROM, to, subject, text, html })
  return true
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
