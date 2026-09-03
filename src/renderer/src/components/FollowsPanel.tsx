import { useEffect, useMemo, useState } from 'react'
import { getFollowedChannels, type FollowedChannel } from '../lib/helix'
import { useAccountsStore } from '../store/accounts'
import { useLayoutStore } from '../store/layout'
import { host } from '../lib/platform'
import { useT } from '../i18n'
import { CloseIcon } from './Icons'

/**
 * Everything the account follows, live ones first.
 *
 * The app knew about channels only once they were open in a tab, so finding somebody meant
 * remembering their login and typing it. This is the list Twitch already keeps: who is on air,
 * what they are playing, what they called the stream, and one click to open their chat here or
 * the channel on Twitch.
 *
 * Fetched on open rather than kept in a store: it is two Helix calls, it goes stale the moment
 * somebody goes live, and nothing else in the app needs it.
 */
export default function FollowsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useT()
  /*
   * Right click on a name copies it.
   *
   * The list is where you go looking for somebody's exact login, and every use of one after that
   * is somewhere else: a command, a message, another app. The tick appears on the row it belongs
   * to, so with a list this long there is no doubt which name is now on the clipboard.
   */
  const [copied, setCopied] = useState<string | null>(null)
  const copyNick = (login: string): void => {
    void navigator.clipboard.writeText(login).then(
      () => {
        setCopied(login)
        window.setTimeout(() => setCopied((c) => (c === login ? null : c)), 1600)
      },
      () => {
        /* a refused clipboard is not worth a dialog */
      }
    )
  }
  const account = useAccountsStore((s) => s.accounts.find((a) => a._accessToken))
  const [list, setList] = useState<FollowedChannel[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')

  const load = async (): Promise<void> => {
    if (!account) return
    setFailed(false)
    const rows = await getFollowedChannels(account)
    // an empty list from an account that follows people means the call was refused, not that
    // they follow nobody; saying "nothing here" would send them looking in the wrong place
    if (rows.length === 0) setFailed(true)
    setList(rows)
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return list ?? []
    return (list ?? []).filter(
      (f) =>
        f.login.includes(q) ||
        f.name.toLowerCase().includes(q) ||
        (f.live?.game ?? '').toLowerCase().includes(q) ||
        (f.live?.title ?? '').toLowerCase().includes(q)
    )
  }, [list, query])

  const openHere = (login: string): void => {
    const layout = useLayoutStore.getState()
    // already open somewhere: bring that tab forward instead of opening a second copy
    const tab = layout.tabs.find((x) => x.panes.some((p) => p.channel === login))
    if (tab) {
      layout.setActiveTab(tab.id)
      onClose()
      return
    }
    const tabId = layout.addTab()
    layout.addPane(tabId, login, useAccountsStore.getState().accounts[0]?.id ?? null)
    layout.setActiveTab(tabId)
    onClose()
  }

  const liveCount = (list ?? []).filter((f) => f.live).length

  return (
    <div className="follows-panel">
      <div className="follows-head">
        <b>{t('follows.title')}</b>
        {list && (
          <span className="follows-count">
            {t('follows.counts', { live: liveCount, total: list.length })}
          </span>
        )}
        <div className="spacer" />
        <button className="ghost" onClick={() => void load()}>
          {t('follows.refresh')}
        </button>
        <button className="ghost" onClick={onClose} title={t('misc.close')}>
          <CloseIcon size={13} />
        </button>
      </div>
      <input
        autoFocus
        placeholder={t('follows.search')}
        value={query}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="follows-list">
        {!account ? (
          <div className="picker-empty">{t('follows.noAccount')}</div>
        ) : list === null ? (
          <div className="picker-empty">{t('picker.gifLoading')}</div>
        ) : failed ? (
          <div className="follows-failed">{t('follows.needScope')}</div>
        ) : shown.length === 0 ? (
          <div className="picker-empty">{t('picker.gifEmpty')}</div>
        ) : (
          shown.map((f) => (
            <div key={f.id} className={`follows-row ${f.live ? 'is-live' : ''}`}>
              <div className="follows-main">
                <span
                  className="follows-name"
                  title={t('follows.copyNick')}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    copyNick(f.login)
                  }}
                >
                  {f.live && <span className="live-dot" />}
                  {f.name}
                  {copied === f.login && (
                    <span className="follows-copied">{t('follows.copied')}</span>
                  )}
                </span>
                {f.live ? (
                  <>
                    <span className="follows-game">{f.live.game || t('follows.noGame')}</span>
                    <span className="follows-title" title={f.live.title}>
                      {f.live.title}
                    </span>
                  </>
                ) : (
                  <span className="follows-offline">{t('follows.offline')}</span>
                )}
              </div>
              <div className="follows-actions">
                {f.live && (
                  <span className="follows-viewers">{f.live.viewers.toLocaleString('uk-UA')}</span>
                )}
                <button onClick={() => openHere(f.login)}>{t('follows.openChat')}</button>
                <button
                  className="ghost"
                  title={t('user.openChannel')}
                  onClick={() => void host().openUrl(`https://www.twitch.tv/${f.login}`)}
                >
                  ↗
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
