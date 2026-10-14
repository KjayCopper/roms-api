import { Router } from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pool, one } from '../db.js'
import { editorContext, requireAuth, requirePermission, communityContext, signEditor } from '../lib/auth.js'
import { asyncHandler, badRequest, notFound, normaliseSlug, publicCommunity } from '../lib/util.js'
import { SITE_DOMAIN, UPLOAD_DIR } from '../lib/config.js'
import { defaultSite, migrateSite, parseSite, sanitiseSite } from '../lib/site.js'

const router = Router()

const PAGE = 'home'

const LOGO_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

// The community that owns a public address, plus its page row.
async function communityBySlug(value) {
  return one(
    'SELECT id, slug, name, tagline, description, logo_url, accent_color, theme, discord_url FROM communities WHERE slug = ?',
    [normaliseSlug(value)],
  )
}

// A community created before the site editor existed still needs a page row.
export async function ensurePage(community) {
  const existing = await one('SELECT id FROM community_pages WHERE community_id = ? AND page_slug = ?', [
    community.id,
    PAGE,
  ])
  if (existing) return
  const site = JSON.stringify(defaultSite(community))
  await pool.query(
    `INSERT IGNORE INTO community_pages (community_id, page_slug, draft, published, published_at)
     VALUES (?, ?, ?, ?, NOW())`,
    [community.id, PAGE, site, site],
  )
}

// ---------------------------------------------------------------
// GET /api/communities/:slug/site   (public)
// What the community's website renders. Never returns the draft.
// ---------------------------------------------------------------
router.get(
  '/communities/:slug/site',
  asyncHandler(async (req, res) => {
    const community = await communityBySlug(req.params.slug)
    if (!community) throw notFound('Community not found')

    const page = await one('SELECT published FROM community_pages WHERE community_id = ? AND page_slug = ?', [
      community.id,
      PAGE,
    ])
    res.json({ site: migrateSite(parseSite(page?.published) || defaultSite(community), community) })
  }),
)

// ---------------------------------------------------------------
// POST /api/site/editor-token
// Minted by the portal; the editor on the community's subdomain trades it
// for API access. Requires the community.settings permission.
// ---------------------------------------------------------------
router.post(
  '/site/editor-token',
  requireAuth,
  communityContext,
  requirePermission('community.settings'),
  asyncHandler(async (req, res) => {
    await ensurePage(req.community)
    const token = signEditor(req.user.id, req.community.id)
    res.json({
      token,
      url: `https://${req.community.slug}.${SITE_DOMAIN}/editor#t=${token}`,
    })
  }),
)

// ---------------------------------------------------------------
// GET /api/site/editor  -> draft + published + what is live
// ---------------------------------------------------------------
router.get(
  '/site/editor',
  editorContext,
  asyncHandler(async (req, res) => {
    await ensurePage(req.community)
    const page = await one(
      'SELECT draft, published, published_at, updated_at FROM community_pages WHERE community_id = ? AND page_slug = ?',
      [req.community.id, PAGE],
    )
    const published = migrateSite(parseSite(page?.published) || defaultSite(req.community), req.community)
    const draft = migrateSite(parseSite(page?.draft) || published, req.community)
    res.json({
      community: publicCommunity(req.community),
      permissions: req.permissions,
      draft,
      published,
      publishedAt: page?.published_at || null,
      updatedAt: page?.updated_at || null,
      hasUnpublishedChanges: JSON.stringify(draft) !== JSON.stringify(published),
    })
  }),
)

// ---------------------------------------------------------------
// PATCH /api/site/editor   { site }  -> saves the draft only
// ---------------------------------------------------------------
router.patch(
  '/site/editor',
  editorContext,
  requirePermission('community.settings'),
  asyncHandler(async (req, res) => {
    const site = sanitiseSite(req.body?.site, req.community)
    const json = JSON.stringify(site)
    const fallback = JSON.stringify(defaultSite(req.community))

    await pool.query(
      `INSERT INTO community_pages (community_id, page_slug, draft, published)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE draft = VALUES(draft)`,
      [req.community.id, PAGE, json, fallback],
    )

    const page = await one('SELECT published FROM community_pages WHERE community_id = ? AND page_slug = ?', [
      req.community.id,
      PAGE,
    ])
    const published = migrateSite(parseSite(page?.published) || defaultSite(req.community), req.community)

    res.json({ draft: site, hasUnpublishedChanges: JSON.stringify(site) !== JSON.stringify(published) })
  }),
)

// ---------------------------------------------------------------
// POST /api/site/editor/publish -> copy draft over published
// ---------------------------------------------------------------
router.post(
  '/site/editor/publish',
  editorContext,
  requirePermission('community.settings'),
  asyncHandler(async (req, res) => {
    await ensurePage(req.community)
    await pool.query(
      `UPDATE community_pages
          SET published = draft, published_at = NOW()
        WHERE community_id = ? AND page_slug = ?`,
      [req.community.id, PAGE],
    )
    const page = await one(
      'SELECT draft, published, published_at FROM community_pages WHERE community_id = ? AND page_slug = ?',
      [req.community.id, PAGE],
    )
    const published = migrateSite(parseSite(page?.published) || defaultSite(req.community), req.community)
    res.json({ published, publishedAt: page?.published_at || null, hasUnpublishedChanges: false })
  }),
)

// ---------------------------------------------------------------
// POST /api/site/editor/discard -> throw the draft away
// ---------------------------------------------------------------
router.post(
  '/site/editor/discard',
  editorContext,
  requirePermission('community.settings'),
  asyncHandler(async (req, res) => {
    await ensurePage(req.community)
    await pool.query(
      `UPDATE community_pages SET draft = published WHERE community_id = ? AND page_slug = ?`,
      [req.community.id, PAGE],
    )
    const page = await one('SELECT published FROM community_pages WHERE community_id = ? AND page_slug = ?', [
      req.community.id,
      PAGE,
    ])
    const published = migrateSite(parseSite(page?.published) || defaultSite(req.community), req.community)
    res.json({ draft: published, hasUnpublishedChanges: false })
  }),
)

// ---------------------------------------------------------------
// POST /api/site/editor/logo   { dataUrl }  -> { community }
//
// The navbar logo IS the community logo (the same one the portal shows), so
// uploading from the editor updates the community rather than the page. Pass
// `dataUrl: null` to remove it. The page config is untouched.
// ---------------------------------------------------------------
router.post(
  '/site/editor/logo',
  editorContext,
  requirePermission('community.settings'),
  asyncHandler(async (req, res) => {
    let url = null

    if (req.body?.dataUrl) {
      const match = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(req.body.dataUrl))
      if (!match) throw badRequest('Provide an image as a data URL')

      const ext = LOGO_TYPES[match[1].toLowerCase()]
      if (!ext) throw badRequest('Only PNG, JPEG, WebP or GIF images are allowed')

      const buffer = Buffer.from(match[2], 'base64')
      if (buffer.length === 0) throw badRequest('The image is empty')
      if (buffer.length > 2 * 1024 * 1024) throw badRequest('Image must be 2 MB or smaller')

      const dir = path.join(UPLOAD_DIR, 'logos')
      await fs.mkdir(dir, { recursive: true })
      const filename = `${crypto.randomUUID()}.${ext}`
      await fs.writeFile(path.join(dir, filename), buffer)
      url = `/uploads/logos/${filename}`
    }

    await pool.query('UPDATE communities SET logo_url = ? WHERE id = ?', [url, req.community.id])
    const community = await one('SELECT * FROM communities WHERE id = ?', [req.community.id])
    res.json({ community: publicCommunity(community) })
  }),
)

export default router
