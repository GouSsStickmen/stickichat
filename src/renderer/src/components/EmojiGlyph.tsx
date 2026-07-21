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
          // fallback chain: Apple without FE0F → Google Noto (has Unicode 16 emoji the
          // Apple set lacks: 🫩 🫆 🫜 🪉 🪏 …) → the native glyph
          const img = e.currentTarget
          const codes = [...shown].map((c) => c.codePointAt(0)!.toString(16)).filter((c) => c !== 'fe0f')
          if (!img.dataset.stage) {
            img.dataset.stage = '1'
            img.src = `https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64/${codes.join('-')}.png`
          } else if (img.dataset.stage === '1') {
            img.dataset.stage = '2'
            img.src = `https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/png/72/emoji_u${codes.join('_')}.png`
          } else {
            img.style.display = 'none'
            img.insertAdjacentText('afterend', shown)
          }
        }}
      />
    )
  return <span className={className}>{shown}</span>
}
