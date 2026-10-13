import express from 'express'
import fs from 'node:fs/promises'
import dns from 'node:dns/promises'
import { pool, dbInfo } from './db.js'
import { authenticate } from './lib/auth.js'
import { MAIL_ENABLED } from './lib/mail.js'
import { UPLOAD_DIR, PORT } from './lib/config.js'
import authRoutes from './routes/authRoutes.js'
import communityRoutes from './routes/communityRoutes.js'
import inviteRoutes from './routes/inviteRoutes.js'
import dashboardRoutes from './routes/dashboardRoutes.js'

// ---------------------------------------------------------------
// DB readiness (does NOT create tables — the schema is applied by
// hand via phpMyAdmin, see db/schema.sql)
// ---------------------------------------------------------------
let dbReady = false

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function checkDB() {
  await pool.query('SELECT 1')
}

// Probe the database at boot and, if it is not reachable yet, keep retrying
// in the background (every 10s, forever) until it answers. A DNS/network
// problem at boot therefore no longer leaves the API stuck at "not ready".
async function waitForDB() {
  let attempt = 0
  for (;;) {
    attempt++
    try {
      await checkDB()
      if (!dbReady) {
        dbReady = true
        console.log(`Database reachable (${dbInfo.host}:${dbInfo.port}/${dbInfo.database})`)
      }
      return
    } catch (err) {
      dbReady = false
      if (attempt <= 3 || attempt % 10 === 0) {
        console.warn(`Database not reachable (${err.code || err.message}) - retry ${attempt}`)
      }
      await sleep(10000)
    }
  }
}

// ---------------------------------------------------------------
// App
// ---------------------------------------------------------------
const app = express()
app.set('trust proxy', 1)
app.use(express.json({ limit: '8mb' }))
app.use(authenticate) // populates req.user when a session cookie/token is present

// Live health check: actually talks to the database on every request and
// reports what the container's DNS resolves the DB host to. Open this in a
// browser to diagnose a broken DB connection without needing a shell.
app.get('/api/health', async (_req, res) => {
  const target = `${dbInfo.host}:${dbInfo.port}/${dbInfo.database}`

  let resolved
  try {
    resolved = (await dns.lookup(dbInfo.host)).address
  } catch (err) {
    resolved = `unresolved (${err.code || err.message})`
  }

  try {
    await checkDB()
    dbReady = true
    res.json({
      ok: true,
      dbReady: true,
      db: target,
      resolved,
      mail: MAIL_ENABLED ? 'smtp' : 'log-only',
    })
  } catch (err) {
    dbReady = false
    res.json({
      ok: true,
      dbReady: false,
      db: target,
      resolved,
      mail: MAIL_ENABLED ? 'smtp' : 'log-only',
      error: err.code || err.message,
    })
  }
})

// Uploaded community logos etc.
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }))

app.use('/api', authRoutes)
app.use('/api', communityRoutes)
app.use('/api', inviteRoutes)
app.use('/api', dashboardRoutes)

app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || 500
  if (status >= 500) console.error(err)
  res.status(status).json({ error: err.message || 'Internal server error', ...(err.extra || {}) })
})

app.listen(PORT, async () => {
  console.log(`roms-api listening on :${PORT} (db: ${dbInfo.host}:${dbInfo.port}/${dbInfo.database})`)
  try {
    await fs.mkdir(UPLOAD_DIR, { recursive: true })
  } catch (err) {
    console.error('Could not create upload dir:', err.message)
  }
  waitForDB()
})
