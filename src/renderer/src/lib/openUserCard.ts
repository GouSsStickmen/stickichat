import { useUiStore, UserCardTarget } from '../store/ui'
import { useSettingsStore } from '../store/settings'

/**
 * Opens a user card respecting the "open in a separate window" setting.
 * The standalone window joins the channel itself, so no message snapshot is needed.
 */
export function openUserCard(target: UserCardTarget): void {
  if (useSettingsStore.getState().settings.usercardAsWindow) {
    const payload = { target, messages: [] }
    window.sticki.openUserCardWindow(`usercard=${encodeURIComponent(JSON.stringify(payload))}`)
  } else {
    useUiStore.getState().setUserCard(target)
  }
}
