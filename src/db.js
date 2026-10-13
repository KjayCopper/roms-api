import mysql from 'mysql2/promise'

const DB = {
  host: process.env.DB_HOST || 'kgm-mysqli',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'app',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'roms',
}

export const pool = mysql.createPool({
  ...DB,
  waitForConnections: true,
  connectionLimit: 10,
})

export const dbInfo = DB

export async function query(sql, params) {
  const [rows] = await pool.query(sql, params)
  return rows
}

export async function one(sql, params) {
  const rows = await query(sql, params)
  return rows[0] || null
}

export async function withTransaction(fn) {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const result = await fn(conn)
    await conn.commit()
    return result
  } catch (err) {
    try {
      await conn.rollback()
    } catch {
      /* ignore */
    }
    throw err
  } finally {
    conn.release()
  }
}
