import React from 'react'
import ReactDOM from 'react-dom/client'
import { setHost } from '@renderer/lib/platform'
import { androidHost } from '@renderer/lib/platformAndroid'
import { installStickiShim } from './stickiShim'
import MobileApp from './MobileApp'
import { useLayoutStore } from '@renderer/store/layout'
import { useChatStore } from '@renderer/store/chat'
import { useSettingsStore } from '@renderer/store/settings'
import { useAccountsStore } from '@renderer/store/accounts'
import { useUiStore } from '@renderer/store/ui'
import '@renderer/styles/global.css'
import './mobile.css'

/**
 * The phone entry point.
 *
 * The host goes in before anything else runs: the config service reads it during boot, and a store
 * that loaded from the wrong place would then be written back to it.
 */
setHost(androidHost)
installStickiShim()

/**
 * Errors have nowhere to go on a phone — no diagnostics window, no log folder the user can open.
 * They go to the console, which `adb logcat` and Chrome's remote inspector both show, and that is
 * the whole story for now: a crash reporter is a decision about sending data off the device, and
 * that is not one to make quietly.
 */
/*
 * Capacitor's console bridge passes each argument to Android's log as a string, so an object
 * arrives in `adb logcat` as the useless "[object Object]" — which is exactly what the config
 * loader's first failure looked like. Stringifying here, before the bridge sees it, is what makes
 * the on-device log readable at all.
 */
for (const level of ['log', 'warn', 'error'] as const) {
  const original = console[level].bind(console)
  console[level] = (...args: unknown[]): void => {
    original(
      ...args.map((a) => {
        if (typeof a !== 'object' || a === null) return a
        if (a instanceof Error) return `${a.name}: ${a.message}
${a.stack ?? ''}`
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      })
    )
  }
}

window.addEventListener('error', (e) => {
  if (/ResizeObserver loop/i.test(e.message)) return
  console.error('[stickichat]', e.message, e.error?.stack ?? '')
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[stickichat] unhandled rejection:', e.reason)
})

/*
 * A phone has no devtools of its own. Chrome's remote inspector can attach over USB, but its
 * console can only reach what the page put somewhere reachable — a bundled module is not. In dev
 * these go on `window` so state can be read and poked from that console; the branch is dropped
 * from a production build entirely.
 */
if (import.meta.env.DEV) {
  Object.assign(window as unknown as Record<string, unknown>, {
    __sticki: {
      layout: useLayoutStore,
      chat: useChatStore,
      settings: useSettingsStore,
      accounts: useAccountsStore,
      ui: useUiStore
    }
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MobileApp />
  </React.StrictMode>
)
