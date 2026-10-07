import express from 'express'
import mysql from 'mysql2/promise'
import crypto from 'node:crypto'

// ---------------------------------------------------------------
// Config (set these as env vars on the Cosmos ServApp)
// ---------------------------------------------------------------
const PORT = Number(process.env.PORT || 3000)
const DB = {
  host: process.env.DB_HOST || 'kgm-mysqli',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'app',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'scotlandrblx',
}
const SECRET = process.env.JWT_SECRET || 'change-me-to-a-long-random-string'
const SEED_USER = process.env.SEED_USER || 'admin'
const SEED_PASS = process.env.SEED_PASS || 'roms123'
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 })

// ---------------------------------------------------------------
// Password hashing (built-in scrypt - no extra dependencies)
// ---------------------------------------------------------------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex')
}

function verifyPassword(password, salt, expectedHash) {
  const actual = Buffer.from(hashPassword(password, salt), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

// ---------------------------------------------------------------
// Simple HMAC-signed tokens (stateless, survives container restarts)
// ---------------------------------------------------------------
function signToken(username) {
  const payload = Buffer.from(
    JSON.stringify({ sub: username, exp: Date.now() + TOKEN_TTL_MS }),
  ).toString('base64url')
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

function verifyToken(token) {
  const [payload, sig] = String(token || '').split('.')
  if (!payload || !sig) return null
  const expected = Buffer.from(
    crypto.createHmac('sha256', SECRET).update(payload).digest('base64url'),
  )
  const given = Buffer.from(sig)
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString())
    if (!data.exp || data.exp < Date.now()) return null
    return data
  } catch {
    return null
  }
}

// ---------------------------------------------------------------
// Database init: create table + seed a test user (only if empty)
// ---------------------------------------------------------------
let dbReady = false

async function initDB() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(64) NOT NULL UNIQUE,
          password_hash CHAR(128) NOT NULL,
          salt CHAR(32) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)
      const [rows] = await pool.query('SELECT COUNT(*) AS n FROM users')
      if (rows[0].n === 0) {
        const salt = crypto.randomBytes(16).toString('hex')
        await pool.query(
          'INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)',
          [SEED_USER, hashPassword(SEED_PASS, salt), salt],
        )
        console.log(`Seeded test user "${SEED_USER}" (change via SEED_USER/SEED_PASS env vars)`)
      }
      console.log('Database ready')
      dbReady = true
      return
    } catch (err) {
      console.log(`Database not ready (${err.code || err.message}) - retry ${attempt}/30`)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
  console.log('Giving up on database for now - will keep serving, logins will return 503')
}

// ---------------------------------------------------------------
// App
// ---------------------------------------------------------------
const app = express()
app.use(express.json())

app.get('/api/health', (_req, res) => res.json({ ok: true, dbReady }))

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' })
  }
  if (!dbReady) {
    return res.status(503).json({ error: 'Database not ready yet - try again shortly' })
  }
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [String(username)])
    const user = rows[0]
    if (!user || !verifyPassword(String(password), user.salt, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password' })
    }
    res.json({ token: signToken(user.username), user: { username: user.username } })
  } catch (err) {
    console.error('login error:', err.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

function auth(req, res, next) {
  const header = req.headers.authorization || ''
  const data = verifyToken(header.replace(/^Bearer\s+/i, ''))
  if (!data) return res.status(401).json({ error: 'Not authenticated' })
  req.user = data
  next()
}

app.get('/api/me', auth, (req, res) => res.json({ user: { username: req.user.sub } }))

app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

app.listen(PORT, () => {
  console.log(`roms-api listening on :${PORT} (db: ${DB.host}:${DB.port}/${DB.database})`)
  initDB()
})
