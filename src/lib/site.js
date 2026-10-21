// ---------------------------------------------------------------
// Community website: block catalogue, default layout and validation.
//
// A site is one JSON document:
//
//   {
//     version: 2,
//     header:  { logoStyle, navColor, links: [{ label, kind, href|page }] },
//     blocks:  [{ id, type, props: {...} }],        // the home page
//     pages:   [{ slug, title, blocks: [...] }],    // custom pages
//     footer:  { text, links: [{ label, kind, href|page }] }
//   }
//
// `version` lets stored documents be migrated in place (see migrateSite).
// The editor writes `draft`; visitors only ever see `published`.
// ---------------------------------------------------------------

// Content blocks a community can add. `header` and `footer` are edited
// separately (they are structural, not part of the block list).
// The editable Recruitment starter page is a normal custom page; the
// Applications block is the piece that lists external vacancies on it.
export const BLOCK_TYPES = [
  'hero',         // big banner: heading, subheading, logo, buttons
  'text',         // heading + paragraph, optional image
  'features',     // grid of { title, text }
  'stats',        // grid of { label, value }
  'gallery',      // grid of images
  'faq',          // accordion of { q, a }
  'cta',          // call to action with one button
  'socials',      // list of { platform, label, href }
  'applications', // public recruitment vacancies + application form
]

// Types that cannot be deleted from a page.
export const LOCKED_TYPES = []

export const LOGO_STYLES = ['icon_text', 'logo_text', 'logo', 'icon', 'text']

export const MAX_BLOCKS = 60
export const MAX_PAGES = 20

// Addresses the fixed routes and infrastructure already own.
// 'application' is the public application page (/application/<reference>).
const RESERVED_PAGE_SLUGS = ['home', 'editor', 'api', 'uploads', 'www', 'application']

const isHex = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)

// No HTML anywhere — everything is rendered as text.
const stripTags = (s) => String(s).replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

function str(v, max = 400) {
  if (v == null) return null
  const out = stripTags(v).slice(0, max).trim()
  return out || null
}

// Deep-clean any JSON value: bounded, tag-free, plain data only.
function clean(value, depth = 0) {
  if (value == null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return str(value, 4000)
  if (Array.isArray(value)) {
    if (depth >= 4) return null
    return value.slice(0, 60).map((v) => clean(v, depth + 1)).filter((v) => v !== null)
  }
  if (typeof value === 'object') {
    if (depth >= 4) return null
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(k)) continue
      const cleaned = clean(v, depth + 1)
      if (cleaned !== null && cleaned !== undefined) out[k] = cleaned
    }
    return out
  }
  return null
}

// Header/footer links. A link is either an external URL or a link to one of
// the site's own pages ({{ label, kind: 'page', page }}).
function links(list, max = 10) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const raw of list.slice(0, max)) {
    const label = str(raw?.label, 60)
    if (!label) continue
    if (raw?.kind === 'page') {
      const page = normalisePageSlug(raw?.page)
      if (!page) continue
      out.push({ label, kind: 'page', page })
    } else {
      const href = str(raw?.href, 400)
      if (!href) continue
      out.push({ label, kind: 'url', href })
    }
  }
  return out
}

// A page's address in the URL: lowercase words joined by hyphens.
function normalisePageSlug(value) {
  return (
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63) || null
  )
}

// Validate + normalise a page's block list (shared by the home page and any
// custom page).
function cleanBlocks(input) {
  const blocks = []
  const seen = new Set()
  const list = Array.isArray(input) ? input.slice(0, MAX_BLOCKS) : []

  for (const raw of list) {
    const type = String(raw?.type || '')
    if (!BLOCK_TYPES.includes(type)) continue

    let id = String(raw?.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)
    if (!id || seen.has(id)) id = `${type}-${blocks.length + 1}`
    seen.add(id)

    blocks.push({ id, type, props: clean(raw?.props) || {} })
  }

  // Locked blocks can never be removed.
  for (const type of LOCKED_TYPES) {
    if (!blocks.some((b) => b.type === type)) blocks.push({ id: type, type, props: {} })
  }

  return blocks
}

// Custom pages, each with a unique, non-reserved address.
function pages(input) {
  const out = []
  const seen = new Set(['home'])
  for (const raw of (Array.isArray(input) ? input : []).slice(0, MAX_PAGES)) {
    const slug = normalisePageSlug(raw?.slug)
    if (!slug || seen.has(slug) || RESERVED_PAGE_SLUGS.includes(slug)) continue
    seen.add(slug)
    out.push({
      slug,
      title: str(raw?.title, 60) || slug,
      blocks: cleanBlocks(raw?.blocks),
    })
  }
  return out
}

// The starter "Recruitment" page every community gets next to its home page.
// It is an ordinary custom page: renamable, editable and deletable. Its call to
// action hands off to the central application form, which knows which
// community the applicant is joining.
function recruitmentPage(community) {
  const name = community?.name || 'Our community'
  const slug = community?.slug
  const applyUrl = slug
    ? `https://roms.kgmcloud.co.uk/register?community=${encodeURIComponent(slug)}`
    : 'https://roms.kgmcloud.co.uk/register'

  return {
    slug: 'recruitment',
    title: 'Recruitment',
    blocks: [
      {
        id: 'recruitment-hero',
        type: 'hero',
        props: {
          variant: 'centred',
          showLogo: true,
          heading: 'Recruitment',
          subheading: `${name} is recruiting. Applications are open to anyone who wants to join.`,
          textAlign: 'center',
          buttons: [{ label: 'Apply to join', href: applyUrl, style: 'solid' }],
        },
      },
      {
        id: 'recruitment-steps',
        type: 'features',
        props: {
          variant: 'cards',
          heading: 'How to apply',
          items: [
            { title: 'Create your ROMS account', text: 'Sign up with your email address and verify it.' },
            { title: 'Send your application', text: 'Tell us a little about yourself and why you want to join.' },
            { title: 'Wait to hear back', text: 'Our staff review every application and will be in touch.' },
          ],
        },
      },
      {
        // The live vacancy board: filtered by service, three cards to a row.
        id: 'recruitment-applications',
        type: 'applications',
        props: {
          heading: 'Open vacancies',
          body: 'Browse the roles we are recruiting for and apply online.',
          showFilters: true,
          columns: '3',
        },
      },
    ],
  }
}

// A brand-new community's page. Looks like the ROMS placeholder site,
// but already carries the community's name and tagline. It has two pages:
// Home (the fixed layout) and Recruitment (an editable starter page).
export function defaultSite(community) {
  const name = community?.name || 'Our community'
  const tagline = community?.tagline || 'A Roblox roleplay community on ROMS.'

  return {
    version: 2,
    header: {
      logoStyle: 'icon_text',
      logoUrl: null, // navbar logo; null = use the community logo
      navColor: null, // null = follow the community accent colour
      links: [
        { label: 'Home', kind: 'url', href: '/' },
        { label: 'Recruitment', kind: 'page', page: 'recruitment' },
      ],
    },
    blocks: [
      {
        id: 'hero',
        type: 'hero',
        props: {
          variant: 'centred',
          showLogo: true,
          heading: name,
          subheading: tagline,
          textAlign: 'center',
          buttons: [
            { label: 'Recruitment', href: '/recruitment', style: 'solid' },
            { label: 'Login', href: 'https://roms.kgmcloud.co.uk', style: 'soft' },
          ],
        },
      },
      {
        id: 'about',
        type: 'text',
        props: {
          variant: 'plain',
          heading: 'About us',
          body: `Welcome to ${name}. This is your community's home on the web — tell people who you are, what you do and how to join.`,
          align: 'left',
        },
      },
      {
        id: 'features',
        type: 'features',
        props: {
          variant: 'cards',
          heading: 'What we offer',
          items: [
            { title: 'Active community', text: 'Members online most evenings.' },
            { title: 'Ranks & departments', text: 'A clear chain of command and room to progress.' },
            { title: 'Regular events', text: 'Weekly sessions and one-off specials.' },
          ],
        },
      },
    ],
    pages: [recruitmentPage(community)],
    footer: {
      text: `© ${name}. Powered by KGM Cloud ROMS.`,
      links: [],
    },
  }
}

// Bring an older saved site forward. v1 had the recruitment page baked into
// the application as a fixed route; v2 stores it as a normal custom page so
// communities can edit it. Safe to call repeatedly — it only ever adds the
// page once, and never after a community has deleted it (those documents are
// already marked v2).
export function migrateSite(site, community) {
  const src = site && typeof site === 'object' ? site : {}
  if ((Number(src.version) || 1) >= 2) return src

  const pages = Array.isArray(src.pages) ? [...src.pages] : []
  if (!pages.some((p) => normalisePageSlug(p?.slug) === 'recruitment')) {
    pages.push(recruitmentPage(community))
  }
  return { ...src, version: 2, pages }
}

// Validate + normalise anything the editor sends before it is stored.
// `community` is optional but lets us bring an old document forward first.
export function sanitiseSite(input, community) {
  const base = input && typeof input === 'object' ? input : {}
  const src = base.header || base.blocks || base.pages || base.footer ? migrateSite(base, community) : base

  const header = {
    logoStyle: LOGO_STYLES.includes(src.header?.logoStyle) ? src.header.logoStyle : 'icon_text',
    logoUrl: str(src.header?.logoUrl, 800),
    navColor: isHex(src.header?.navColor) ? src.header.navColor : null,
    links: links(src.header?.links),
  }

  return {
    version: 2,
    header,
    blocks: cleanBlocks(src.blocks),
    pages: pages(src.pages),
    footer: {
      text: str(src.footer?.text, 400),
      links: links(src.footer?.links),
    },
  }
}

// mysql2 can hand back JSON columns parsed or as a string.
export function parseSite(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}
