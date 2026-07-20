import { displayEmoji, emojiImageUrl } from '../lib/emojiData'

/** Renders an emoji as text, or as a Twemoji image when the system font can't (flags on Windows). */
export default function EmojiGlyph({ char, className }: { char: string; className?: string }): React.JSX.Element {
  const shown = displayEmoji(char)
  const url = emojiImageUrl(shown)
  if (url)
    return (
      <img
        className={`emoji-img ${className ?? ''}`}
        src={url}
        alt={shown}
        loading="lazy"
        draggable={false}
        onError={(e) => {
          // Twemoji names some sequences without FE0F selectors — retry a normalized name,
          // then give up and show the native glyph (the alt text)
          const img = e.currentTarget
          if (!img.dataset.alt) {
            img.dataset.alt = '1'
            const codes = [...shown].map((c) => c.codePointAt(0)!.toString(16)).filter((c) => c !== 'fe0f')
            img.src = `https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64/${codes.join('-')}.png`
          } else {
            img.style.display = 'none'
            img.insertAdjacentText('afterend', shown)
          }
        }}
      />
    )
  return <span className={className}>{shown}</span>
}
