import { useMemo } from 'react'
import { ChatMessage } from '../types'
import { tokenizeMessage } from '../lib/tokenize'
import { lookupEmote, lookupCheermote, useEmotesStore } from '../store/emotes'
import { lookupUserColor } from '../store/chat'
import { useUiStore } from '../store/ui'
import EmojiGlyph from './EmojiGlyph'

/**
 * Read-only rich message renderer for the panels/windows that AREN'T the chat pane
 * (usercard, whispers, highlights). Links are clickable; right-click on a nick / emote /
 * "!command" copies it to the clipboard (those windows have no chat input to insert into).
 */
export default function RichText({
  msg,
  channel
}: {
  msg: Pick<ChatMessage, 'text' | 'emotesTag' | 'channel'>
  /** channel to resolve channel emotes/cheermotes from; falls back to msg.channel */
  channel?: string
}): React.JSX.Element {
  const emoteVersion = useEmotesStore((s) => s.version)
  const ch = channel ?? msg.channel
  const tokens = useMemo(
    () =>
      tokenizeMessage(
        msg,
        // no channel context (whispers): search every known set
        ch ? lookupEmote(ch) : (code) => everywhereEmote(code),
        (login) => (ch ? lookupUserColor(ch, login) : undefined),
        true,
        lookupCheermote(ch)
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [msg, ch, emoteVersion]
  )

  const copy = (text: string) => (e: React.MouseEvent): void => {
    e.preventDefault()
    navigator.clipboard.writeText(text.trim())
    useUiStore.getState().toast('📋')
  }

  return (
    <>
      {tokens.map((tk, i) => {
        switch (tk.kind) {
          case 'text':
            return <span key={i}>{tk.text}</span>
          case 'command':
            return (
              <span key={i} className="command-token" title={tk.text} onContextMenu={copy(tk.text)}>
                {tk.text}
              </span>
            )
          case 'link':
            return (
              <a
                key={i}
                href={tk.url}
                onClick={(e) => {
                  e.preventDefault()
                  window.sticki.openExternal(tk.url)
                }}
              >
                {tk.label}
              </a>
            )
          case 'mention':
            return (
              <span key={i} className="mention-token" style={{ color: tk.color }} onContextMenu={copy(tk.name)}>
                {tk.name}
              </span>
            )
          case 'emote':
            return (
              <span key={i} className="emote-wrap" title={tk.emote.code} onContextMenu={copy(tk.emote.code)}>
                <img src={tk.emote.url} alt={tk.emote.code} loading="lazy" />
                {tk.overlays.map((o, j) => (
                  <img key={j} src={o.url} alt={o.code} loading="lazy" />
                ))}
              </span>
            )
          case 'emoji':
            return (
              <span key={i} className="emoji-token" title={tk.char} onContextMenu={copy(tk.char)}>
                <EmojiGlyph char={tk.char} />
              </span>
            )
          case 'cheer':
            return (
              <span key={i} className="cheer-token">
                {tk.url && <img src={tk.url} alt="" loading="lazy" />}
                <span className="cheer-amount" style={{ color: tk.color }}>
                  {tk.bits}
                </span>
              </span>
            )
        }
      })}
    </>
  )
}

/** emote lookup across every loaded set (whispers have no channel context) */
function everywhereEmote(code: string): ReturnType<ReturnType<typeof lookupEmote>> {
  const st = useEmotesStore.getState()
  const g = st.globalEmotes.get(code)
  if (g) return g
  for (const map of Object.values(st.channelEmotes)) {
    const e = map.get(code)
    if (e) return e
  }
  return undefined
}
