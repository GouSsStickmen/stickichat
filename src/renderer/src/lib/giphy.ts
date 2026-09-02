/**
 * GIPHY, the catalogue behind Twitch's own GIF keyboard.
 *
 * Twitch does not proxy it: their picker calls api.giphy.com straight, with a key their server
 * hands the client. We cannot ask their server for that key — gql.twitch.tv only answers to
 * first-party sessions — so the key comes from settings and the tab stays empty until there is
 * one. Registering a free one takes a minute at developers.giphy.com, and it belongs to whoever
 * runs the app rather than being baked into a public repo.
 *
 * Everything goes through the platform host: a renderer fetch to api.giphy.com is a CORS error.
 */
import { host } from './platform'

const API = 'https://api.giphy.com/v1/gifs'

/*
 * Ratings we are willing to ask GIPHY for. Enforced here rather than only in the settings dropdown
 * because a rating travels from a config file that can be hand-edited or carried over from an
 * older build — the boundary that talks to GIPHY is the one that has to hold.
 */
const ALLOWED_RATINGS = new Set(['g', 'pg', 'pg-13'])
const safeRating = (rating: string): string => (ALLOWED_RATINGS.has(rating) ? rating : 'pg-13')

/** one GIF, reduced to the four things the picker and the sender actually need */
export interface GifItem {
  id: string
  title: string
  /** small looping still/animation for the grid — cheap enough to show a hundred of */
  previewUrl: string
  /** the full-size media URL, which is what Twitch's own messages carry */
  url: string
  /** grid geometry: the preview's natural size, so the columns can be justified */
  width: number
  height: number
}

/**
 * GIPHY's response, narrowed to what we read.
 *
 * `images` carries two dozen renditions; `fixed_width_small` is the one built for keyboards and
 * `original` is what the gifs tag in chat points at.
 */
interface GiphyRendition {
  url?: string
  width?: string
  height?: string
}
interface GiphyGif {
  id?: string
  title?: string
  images?: Record<string, GiphyRendition | undefined>
}

function toItem(g: GiphyGif): GifItem | null {
  const id = g.id
  const imgs = g.images ?? {}
  // fixed_width is 200px across — sharp at the widths the grid actually uses; the small one
  // is 100px and visibly upscaled the moment the picker is a window rather than a popover
  const preview = imgs.fixed_width ?? imgs.fixed_width_small ?? imgs.original
  const full = imgs.original ?? imgs.fixed_width
  if (!id || !preview?.url || !full?.url) return null
  return {
    id,
    title: g.title?.trim() || id,
    previewUrl: preview.url,
    url: full.url,
    width: Number(preview.width) || 100,
    height: Number(preview.height) || 100
  }
}

/*
 * A beta key is allowed 100 calls an hour, and that is the whole budget for one person: opening
 * the tab, every search, every time the picker is reopened. So an answer is kept for ten minutes
 * and identical requests in flight share one call — reopening the tab or retyping a search you
 * just ran costs nothing.
 */
const TTL_MS = 10 * 60 * 1000
const cache = new Map<string, { at: number; gifs: GifItem[] }>()
const inFlight = new Map<string, Promise<GifItem[]>>()

async function call(path: string, params: Record<string, string>, key: string): Promise<GifItem[]> {
  if (!key) return []
  const cacheKey = `${path}|${JSON.stringify(params)}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.gifs
  const running = inFlight.get(cacheKey)
  if (running) return running
  const run = (async (): Promise<GifItem[]> => {
    const qs = new URLSearchParams({ ...params, api_key: key }).toString()
    const res = await host().request(`${API}/${path}?${qs}`, { method: 'GET' })
    if (!res.ok) throw new Error(`GIPHY ${res.status}`)
    const data = (res.json as { data?: GiphyGif[] } | undefined)?.data
    const gifs = Array.isArray(data)
      ? data.map(toItem).filter((g): g is GifItem => g !== null)
      : []
    cache.set(cacheKey, { at: Date.now(), gifs })
    return gifs
  })()
  inFlight.set(cacheKey, run)
  try {
    return await run
  } finally {
    inFlight.delete(cacheKey)
  }
}

/** what the tab shows before anything is typed */
export function trendingGifs(key: string, rating: string, offset = 0, limit = 50): Promise<GifItem[]> {
  return call(
    'trending',
    { limit: String(limit), offset: String(offset), rating: safeRating(rating), bundle: 'messaging_non_clips' },
    key
  )
}

/** search by name — the other half of the keyboard */
export function searchGifs(
  key: string,
  query: string,
  rating: string,
  offset = 0,
  limit = 50
): Promise<GifItem[]> {
  return call(
    'search',
    {
      q: query,
      limit: String(limit),
      offset: String(offset),
      rating: safeRating(rating),
      bundle: 'messaging_non_clips'
    },
    key
  )
}
