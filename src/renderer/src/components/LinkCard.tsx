import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useUiStore } from '../store/ui'
import { useSettingsStore } from '../store/settings'
import { fetchLinkPreview, LinkPreviewData } from '../lib/linkPreview'
import { useT } from '../i18n'

/**
 * The link preview, drawn OVER the chat instead of inside it.
 *
 * The inline card was the cause of a whole family of scroll complaints, and not because the
 * compensation was wrong — because there was compensation at all. A card that lives in the
 * message list makes its row taller, which moves every row under it, which the list then has
 * to undo, in the right frame, in every combination of "following the end" and "reading
 * history". Nothing here has to be undone: the card is a fixed-position box anchored to where
 * the link is on screen, the message row never changes height, and the chat's geometry is
 * exactly what it was before the card opened.
 *
 * It also stops being one-per-message. Which link a card belongs to is now a property of the
 * card, not of the row, so a message with four links has four of them.
 */
export default function LinkCard(): React.JSX.Element | null {
  const t = useT()
  const target = useUiStore((s) => s.linkCard)
  const scale = useSettingsStore((s) => s.settings.linkPreviewScale)
  const hoverEnabled = useSettingsStore((s) => s.settings.linkHoverPreview)
  const hoverImagesOnly = useSettingsStore((s) => s.settings.linkHoverImagesOnly)
  const hoverSize = useSettingsStore((s) => s.settings.linkHoverSize)
  const [data, setData] = useState<LinkPreviewData | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })

  const url = target?.url ?? null
  useEffect(() => {
    let alive = true
    setData(null)
    if (!url) return
    fetchLinkPreview(url).then((d) => {
      if (alive) setData(d ?? null)
    })
    return () => {
      alive = false
    }
  }, [url])

  // The card is placed from its own size, which is not known until it has drawn — and the
  // artwork can change that size again when it decodes. Measuring beats guessing: a guess is
  // how a short card ends up floating a hundred pixels off the link it belongs to.
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      setBox({ w: r.width, h: r.height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [data, scale])

  // clicking anywhere else or Escape puts it away — a preview is a glance, not a panel to
  // manage. A hover-opened card also has to survive the pointer CROSSING the gap between the
  // link and itself, which is why leaving the link only asks, and the answer waits to see
  // whether the pointer turns up here.
  const closeTimer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!target) return
    const close = (): void => useUiStore.getState().setLinkCard(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current?.contains(e.target as Node)) return
      // a tag gets to decide for itself — this handler runs on mousedown, before the click
      // reaches it, so closing here would make every second click on the same tag re-open the
      // card instead of dismissing it
      if ((e.target as HTMLElement).closest?.('.link-preview-toggle')) return
      close()
    }
    const maybeClose = (): void => {
      if (target.sticky) return
      window.clearTimeout(closeTimer.current)
      closeTimer.current = window.setTimeout(close, 320)
    }
    // Scrolling the chat by hand takes the card's anchor with it, so the card would end up
    // pointing at a message that has moved on. It closes rather than drifts. Deliberately the
    // WHEEL and not the scroll event: at the bottom of a live chat the scroll position moves
    // by itself several times a second, and closing on that would make a card impossible to
    // read. This is the reader moving the chat, which is exactly when the card is stale.
    const onWheel = (): void => close()
    window.addEventListener('wheel', onWheel, { passive: true })
    // capture, so a click that lands on a message still closes the card first
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('sticki:closelinkcard', close)
    window.addEventListener('sticki:linkcardmaybeclose', maybeClose)
    return () => {
      window.clearTimeout(closeTimer.current)
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('sticki:closelinkcard', close)
      window.removeEventListener('sticki:linkcardmaybeclose', maybeClose)
    }
  }, [target])

  if (!target || !data) return null

  const GAP = 10
  /**
   * Never off the window, on either axis.
   *
   * The link can be at the bottom of the chat, at the right edge in split mode, or both. The
   * card opens below-right of it when there is room and flips to whichever side has room when
   * there is not; the clamp afterwards is what guarantees it, whatever the flip decided.
   */
  const w = box.w || 320
  const h = box.h || 120
  let top = target.y + GAP
  if (top + h > window.innerHeight - 8) top = target.y - GAP - h
  top = Math.max(8, Math.min(top, window.innerHeight - 8 - h))
  const left = Math.max(8, Math.min(target.x, window.innerWidth - 8 - w))

  const open = (): void => {
    window.sticki.openExternal(target.url)
    useUiStore.getState().setLinkCard(null)
  }
  // hovering the card blows the artwork up next to the cursor — a chat-sized thumbnail is too
  // small to actually see what was linked
  const hoverBig = (e: React.MouseEvent): void => {
    if (!data.image || !hoverEnabled) return
    if (hoverImagesOnly && data.kind !== 'image') return
    useUiStore.getState().setEmotePreview({
      url: data.image,
      code: data.title ?? data.siteName ?? target.url,
      x: e.clientX,
      y: e.clientY,
      wide: true,
      wideSize: hoverSize
    })
  }
  const hoverOff = (): void => useUiStore.getState().setEmotePreview(null)

  return (
    <div
      ref={boxRef}
      className="link-card"
      style={{
        left,
        top,
        visibility: box.h ? 'visible' : 'hidden',
        ...(scale !== 100 ? ({ zoom: scale / 100 } as React.CSSProperties) : {})
      }}
      // the pointer made it across: cancel the close the link asked for
      onMouseEnter={() => window.clearTimeout(closeTimer.current)}
      onMouseLeave={() => {
        if (!target.sticky) useUiStore.getState().setLinkCard(null)
      }}
    >
      {data.kind === 'image' ? (
        <img
          className="lc-image"
          src={data.image}
          alt=""
          title={target.url}
          onClick={open}
          onMouseMove={hoverBig}
          onMouseLeave={hoverOff}
        />
      ) : (
        <div className="lc-body" title={target.url} onClick={open}>
          {data.image && (
            <img
              className="lc-thumb"
              src={data.image}
              alt=""
              onMouseMove={hoverBig}
              onMouseLeave={hoverOff}
            />
          )}
          <div className="lc-text">
            {data.siteName && (
              <div className="lc-site">
                {data.kind === 'clip' ? '🎬 ' : ''}
                {data.siteName}
              </div>
            )}
            <div className="lc-title">{data.title ?? t('misc.linkShort')}</div>
            {data.description && <div className="lc-desc">{data.description}</div>}
          </div>
        </div>
      )}
    </div>
  )
}
