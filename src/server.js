import express from 'express'
import fs from 'node:fs/promises'
import { pool, dbInfo } from './db.js'
import { authenticate } from './lib/auth.js'
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

async function waitForDB() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await pool.query('SELECT 1')
      dbReady = true
      console.log(`Database ready (${dbInfo.host}:${dbInfo.port}/${dbInfo.database})`)
      return
    } catch (err) {
      console.log(`Database not ready (${err.code || err.message}) - retry ${attempt}/30`)
      await sleep(3000)
    }
  }
  console.log('Giving up on database for now - the API will keep serving, auth will fail')
}

// ---------------------------------------------------------------
// App
// ---------------------------------------------------------------
const app = express()
app.set('trust proxy', 1)
app.use(express.json({ limit: '8mb' }))
app.use(authenticate) // populates req.user when a session cookie/token is present

app.get('/api/health', (_req, res) => res.json({ ok: true, dbReady }))

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
