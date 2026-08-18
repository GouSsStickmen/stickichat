import { CapacitorHttp } from '@capacitor/core'
import { Clipboard } from '@capacitor/clipboard'
import { Browser } from '@capacitor/browser'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import type { HostRequest, HostResponse, PlatformHost } from './platform'
import { registerPlugin } from '@capacitor/core'

/**
 * The native side of "open this in a browser, not in the app that owns the link".
 * See BrowserOnlyPlugin.java for why a Custom Tab cannot do this.
 */
const BrowserOnly = registerPlugin<{
  open(options: { url: string }): Promise<{ package: string }>
  openLinkSettings(options: { package: string }): Promise<void>
}>('BrowserOnly')

/**
 * The same five things, from Android instead of Electron.
 *
 * Every one of them is native rather than web on purpose:
 *
 * - the request goes through CapacitorHttp because a WebView page is an origin like any other, and
 *   7TV, BTTV, FFZ and the unfurler do not answer cross-origin requests;
 * - the config is a file in app-private storage rather than localStorage, because it carries
 *   uploaded fonts and sounds as data URLs and outgrows any key-value quota;
 * - tokens are encrypted before they touch that file, so a device backup does not carry them in
 *   the clear.
 */

const CONFIG_FILE = 'stickichat/config.json'
const KEY_FILE = 'stickichat/.key'

/** app-private storage: not the SD card, not visible to other apps, wiped with the app */
const DIR = Directory.Data

async function readPrivate(path: string): Promise<string | null> {
  try {
    const r = await Filesystem.readFile({ path, directory: DIR, encoding: Encoding.UTF8 })
    return typeof r.data === 'string' ? r.data : null
  } catch {
    return null // no file yet is the normal first-run case, not an error
  }
}

async function writePrivate(path: string, data: string): Promise<void> {
  await Filesystem.writeFile({ path, directory: DIR, data, encoding: Encoding.UTF8, recursive: true })
}

/* ─────────────────────────── tokens at rest ───────────────────────────
 *
 * AES-GCM with a key generated once and kept beside the config, in storage only this app can read.
 * That is weaker than Electron's safeStorage, which hands the key to the OS keychain — the same
 * guarantee needs a small native plugin over EncryptedSharedPreferences, and until that exists
 * this at least keeps the tokens out of the config file and out of a plain backup of it.
 */
let keyPromise: Promise<CryptoKey> | null = null

function loadKey(): Promise<CryptoKey> {
  keyPromise ??= (async () => {
    const saved = await readPrivate(KEY_FILE)
    if (saved) {
      const raw = Uint8Array.from(atob(saved), (c) => c.charCodeAt(0))
      return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
    }
    const raw = crypto.getRandomValues(new Uint8Array(32))
    await writePrivate(KEY_FILE, btoa(String.fromCharCode(...raw)))
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
  })()
  return keyPromise
}

async function encryptToken(plain: string): Promise<string> {
  const key = await loadKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain))
  const out = new Uint8Array(iv.length + buf.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(buf), iv.length)
  return btoa(String.fromCharCode(...out))
}

async function decryptToken(cipher: string): Promise<string | null> {
  try {
    const key = await loadKey()
    const all = Uint8Array.from(atob(cipher), (c) => c.charCodeAt(0))
    const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, key, all.slice(12))
    return new TextDecoder().decode(buf)
  } catch {
    // a key that no longer matches means the token is unusable; saying so sends the user through
    // the login again, which is the only honest outcome
    return null
  }
}

/* ─────────────────────────── config changes ───────────────────────────
 *
 * One window, so nobody else needs telling — but the listeners still fire, because a settings
 * screen and the chat behind it are two React trees in this app and both read the same blob.
 */
const listeners = new Set<() => void>()

export const androidHost: PlatformHost = {
  kind: 'android',

  async request(url: string, init?: HostRequest): Promise<HostResponse> {
    const res = await CapacitorHttp.request({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers,
      data: init?.body,
      // the app parses its own bodies: Helix errors, 7TV GraphQL and the unfurler's HTML all need
      // the raw text, and letting the bridge guess turns an HTML page into a useless object
      responseType: 'text'
    })
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? null)
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null // an HTML answer is not a failure; the unfurler wants the text
    }
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = String(v)
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json,
      text,
      contentType: headers['content-type'],
      headers
    }
  },

  async readConfig() {
    const raw = await readPrivate(CONFIG_FILE)
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null // a truncated write is recoverable by starting over, not by crashing on boot
    }
  },

  async writeConfig(blob: unknown) {
    await writePrivate(CONFIG_FILE, JSON.stringify(blob))
  },

  async configChanged() {
    for (const cb of listeners) {
      try {
        cb()
      } catch {
        /* one bad listener must not stop the rest */
      }
    }
  },

  onConfigChanged(cb: () => void) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },

  encrypt: encryptToken,
  decrypt: decryptToken,

  async copyText(text: string) {
    await Clipboard.write({ string: text })
  },

  async openAppLinkSettings(packageName: string) {
    await BrowserOnly.openLinkSettings({ package: packageName })
  },

  async openUrl(url: string) {
    /*
     * The activation page has to open in a browser, explicitly.
     *
     * Twitch owns twitch.tv as a verified Android App Link, so a Custom Tab hands the URL to the
     * installed Twitch app — which opens on a black screen and never shows the activation form.
     * That leaves the device-code login with no way to finish, and neither an `intent:` URL nor a
     * hardcoded browser package fixes it — the WebView does not parse the former, and this device
     * has no Chrome at all. A native call that resolves the installed browsers and names one
     * explicitly is the only thing that gets past a verified app link.
     *
     * Only this one page is treated that way. For an ordinary link — a clip, a stream, a VOD —
     * landing in the Twitch app is the better outcome, so those keep the normal Custom Tab.
     */
    if (/twitch\.tv\/activate/i.test(url)) {
      try {
        const { package: opened } = await BrowserOnly.open({ url })
        console.log('[stickichat] activation page opened in', opened)
        return
      } catch (e) {
        console.warn('[stickichat] browser-only open failed, falling back to a custom tab', e)
      }
    }
    await Browser.open({ url })
  }
}
