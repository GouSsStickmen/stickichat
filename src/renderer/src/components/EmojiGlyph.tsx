import { displayEmoji, emojiImageUrl } from '../lib/emojiData'

/** Renders an emoji as text, or as a Twemoji image when the system font can't (flags on Windows). */
export default function EmojiGlyph({ char, className }: { char: string; className?: string }): React.JSX.Element {
  const shown = displayEmoji(char)
  const url = emojiImageUrl(shown)
  if (url) return <img className={`emoji-img ${className ?? ''}`} src={url} alt={shown} loading="lazy" draggable={false} />
  return <span className={className}>{shown}</span>
}
