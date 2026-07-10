import { emojiImageUrl } from '../lib/emojiData'

/** Renders an emoji as text, or as a Twemoji image when the system font can't (flags on Windows). */
export default function EmojiGlyph({ char, className }: { char: string; className?: string }): React.JSX.Element {
  const url = emojiImageUrl(char)
  if (url) return <img className={`emoji-img ${className ?? ''}`} src={url} alt={char} loading="lazy" draggable={false} />
  return <span className={className}>{char}</span>
}
