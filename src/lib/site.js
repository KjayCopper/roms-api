// ---------------------------------------------------------------
// Community website: block catalogue, default layout and validation.
//
// A site is one JSON document:
//
//   {
//     version: 1,
//     header:  { logoStyle, navColor, links: [{label, href}], cta: {label, href} },
//     blocks:  [{ id, type, props: {...} }],
//     footer:  { text, links: [{label, href}] }
//   }
//
// The editor writes `draft`; visitors only ever see `published`.
// ---------------------------------------------------------------

// Content blocks a community can add. `header` and `footer` are edited
// separately (they are structural, not part of the block list).
export const BLOCK_TYPES = [
  'hero',        // big banner: heading, subheading, logo, buttons
  'text',        // heading + paragraph, optional image
  'features',    // grid of { title, text }
  'stats',       // grid of { label, value }
  'gallery',     // grid of images
  'faq',         // accordion of { q, a }
  'cta',         // call to action with one button
  'socials',     // list of { label, href }
  'recruitment', // locked — always present, cannot be removed
]

// Types that cannot be deleted from a page.
export const LOCKED_TYPES = ['recruitment']

export const LOGO_STYLES = ['icon_text', 'logo_text', 'logo', 'icon', 'text']

export const MAX_BLOCKS = 60

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

function links(list, max = 8) {
  if (!Array.isArray(list)) return []
  return list
    .slice(0, max)
    .map((l) => ({ label: str(l?.label, 60), href: str(l?.href, 400) }))
    .filter((l) => l.label && l.href)
}

// A brand-new community's page. Looks like the ROMS placeholder site,
// but already carries the community's name and tagline.
export function defaultSite(community) {
  const name = community?.name || 'Our community'
  const tagline = community?.tagline || 'A Roblox roleplay community on ROMS.'

  return {
    version: 1,
    header: {
      logoStyle: 'icon_text',
      navColor: null, // null = follow the community accent colour
      links: [
        { label: 'Home', href: '/' },
        { label: 'Recruitment', href: '#recruitment' },
      ],
      ctaLabel: 'Login',
      ctaHref: 'https://roms.kgmcloud.co.uk',
    },
    blocks: [
      {
        id: 'hero',
        type: 'hero',
        props: {
          showLogo: true,
          heading: name,
          subheading: tagline,
          align: 'center',
          buttons: [
            { label: 'Recruitment', href: '#recruitment', style: 'solid' },
            { label: 'Login', href: 'https://roms.kgmcloud.co.uk', style: 'soft' },
          ],
        },
      },
      {
        id: 'about',
        type: 'text',
        props: {
          heading: 'About us',
          body: `Welcome to ${name}. This is your community's home on the web — tell people who you are, what you do and how to join.`,
          align: 'left',
          wide: false,
        },
      },
      {
        id: 'features',
        type: 'features',
        props: {
          heading: 'What we offer',
          items: [
            { title: 'Active community', text: 'Members online most evenings.' },
            { title: 'Ranks & departments', text: 'A clear chain of command and room to progress.' },
            { title: 'Regular events', text: 'Weekly sessions and one-off specials.' },
          ],
        },
      },
      {
        id: 'recruitment',
        type: 'recruitment',
        props: {
          heading: 'Recruitment',
          body: 'Applications are open. Create an account on ROMS and apply to join — staff review every application.',
          buttonLabel: 'Apply to join',
        },
      },
    ],
    footer: {
      text: `© ${name}. Powered by KGM Cloud ROMS.`,
      links: [],
    },
  }
}

// Validate + normalise anything the editor sends before it is stored.
export function sanitiseSite(input) {
  const src = input && typeof input === 'object' ? input : {}

  const header = {
    logoStyle: LOGO_STYLES.includes(src.header?.logoStyle) ? src.header.logoStyle : 'icon_text',
    navColor: isHex(src.header?.navColor) ? src.header.navColor : null,
    links: links(src.header?.links, 8),
    ctaLabel: str(src.header?.ctaLabel, 40),
    ctaHref: str(src.header?.ctaHref, 400),
  }
  if (!header.ctaLabel || !header.ctaHref) {
    header.ctaLabel = null
    header.ctaHref = null
  }

  const blocks = []
  const seen = new Set()
  const input_blocks = Array.isArray(src.blocks) ? src.blocks.slice(0, MAX_BLOCKS) : []

  for (const raw of input_blocks) {
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

  return {
    version: 1,
    header,
    blocks,
    footer: {
      text: str(src.footer?.text, 400),
      links: links(src.footer?.links, 8),
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
