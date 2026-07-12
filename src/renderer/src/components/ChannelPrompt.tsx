import { useEffect } from 'react'
import { useUiStore } from '../store/ui'
import { useLayoutStore } from '../store/layout'
import { useAccountsStore } from '../store/accounts'
import { useSettingsStore } from '../store/settings'
import { useT } from '../i18n'

/** small bottom-right prompt: "Raid! Add the X chat?" — accept adds a pane to the active tab */
export default function ChannelPrompt(): React.JSX.Element | null {
  const t = useT()
  const prompt = useUiStore((s) => s.channelPrompt)

  // auto-dismiss: a stale raid offer minutes later is just noise
  useEffect(() => {
    if (!prompt) return
    const id = window.setTimeout(() => useUiStore.getState().setChannelPrompt(null), 45000)
    return () => window.clearTimeout(id)
  }, [prompt])

  if (!prompt) return null

  const accept = (): void => {
    const layout = useLayoutStore.getState()
    if (prompt.existing) {
      // channel already open — just bring its tab forward
      const tab = layout.tabs.find((t) => t.panes.some((p) => p.channel === prompt.channel))
      if (tab) layout.setActiveTab(tab.id)
      useUiStore.getState().setChannelPrompt(null)
      return
    }
    const accountId = useAccountsStore.getState().accounts[0]?.id ?? null
    const dest = useSettingsStore.getState().settings.raidPromptDest
    if (dest === 'tabs') {
      // its own new top tab
      const tabId = layout.addTab()
      layout.addPane(tabId, prompt.channel, accountId)
    } else {
      // alongside the current channels (split screen)
      const tabId = layout.activeTabId ?? layout.tabs[0]?.id ?? layout.addTab()
      layout.addPane(tabId, prompt.channel, accountId)
    }
    useUiStore.getState().setChannelPrompt(null)
  }

  return (
    <div className="channel-prompt">
      {/* raid info on its own line — the nicks and buttons used to blur together */}
      <div className="channel-prompt-text">
        🚨{' '}
        {prompt.from ? (
          <>
            {t('raid.raidWord')}: <b>{prompt.from}</b> → <b>{prompt.channel}</b>
          </>
        ) : (
          t('raid.addPrompt', { channel: prompt.channel })
        )}
      </div>
      <div className="channel-prompt-actions">
        <button className="primary" onClick={accept}>
          {prompt.existing ? t('raid.switch') : t('raid.add')} {prompt.channel}
        </button>
        <button className="ghost" onClick={() => useUiStore.getState().setChannelPrompt(null)}>
          ✕
        </button>
      </div>
    </div>
  )
}
