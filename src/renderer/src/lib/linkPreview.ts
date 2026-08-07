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
 * Ask as what we are: a link unfurler.
 *
 * Pretending to be Chrome was making this WORSE, and measurably so. A site that thinks it is
 * talking to a browser serves the interactive app — a JavaScript shell with no OpenGraph tags
 * at all, or a generic site-wide title. The same URL asked by an unfurler gets the static
 * summary the tags exist for:
 *
 *   open.spotify.com/track/…   browser: no og:title      unfurler: "Never Gonna Give You Up"
 *   instagram.com/twitch/      browser: no og:title      unfurler: "Twitch • Instagram profile"
 *   twitch.tv/<channel>        browser: "Twitch"         unfurler: "GouS_Stickmen - Twitch"
 *
 * That last one is the whole "sometimes the title is wrong" report in one line. And an honest
 * name works exactly as well as impersonating someone else's crawler — measured against
 * Discordbot on all of the above, identical results — so there is no reason to lie about it.
 */
const UNFURL_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (compatible; StickiChatBot/1.0; +https://github.com/GouSsStickmen/stickichat)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'uk,en;q=0.9'
}

/** a few sites do the opposite and only talk to browsers — second attempt, not the first */
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
  // Spotify's own oEmbed answers with the track/album/playlist name and its cover art, which
  // is both cleaner and more reliable than scraping the page for it
  else if (host === 'open.spotify.com' || host === 'spotify.com')
    endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`
  // Sites that answer a crawler with an app shell and nothing else. Pinterest is the one that
  // got reported: the page is JavaScript all the way down, so scraping it finds no tags at
  // all, while its oEmbed hands over the pin's title and its picture without argument.
  else if (host === 'pinterest.com' || host === 'pin.it' || /(^|\.)pinterest\./.test(host))
    endpoint = `https://www.pinterest.com/oembed.json?url=${encodeURIComponent(url)}`
  else if (host === 'imgur.com') endpoint = `https://api.imgur.com/oembed.json?url=${encodeURIComponent(url)}`
  else if (host === 'dailymotion.com' || host === 'dai.ly')
    endpoint = `https://www.dailymotion.com/services/oembed?format=json&url=${encodeURIComponent(url)}`
  else if (host === 'streamable.com')
    endpoint = `https://api.streamable.com/oembed.json?url=${encodeURIComponent(url)}`
  else if (host === 'flickr.com' || host === 'flic.kr')
    endpoint = `https://www.flickr.com/services/oembed?format=json&url=${encodeURIComponent(url)}`
  else if (host === 'bsky.app')
    endpoint = `https://embed.bsky.app/oembed?format=json&url=${encodeURIComponent(url)}`
  if (!endpoint) return null

  const res = await window.sticki.fetchJson(endpoint, { headers: UNFURL_HEADERS })
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

  // Ask as an unfurler first. If that gets a real summary we are done; if all it got was the
  // page's site-wide <title> we ask again as a browser, because a few sites do it the other
  // way round. Whatever weak answer we did get is kept as the fallback — a plain <title> is
  // still better than no card for the many small pages that have no OpenGraph tags at all.
  const first = await fetchCard(url, UNFURL_HEADERS).catch(() => null)
  if (first?.strong) return first.data
  const second = await fetchCard(url, BROWSER_HEADERS).catch(() => null)
  if (second?.strong) return second.data
  return first?.data ?? second?.data ?? bareCard(url)
}

/**
 * What is left when a site tells us nothing at all.
 *
 * Plenty of pages have no OpenGraph tags, refuse anything that is not a signed-in browser, or
 * are a JavaScript shell with an empty <head>. Returning null for those meant the link sat in
 * the message with no preview and no explanation, indistinguishable from the feature being
 * broken. The host and the last path segment are not much, but they are true, they are free,
 * and they mean every link behaves the same way.
 */
function bareCard(url: string): LinkPreviewData | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.hostname.replace(/^www\./, '')
  let tail = ''
  try {
    tail = decodeURIComponent(u.pathname).split('/').filter(Boolean).pop() ?? ''
  } catch {
    tail = u.pathname.split('/').filter(Boolean).pop() ?? ''
  }
  // "/pin/1234-some-thing/" reads better as "some thing" than as itself
  const title = tail.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[-_+]+/g, ' ').trim()
  return { kind: 'link', siteName: host, title: title || host }
}

/** `strong` = the page actually described this link (OpenGraph tags or a picture) */
async function fetchCard(
  url: string,
  headers: Record<string, string>
): Promise<{ data: LinkPreviewData; strong: boolean } | null> {
  const res = await window.sticki.fetchJson(url, { headers })
  // image hosts like kappa.lol serve the picture straight off an extension-less URL, so the
  // path tells us nothing — the Content-Type does
  if (/^image\//i.test(res.contentType ?? '')) return { data: { kind: 'image', image: url }, strong: true }
  if (!res.ok || typeof res.text !== 'string') return null
  const html = res.text.slice(0, 400_000)
  if (!/<meta|<title/i.test(html)) return null

  const rawTitle = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]
  const ogTitle = metaTag(html, 'og:title') ?? metaTag(html, 'twitter:title')
  const title = ogTitle ?? (rawTitle ? decodeEntities(rawTitle).trim() : undefined)
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
  // Weak means all we got was the site-wide <title> — "Spotify – Web Player", "Twitch" — with
  // nothing that describes THIS link. Worth keeping as a last resort, not worth stopping at.
  return { data: { kind: 'link', title, description, image, siteName }, strong: !!(ogTitle || image) }
}
