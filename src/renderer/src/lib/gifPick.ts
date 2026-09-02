/**
 * What a click on a GIF actually does — the one place that knows, so both pickers agree.
 *
 * Two modes, because Twitch left exactly two options. 'link' types the media URL into the box:
 * an ordinary message from an ordinary token, drawn as a GIF here and as a link elsewhere.
 * 'native' posts a real Twitch GIF message, which needs a web session and is opt-in behind a
 * warning. A native send that fails still leaves the link in the box: a refusal from Twitch should
 * cost you the GIF message, not the GIF.
 */
import { useSettingsStore } from '../store/settings'
import { useUiStore } from '../store/ui'
import { host } from './platform'
import { sendGifMessage } from './twitchGifSend'
import { translate } from '../i18n'
import type { GifItem } from './giphy'

export async function pickGif(
  gif: GifItem,
  channelId: string,
  insert: (text: string) => void
): Promise<void> {
  const { gifSendMode, gifSessionEnc } = useSettingsStore.getState().settings
  if (gifSendMode !== 'native' || !gifSessionEnc || !channelId) {
    insert(gif.url)
    return
  }
  const session = await host().decrypt(gifSessionEnc)
  if (!session) {
    insert(gif.url)
    return
  }
  const res = await sendGifMessage(session, channelId, gif.id, gif.url)
  if (res.ok) return
  const ui = useUiStore.getState()
  const lang = useSettingsStore.getState().settings.language
  if (res.code === 'SESSION_EXPIRED') {
    // the session is gone, so stop pretending the mode still works
    useSettingsStore.getState().setSettings({ gifSendMode: 'link', gifSessionEnc: '' })
    ui.toast(translate(lang, 'gif.sessionExpired'), 'error')
  } else {
    ui.toast(translate(lang, 'gif.sendFailed', { code: res.code ?? '?' }), 'error')
  }
  insert(gif.url)
}
