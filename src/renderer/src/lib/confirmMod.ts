import { useUiStore } from '../store/ui'
import { isMobile } from './platform'

/** what the user is about to do to whom, as the dialog needs to say it */
export interface ModConfirmRequest {
  kind: 'ban' | 'timeout' | 'delete'
  /** timeout length, already formatted for reading */
  duration?: string
  login: string
  resolve: (ok: boolean) => void
}

/**
 * A last look before a ban or a timeout, on touch only.
 *
 * On a phone the swipe is a hand-sized gesture over a hand-sized pane: the ban zone begins 342px
 * from the grip, which on a 411px screen is simply "swipe across", and the grip itself sits exactly
 * where Android's own back gesture starts. Two real people were banned by accident before this
 * existed.
 *
 * The desktop is left as it was. There a 342px drag is a deliberate act, and adding a dialog to a
 * moderation tool that people use at speed would be a regression rather than a safeguard.
 */
export function confirmDestructive(
  kind: 'ban' | 'timeout' | 'delete',
  login: string,
  duration?: string
): Promise<boolean> {
  if (!isMobile()) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    useUiStore.getState().setModConfirm({ kind, login, duration, resolve })
  })
}
