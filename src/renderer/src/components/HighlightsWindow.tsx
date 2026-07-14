import { useEffect } from 'react'
import { useLayoutStore, nextId } from '../store/layout'
import { useAccountsStore } from '../store/accounts'
import { chatService } from '../services/chatService'
import { PinButton } from './EmotePicker'
import HighlightSidebar from './HighlightSidebar'
import Toasts from './Toasts'
import { useT } from '../i18n'

/**
 * Standalone highlights window (#highlights=<channel>): joins the channel with its own
 * reader (history + live) and shows the highlights/mentions/redeems panel full-window.
 */
export default function HighlightsWindow({ channel }: { channel: string }): React.JSX.Element {
  const t = useT()

  useEffect(() => {
    document.title = `StickiChat — ★ ${channel}`
    const tabId = nextId('tab')
    useLayoutStore.getState().setAll(
      [
        {
          id: tabId,
          name: channel,
          columns: 0,
          panes: [{ id: nextId('pane'), channel, accountId: useAccountsStore.getState().accounts[0]?.id ?? null }]
        }
      ],
      tabId
    )
    chatService.start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // redeems arrive via PubSub in the MAIN window and are persisted to localStorage; pick up
  // new ones live (the storage event fires in this other window) so the redeems tab + colors
  // stay fresh without waiting for a reopen
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === `sticki:redeems:${channel}`) chatService.syncPersistedRedeems(channel)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [channel])

  return (
    <div className="app">
      <div className="detached-bar">
        <span className="detached-title">★ {channel}</span>
        <div className="spacer" />
        <PinButton settingKey="highlightsPinned" />
        <button className="ghost" title={t('misc.close')} onClick={() => window.close()}>
          ✕
        </button>
      </div>
      <HighlightSidebar channel={channel} standalone />
      <Toasts />
    </div>
  )
}
