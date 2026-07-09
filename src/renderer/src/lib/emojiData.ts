import emojiGroups from 'unicode-emoji-json/data-by-group.json'

export interface EmojiEntry {
  char: string
  name: string
}

interface EmojiGroup {
  name: string
  slug: string
  emojis: { emoji: string; name: string }[]
}

/** The complete Unicode emoji set (base variants, no skin tones), in official group order. */
export const EMOJI_LIST: EmojiEntry[] = (emojiGroups as EmojiGroup[]).flatMap((g) =>
  g.emojis.map((e) => ({ char: e.emoji, name: e.name }))
)
