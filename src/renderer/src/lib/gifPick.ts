/**
 * What a click on a GIF does: it types the GIF's media URL into the message box.
 *
 * There is no second way, and that is a finding rather than a shortcut. Twitch makes real GIF
 * messages with a private mutation, sendGifMessage, and it sits behind their anti-bot integrity
 * check — measured with a genuine twitch.tv session that Twitch itself confirmed was allowed to
 * send GIFs in that channel (gifPickerConfig answered isEnabled and isAllowlisted), the mutation
 * still returned "failed integrity check" on both of their client ids. Getting past that means
 * defeating bot detection, so this app does not try.
 *
 * What is left is an ordinary message carrying an ordinary link, which StickiChat draws as the GIF
 * it points at. The picker says plainly that other clients will see a link.
 */
import type { GifItem } from './giphy'

export function pickGif(gif: GifItem, insert: (text: string) => void): void {
  insert(gif.url)
}
