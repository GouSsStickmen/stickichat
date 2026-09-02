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
  const preview = imgs.fixed_width_small ?? imgs.fixed_width ?? imgs.original
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

async function call(path: string, params: Record<string, string>, key: string): Promise<GifItem[]> {
  if (!key) return []
  const qs = new URLSearchParams({ ...params, api_key: key }).toString()
  const res = await host().request(`${API}/${path}?${qs}`, { method: 'GET' })
  if (!res.ok) throw new Error(`GIPHY ${res.status}`)
  const data = (res.json as { data?: GiphyGif[] } | undefined)?.data
  if (!Array.isArray(data)) return []
  return data.map(toItem).filter((g): g is GifItem => g !== null)
}

/** what the tab shows before anything is typed */
export function trendingGifs(key: string, rating: string, limit = 50): Promise<GifItem[]> {
  return call('trending', { limit: String(limit), rating, bundle: 'messaging_non_clips' }, key)
}

/** search by name — the other half of the keyboard */
export function searchGifs(key: string, query: string, rating: string, limit = 50): Promise<GifItem[]> {
  return call('search', { q: query, limit: String(limit), rating, bundle: 'messaging_non_clips' }, key)
}
