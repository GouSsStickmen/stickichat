import { useUiStore, UserCardTarget } from '../store/ui'
import { useSettingsStore } from '../store/settings'
import { useChatStore } from '../store/chat'

/**
 * Opens a user card respecting the "open in a separate window" setting.
 * The standalone window gets a SNAPSHOT of this window's buffer for the user — its own
 * fresh reader only backfills a short recent-messages history, which lost most lines.
 */
export function openUserCard(target: UserCardTarget): void {
  if (useSettingsStore.getState().settings.usercardAsWindow) {
    const all = useChatStore.getState().messages[target.channel] ?? []
    const snapshot = all
      .filter(
        (m) =>
          (m.userId === target.userId && !m.system) ||
          (m.system && m.modTargetUserId === target.userId)
      )
      .slice(-80)
    const payload = { target, messages: snapshot }
    window.sticki.openUserCardWindow(`usercard=${encodeURIComponent(JSON.stringify(payload))}`)
  } else {
    useUiStore.getState().setUserCard(target)
  }
}
