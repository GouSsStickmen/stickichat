import { host } from '@renderer/lib/platform'

/**
 * A stand-in for the Electron preload bridge.
 *
 * The shared components were written against `window.sticki`, and most of what they ask it for is
 * desktop furniture: a second window for the emote picker, the OBS overlay server, a zoom level.
 * None of that exists in a WebView, and there is nothing to port — a phone has one window.
 *
 * Reaching for a missing method there is not a graceful degradation, though: it throws inside
 * render, React unwinds the whole tree, and the app goes blank. That is exactly what it did. So the
 * bridge is present on Android too, backed by the platform host where the call means something and
 * by a no-op where it does not — and it says once, in the log, which desktop-only call was made, so
 * the list of things a phone still needs an answer for stays visible instead of silently growing.
 */
export function installStickiShim(): void {
  const warned = new Set<string>()
  const noop = (): void => {}

  const real: Record<string, (...args: never[]) => unknown> = {
    copyText: (text: string) => host().copyText(text),
    openExternal: (url: string) => host().openUrl(url),
    // the desktop writes these to a file the diagnostics window reads; here the console is the log
    diagLog: (...args: unknown[]) => console.log('[diag]', ...args)
  } as unknown as Record<string, (...args: never[]) => unknown>

  const bridge = new Proxy(real, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      return (...args: unknown[]): unknown => {
        if (!warned.has(prop)) {
          warned.add(prop)
          console.warn('[stickichat] desktop-only bridge call ignored on Android:', prop)
        }
        /*
         * `onSomething(cb)` is a subscription and hands back its own unsubscribe, which callers
         * store and later call — so it has to be a function, not a promise. Everything else is
         * awaited at most.
         */
        return prop.startsWith('on') ? noop : Promise.resolve(undefined)
      }
    },
    has: () => true
  })

  ;(window as unknown as Record<string, unknown>).sticki = bridge
}
