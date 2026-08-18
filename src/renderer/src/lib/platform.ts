/**
 * What the app needs from whatever is hosting it.
 *
 * The renderer is 34k lines of chat that care about none of this: they want a request that is not
 * blocked by CORS, a place to keep the config, a safe place to keep tokens, the clipboard, and a
 * way to open a link. On the desktop all five arrive over Electron IPC. On Android the same five
 * come from Capacitor. Everything else `window.sticki` offers — overlays, extra windows,
 * always-on-top, the eyedropper, the updater, the diagnostics log — is desktop furniture that no
 * phone build ships, and those call sites keep talking to `window.sticki` directly so it stays
 * obvious which parts of the app are desktop-only.
 *
 * This exists so a second host is a file, not a rewrite: `setHost()` before the first render and
 * nothing above this line knows the difference.
 */

export interface HostResponse {
  ok: boolean
  status: number
  json: unknown
  text: string
  /**
   * The response's own Content-Type.
   *
   * Not a nicety: an image host can serve a picture off an extension-less URL, so the path says
   * nothing and this is the only thing that tells a link preview it is looking at an image.
   */
  contentType?: string
  /** response headers, lower-cased — the rate-limit ones are what callers read */
  headers?: Record<string, string>
}

export interface HostRequest {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface PlatformHost {
  /** the platform this build runs on; branch on it only for real behavioural differences */
  readonly kind: 'desktop' | 'android'

  /**
   * An HTTP request that is not subject to the page's origin.
   *
   * Twitch's Helix would mostly work from a fetch, but 7TV, BTTV, FFZ and the link unfurler would
   * not, and the app treats them all the same way. Both hosts answer this from native code.
   */
  request(url: string, init?: HostRequest): Promise<HostResponse>

  /** the whole config blob, as last written; null when there is nothing saved yet */
  readConfig(): Promise<unknown>
  writeConfig(blob: unknown): Promise<void>
  /**
   * Tell other windows the config changed.
   *
   * A phone has one window, so this is a no-op there — but the call sites are the same, and a
   * settings screen that saves has no business knowing whether anybody else is listening.
   */
  configChanged(): Promise<void>
  onConfigChanged(cb: () => void): () => void

  /** tokens, at rest. Desktop: safeStorage. Android: the keystore behind EncryptedSharedPreferences */
  encrypt(plain: string): Promise<string>
  decrypt(cipher: string): Promise<string | null>

  copyText(text: string): Promise<void>
  openUrl(url: string): Promise<void>
}

/**
 * The Electron host, which is what the app has always used.
 *
 * Written as a plain object rather than a class because it holds nothing: every method is a
 * forward to the preload bridge.
 */
export const desktopHost: PlatformHost = {
  kind: 'desktop',
  request: (url, init) => window.sticki.fetchJson(url, init) as Promise<HostResponse>,
  readConfig: () => window.sticki.getConfig(),
  writeConfig: (blob) => window.sticki.setConfig(blob).then(() => undefined),
  configChanged: () => window.sticki.notifyConfigChanged(),
  onConfigChanged: (cb) => window.sticki.onConfigChanged(cb),
  encrypt: (plain) => window.sticki.encrypt(plain),
  decrypt: (cipher) => window.sticki.decrypt(cipher),
  copyText: (text) => window.sticki.copyText(text),
  openUrl: (url) => window.sticki.openExternal(url)
}

let current: PlatformHost = desktopHost

/** called once, before the first render, by whichever entry point is starting */
export function setHost(host: PlatformHost): void {
  current = host
}

export function host(): PlatformHost {
  return current
}

/** true on the phone build — for the handful of places where the shape of the UI really differs */
export function isMobile(): boolean {
  return current.kind === 'android'
}
