import { getClips } from './helix'
import { useAccountsStore } from '../store/accounts'

/**
 * Inline previews for links posted in chat. Twitch clips get first-class treatment via
 * Helix Get Clips (real title + thumbnail); everything else falls back to the page's
 * OpenGraph tags fetched through the main process (no CORS there).
 */
export interface LinkPreviewData {
  kind: 'clip' | 'link' | 'image'
  title?: string
  description?: string
  image?: string
  siteName?: string
}

const URL_RE = /https?:\/\/[^\s<>"']+/i

export function extractFirstUrl(text: string): string | null {
  const m = URL_RE.exec(text)
  if (!m) return null
  // strip trailing punctuation the sentence glued onto the link
  return m[0].replace(/[),.!?:;'"]+$/, '')
}

export function clipSlugFromUrl(url: string): string | null {
  const m1 = /clips\.twitch\.tv\/([A-Za-z0-9_-]+)/.exec(url)
  if (m1) return m1[1]
  const m2 = /(?:www\.|m\.)?twitch\.tv\/[^/]+\/clip\/([A-Za-z0-9_-]+)/.exec(url)
  return m2 ? m2[1] : null
}

const cache = new Map<string, Promise<LinkPreviewData | null>>()

export function fetchLinkPreview(url: string): Promise<LinkPreviewData | null> {
  let p = cache.get(url)
  if (!p) {
    p = load(url).catch(() => null)
    cache.set(url, p)
    if (cache.size > 300) {
      const first = cache.keys().next().value
      if (first !== undefined) cache.delete(first)
    }
  }
  return p
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function metaTag(html: string, prop: string): string | undefined {
  // property/name may come before or after content within the tag
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i')
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i')
  const m = re1.exec(html) ?? re2.exec(html)
  return m?.[1] ? decodeEntities(m[1]).trim() || undefined : undefined
}

/** links posted by strangers must never make the app poke the local network */
function isFetchableHost(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const h = u.hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return false // raw IPv4/IPv6
  return h.includes('.')
}

async function load(url: string): Promise<LinkPreviewData | null> {
  if (!isFetchableHost(url)) return null

  const slug = clipSlugFromUrl(url)
  if (slug) {
    const account = useAccountsStore.getState().accounts.find((a) => a._accessToken)
    if (account) {
      const c = (await getClips(account, [slug]))[0]
      if (c) {
        return {
          kind: 'clip',
          title: c.title,
          image: c.thumbnail_url,
          siteName: 'Twitch Clip',
          description: `${c.broadcaster_name}${c.view_count ? ` · 👁 ${c.view_count}` : ''}`
        }
      }
    }
    // Helix came up empty (deleted clip / no account) — try the page's OG tags below
  }

  if (/\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i.test(url)) return { kind: 'image', image: url }

  const res = await window.sticki.fetchJson(url, { headers: { Accept: 'text/html' } })
  if (!res.ok || typeof res.text !== 'string') return null
  const html = res.text.slice(0, 400_000)
  if (!/<meta|<title/i.test(html)) return null

  const rawTitle = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]
  const title = metaTag(html, 'og:title') ?? metaTag(html, 'twitter:title') ?? (rawTitle ? decodeEntities(rawTitle).trim() : undefined)
  let image = metaTag(html, 'og:image') ?? metaTag(html, 'twitter:image')
  if (image) {
    try {
      image = new URL(image, url).href
    } catch {
      image = undefined
    }
  }
  const description = metaTag(html, 'og:description') ?? metaTag(html, 'twitter:description') ?? metaTag(html, 'description')
  let siteName = metaTag(html, 'og:site_name')
  if (!siteName) {
    try {
      siteName = new URL(url).hostname.replace(/^www\./, '')
    } catch {
      /* keep undefined */
    }
  }
  if (!title && !image) return null
  return { kind: 'link', title, description, image, siteName }
}
