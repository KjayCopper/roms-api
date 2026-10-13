import { Router } from 'express'
import { pool, one } from '../db.js'
import { editorContext, requireAuth, requirePermission, communityContext, signEditor } from '../lib/auth.js'
import { asyncHandler, notFound, normaliseSlug, publicCommunity } from '../lib/util.js'
import { SITE_DOMAIN } from '../lib/config.js'
import { defaultSite, parseSite, sanitiseSite } from '../lib/site.js'

const router = Router()

const PAGE = 'home'

// The community that owns a public address, plus its page row.
async function communityBySlug(value) {
  return one(
    'SELECT id, slug, name, tagline, description, logo_url, accent_color, theme FROM communities WHERE slug = ?',
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
    res.json({ site: parseSite(page?.published) || defaultSite(community) })
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
    const published = parseSite(page?.published) || defaultSite(req.community)
    const draft = parseSite(page?.draft) || published
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
    const site = sanitiseSite(req.body?.site)
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
    const published = parseSite(page?.published) || defaultSite(req.community)

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
    const published = parseSite(page?.published) || defaultSite(req.community)
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
    const published = parseSite(page?.published) || defaultSite(req.community)
    res.json({ draft: published, hasUnpublishedChanges: false })
  }),
)

export default router
