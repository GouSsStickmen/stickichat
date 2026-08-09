import { app, protocol, net } from 'electron'
import { join, extname } from 'path'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, statSync } from 'fs'
import { pathToFileURL } from 'url'

/**
 * Binary settings live as FILES, not as base64 inside the config.
 *
 * Overlay backgrounds, uploaded sounds, replacement badges and uploaded fonts all arrive from a
 * `FileReader` as `data:` URLs, and each was stored verbatim in the settings object. That object
 * is read, serialised and written whole on every settings, layout or account change. On a real
 * profile it had reached 24.77 MB — `chatOverlays` alone 19.4 MB — and one save cost 219 ms to
 * read back, 112 ms to stringify, and a write of all of it, broadcast to every window. That is
 * where the app's periodic freezes came from: not from any one feature, but from carrying every
 * picture and sound through every unrelated save.
 *
 * A file is written once and referenced by its content hash. The config keeps a short URL, so
 * saving a setting moves bytes proportional to the setting, not to everything ever uploaded.
 *
 * The reference is a real URL — `sticki-asset://<hash>.<ext>` — deliberately, so nothing in the
 * renderer has to know this happened: `<img src>`, `background-image: url(...)`, `new Audio(...)`
 * and `@font-face` all resolve it through the protocol handler registered below. The one place
 * that cannot use it is the overlay page, which OBS loads over plain HTTP from another origin;
 * the overlay server rewrites these to its own `/asset/` route.
 */

export const ASSET_SCHEME = 'sticki-asset'

/** below this, inlining is cheaper than a file and a request */
const MIN_EXTERNALISE = 4096

function assetsDir(): string {
  const dir = join(app.getPath('userData'), 'assets')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/webm': '.weba',
  'font/woff2': '.woff2',
  'font/woff': '.woff',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
  'application/octet-stream': '.bin'
}

/** `data:<mime>;base64,<payload>` → a file on disk, named by content so duplicates collapse */
function externalise(dataUrl: string): string | null {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  const head = dataUrl.slice(5, comma)
  if (!head.includes('base64')) return null // only binary payloads are worth a file
  const mime = head.split(';')[0] || 'application/octet-stream'
  let buf: Buffer
  try {
    buf = Buffer.from(dataUrl.slice(comma + 1), 'base64')
  } catch {
    return null
  }
  if (!buf.length) return null
  const hash = createHash('sha1').update(buf).digest('hex').slice(0, 20)
  const name = `${hash}${MIME_EXT[mime] ?? '.bin'}`
  const file = join(assetsDir(), name)
  if (!existsSync(file)) {
    try {
      writeFileSync(file, buf)
    } catch {
      return null // out of disk or permissions: keep the data URL rather than lose the picture
    }
  }
  return `${ASSET_SCHEME}://${name}`
}

/**
 * Replace every large `data:` URL anywhere in `value` with an asset reference.
 *
 * Deliberately structural rather than field-by-field: the payloads are scattered across overlay
 * profiles, badge replacement maps, per-user badges, sounds and fonts, and new ones get added
 * whenever a feature grows an upload button. Walking the tree means none of them can be missed
 * and no call site has to be taught anything.
 */
export function externaliseAssets(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length >= MIN_EXTERNALISE && value.startsWith('data:')) {
      return externalise(value) ?? value
    }
    return value
  }
  if (Array.isArray(value)) return value.map(externaliseAssets)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = externaliseAssets(v)
    }
    return out
  }
  return value
}

/** every asset id still referenced anywhere in the config */
function referenced(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    if (value.startsWith(`${ASSET_SCHEME}://`)) into.add(value.slice(ASSET_SCHEME.length + 3))
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) referenced(v, into)
    return
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) referenced(v, into)
  }
}

/**
 * Delete asset files nothing points at any more.
 *
 * Only files older than an hour are eligible: an asset written seconds ago may belong to a change
 * that has not reached the config yet, and deleting it would lose the upload the user just made.
 */
export function sweepAssets(config: unknown): void {
  try {
    const keep = new Set<string>()
    referenced(config, keep)
    const dir = assetsDir()
    const cutoff = Date.now() - 3600_000
    for (const name of readdirSync(dir)) {
      if (keep.has(name)) continue
      const file = join(dir, name)
      if (statSync(file).mtimeMs > cutoff) continue
      unlinkSync(file)
    }
  } catch {
    /* best-effort housekeeping — never worth failing a save over */
  }
}

/**
 * The reverse, for EXPORT only.
 *
 * A settings or overlay file shared with someone else has to carry the pictures and sounds, not
 * references into a directory on this machine. Everything stays externalised on disk; this is
 * purely what leaves the app.
 */
export function inlineAssets(value: unknown): unknown {
  if (typeof value === 'string') {
    if (!value.startsWith(`${ASSET_SCHEME}://`)) return value
    const file = assetFile(value)
    if (!file) return value
    try {
      return `data:${assetContentType(file)};base64,${readFileSync(file).toString('base64')}`
    } catch {
      return value
    }
  }
  if (Array.isArray(value)) return value.map(inlineAssets)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = inlineAssets(v)
    return out
  }
  return value
}

/** absolute path for an asset reference or bare id, or null if it escapes the directory */
export function assetFile(ref: string): string | null {
  const name = ref.startsWith(`${ASSET_SCHEME}://`) ? ref.slice(ASSET_SCHEME.length + 3) : ref
  // the id is a content hash plus an extension; anything else is not ours
  if (!/^[a-f0-9]{20}\.[a-z0-9]{2,5}$/i.test(name)) return null
  const file = join(assetsDir(), name)
  return existsSync(file) ? file : null
}

const CONTENT_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.weba': 'audio/webm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
}

export function assetContentType(file: string): string {
  return CONTENT_TYPE[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Must run before `app.whenReady`. Marking the scheme standard and secure is what lets it be used
 * from stylesheets and `@font-face`, not only from `<img src>`.
 */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, stream: true }
    }
  ])
}

export function serveAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, (request) => {
    const file = assetFile(new URL(request.url).host + new URL(request.url).pathname.replace(/\/$/, ''))
    if (!file) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
}
