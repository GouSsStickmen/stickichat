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

/**
 * Sites serve very different HTML to "a browser" than to a bare fetch: YouTube hands an
 * Electron UA a consent/JS shell with no OpenGraph tags at all, which is why almost nothing
 * except Twitch clips ever produced a card. Ask like a browser does.
 */
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'uk,en;q=0.9'
}

function youtubeId(u: URL): string | null {
  const h = u.hostname.replace(/^www\.|^m\./, '').toLowerCase()
  if (h === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null
  if (h !== 'youtube.com' && h !== 'music.youtube.com') return null
  const v = u.searchParams.get('v')
  if (v) return v
  const m = /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]+)/.exec(u.pathname)
  return m ? m[1] : null
}

/**
 * oEmbed is the reliable path for the big video/social hosts — a small JSON document with a
 * real title, author and thumbnail, served without consent walls or bot checks.
 */
async function oEmbedPreview(url: string): Promise<LinkPreviewData | null> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.hostname.replace(/^www\.|^m\./, '').toLowerCase()
  let endpoint: string | null = null
  if (youtubeId(u)) endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`
  else if (host === 'vimeo.com') endpoint = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`
  else if (host === 'soundcloud.com') endpoint = `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`
  else if (host === 'reddit.com') endpoint = `https://www.reddit.com/oembed?url=${encodeURIComponent(url)}`
  else if (host === 'tiktok.com') endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`
  if (!endpoint) return null

  const res = await window.sticki.fetchJson(endpoint, { headers: BROWSER_HEADERS })
  const j = res.json as { title?: string; author_name?: string; thumbnail_url?: string; provider_name?: string } | null
  if (!res.ok || !j || (!j.title && !j.thumbnail_url)) return null
  // YouTube's oEmbed thumbnail is the 480px "hqdefault"; maxres exists for most videos and
  // looks far better in the hover-zoom, so prefer it and let the <img> fall back on error
  let image = j.thumbnail_url
  const yid = youtubeId(u)
  if (yid) image = `https://i.ytimg.com/vi/${yid}/maxresdefault.jpg`
  return {
    kind: 'link',
    title: j.title,
    description: j.author_name,
    image,
    siteName: j.provider_name ?? host
  }
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

  const viaOEmbed = await oEmbedPreview(url).catch(() => null)
  if (viaOEmbed) return viaOEmbed

  const res = await window.sticki.fetchJson(url, { headers: BROWSER_HEADERS })
  // image hosts like kappa.lol serve the picture straight off an extension-less URL, so the
  // path tells us nothing — the Content-Type does
  if (/^image\//i.test(res.contentType ?? '')) return { kind: 'image', image: url }
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
