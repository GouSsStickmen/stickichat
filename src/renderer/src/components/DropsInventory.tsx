import { useEffect, useRef } from 'react'
import { useUiStore } from '../store/ui'

/**
 * What this account already owns, read from Twitch's own drops inventory.
 *
 * The channel page is only half the story: it says what is on offer and how far along it is, and
 * the moment a drop is actually earned their chest disappears from the chat bar and takes every
 * word about it with it. The inventory is the other half, and the only place that names what
 * arrived and when ("Onimusha Armament, 3 хвилини тому").
 *
 * It is a page of its own, so it gets a view of its own: hidden, in the same session as the
 * player, loaded only while the drops panel is open, read once, and then left alone. Nothing is
 * pressed in it.
 */
export default function DropsInventory(): React.JSX.Element {
  const wvRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const wv = wvRef.current as unknown as {
      addEventListener?: (t: string, f: () => void) => void
      removeEventListener?: (t: string, f: () => void) => void
      executeJavaScript?: (code: string) => Promise<unknown>
    } | null
    if (!wv?.addEventListener) return
    let stop = false
    let timer = 0
    /*
     * Their cards are read by shape, as everything else here is: under the "Отримано" heading each
     * reward is a picture with three words beside it, when it arrived, how many, and its name.
     */
    const read = `(() => {
      const text = (e) => (e.textContent || '').trim()
      const head = [...document.querySelectorAll('h1,h2,h3,h4,h5,p,span,div')].find(
        (e) => e.children.length === 0 && /^(Отримано|Claimed)$/i.test(text(e))
      )
      if (!head) return null
      let box = head
      for (let i = 0; i < 8 && box.parentElement; i++) {
        box = box.parentElement
        if (box.querySelectorAll('img').length >= 2) break
      }
      const out = []
      for (const img of [...box.querySelectorAll('img')].slice(0, 24)) {
        let card = img
        for (let i = 0; i < 6 && card.parentElement; i++) {
          card = card.parentElement
          const some = [...card.querySelectorAll('*')].filter((e) => e.children.length === 0 && text(e))
          if (some.length >= 2) break
        }
        const words = [...card.querySelectorAll('*')]
          .filter((e) => e.children.length === 0 && text(e))
          .map((e) => text(e))
        if (words.length < 2) continue
        out.push({ when: words[0], name: words[words.length - 1], icon: img.src || null })
      }
      return out
    })()`
    const ask = (): void => {
      if (stop) return
      try {
        void wv
          .executeJavaScript?.(read)
          ?.then((raw) => {
            if (stop) return
            const rows = Array.isArray(raw) ? (raw as { name: string; when: string; icon: string | null }[]) : null
            // their page builds the list a beat after it is ready; ask again until it is there
            if (!rows?.length) {
              timer = window.setTimeout(ask, 1500)
              return
            }
            useUiStore.getState().setDropsOwned(rows.filter((r) => r.name))
          })
          ?.catch?.(() => {
            timer = window.setTimeout(ask, 2000)
          })
      } catch {
        timer = window.setTimeout(ask, 2000)
      }
    }
    wv.addEventListener('dom-ready', ask)
    return () => {
      stop = true
      window.clearTimeout(timer)
      wv.removeEventListener?.('dom-ready', ask)
    }
  }, [])

  return (
    <webview
      ref={(node) => {
        wvRef.current = node as unknown as HTMLElement
      }}
      src="https://www.twitch.tv/drops/inventory"
      // the player's own session, or the page would come back signed out and empty
      partition="persist:twitch-player"
      className="drops-inventory-view"
    />
  )
}
