import { useState } from 'react'
import { useLayoutStore } from '../store/layout'
import { useAccountsStore } from '../store/accounts'
import { useUiStore } from '../store/ui'
import ChatPane from './ChatPane'
import { useT } from '../i18n'

export default function SplitGrid(): React.JSX.Element | null {
  const t = useT()
  const tabs = useLayoutStore((s) => s.tabs)
  const activeTabId = useLayoutStore((s) => s.activeTabId)
  const tab = tabs.find((x) => x.id === activeTabId) ?? tabs[0]

  if (!tab) {
    return (
      <div className="split-grid" style={{ gridTemplateColumns: '1fr' }}>
        <div className="empty-tab">
          <button className="primary" onClick={() => useLayoutStore.getState().addTab()}>
            {t('tab.new')}
          </button>
        </div>
      </div>
    )
  }

  const n = tab.panes.length
  const columns = tab.columns > 0 ? tab.columns : n <= 1 ? 1 : n <= 3 ? n : n === 4 ? 2 : 3

  return (
    <div className="split-grid" style={{ gridTemplateColumns: `repeat(${Math.max(columns, 1)}, 1fr)` }}>
      {tab.panes.map((pane) => (
        <ChatPane key={pane.id} tabId={tab.id} pane={pane} />
      ))}
      {n === 0 && (
        <div className="empty-tab">
          {/* a fresh tab asks for the channel right away, no extra click — nothing to cancel */}
          <AddPaneForm tabId={tab.id} onDone={() => undefined} cancelable={false} />
        </div>
      )}
    </div>
  )
}

export function AddPaneForm({ tabId, onDone, cancelable = true }: { tabId: string; onDone: () => void; cancelable?: boolean }): React.JSX.Element {
  const t = useT()
  const accounts = useAccountsStore((s) => s.accounts)
  const tabs = useLayoutStore((s) => s.tabs)
  const [channel, setChannel] = useState('')
  const [accountId, setAccountId] = useState<string>(accounts[0]?.id ?? '')

  // suggest channels the user already has in other tabs
  const knownChannels = [...new Set(tabs.flatMap((tab) => tab.panes.map((p) => p.channel)))]

  const submit = (): void => {
    const ch = channel.trim().replace(/^[#@]/, '').toLowerCase()
    if (!ch) return
    useLayoutStore.getState().addPane(tabId, ch, accountId || null)
    onDone()
  }

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <div className="hint" style={{ width: '100%', color: 'var(--text-faint)' }}>{t('pane.addHint')}</div>
      <input
        autoFocus
        list="known-channels"
        style={{ minWidth: 130, flex: 1 }}
        placeholder={t('pane.channelPlaceholder')}
        value={channel}
        spellCheck={false}
        onChange={(e) => setChannel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') onDone()
        }}
      />
      <datalist id="known-channels">
        {knownChannels.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <select
        value={accountId}
        onChange={(e) => {
          if (e.target.value === '__add__') {
            useUiStore.getState().setAddAccountOpen(true)
            return
          }
          setAccountId(e.target.value)
        }}
      >
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.displayName}
          </option>
        ))}
        <option value="">{t('pane.readOnly')}</option>
        <option value="__add__">+ {t('auth.addAccount')}</option>
      </select>
      <button className="primary" onClick={submit}>
        {t('misc.add')}
      </button>
      {cancelable && (
        <button className="ghost" title={t('oe.cancel')} onClick={onDone}>
          ✕
        </button>
      )}
    </div>
  )
}
