import { useEffect, useRef, useState } from 'react'
import { Account, MOD_ONLY_TYPES, Pane } from '../types'
import { useSettingsStore } from '../store/settings'
import { useUiStore } from '../store/ui'
import { runModButton, resolveUserId } from '../services/modActions'
import { ChatSettingsPatch, getChatSettings, sendAnnouncement, startRaid, updateChatSettings } from '../lib/helix'
import BtnIcon from './BtnIcon'
import { useT } from '../i18n'
import { localizeApiError } from '../lib/apiErrors'

interface Props {
  pane: Pane
  account: Account
  channelId: string
  isMod: boolean
}

type PopoverKind = 'raid' | 'announce' | 'modes' | null

export default function ModToolbar({ pane, account, channelId, isMod }: Props): React.JSX.Element {
  const t = useT()
  const modButtons = useSettingsStore((s) => s.modButtons)
  const raidFavorites = useSettingsStore((s) => s.raidFavorites)
  const [popover, setPopover] = useState<PopoverKind>(null)
  const [raidTarget, setRaidTarget] = useState('')
  const [announceText, setAnnounceText] = useState('')
  const [announceColor, setAnnounceColor] = useState<'primary' | 'blue' | 'green' | 'orange' | 'purple'>('primary')
  const [modes, setModes] = useState<ChatSettingsPatch | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const openModes = async (): Promise<void> => {
    setPopover((p) => (p === 'modes' ? null : 'modes'))
    setModes(null)
    const s = await getChatSettings(account, channelId)
    setModes(s ?? {})
  }

  const patchModes = async (patch: ChatSettingsPatch): Promise<void> => {
    setModes((m) => ({ ...m, ...patch }))
    const res = await updateChatSettings(account, channelId, patch)
    if (!res.ok) {
      useUiStore.getState().toast(localizeApiError((res.json as { message?: string })?.message ?? '') || t('mod.actionFail'), 'error')
      const s = await getChatSettings(account, channelId)
      setModes(s ?? {})
    }
  }

  // close popovers on outside click / Escape
  useEffect(() => {
    if (!popover) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setPopover(null)
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPopover(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [popover])

  const toast = useUiStore.getState().toast
  const toolbarButtons = modButtons
    .filter((b) => b.scope === 'toolbar')
    .filter((b) => isMod || !MOD_ONLY_TYPES.has(b.type))
    .filter((b) => !b.channels?.length || b.channels.includes(pane.channel))

  const doRaid = async (target: string): Promise<void> => {
    setPopover(null)
    setRaidTarget('')
    const id = await resolveUserId(account, target)
    if (!id) {
      toast(t('mod.actionFail'), 'error')
      return
    }
    const res = await startRaid(account, channelId, id)
    if (res.ok) {
      toast(`🚀 ${target}`, 'ok')
      // we just raided that channel — offer to open its chat
      const clean = target.trim().replace(/^[#@]/, '').toLowerCase()
      if (useSettingsStore.getState().settings.raidPrompt) {
        useUiStore.getState().setChannelPrompt({ channel: clean })
      }
      return
    }
    const message = (res.json as { message?: string })?.message ?? ''
    toast(message.includes('must match the user ID') ? t('mod.raidBroadcasterOnly') : message || t('mod.actionFail'), 'error')
  }

  const doAnnounce = async (): Promise<void> => {
    const text = announceText.trim()
    if (!text) return
    setPopover(null)
    setAnnounceText('')
    const res = await sendAnnouncement(account, channelId, text, announceColor)
    toast(
      res.ok ? '📢' : (localizeApiError((res.json as { message?: string })?.message ?? '') || t('mod.actionFail')),
      res.ok ? 'ok' : 'error'
    )
  }

  return (
    <div className="mod-toolbar" style={{ position: 'relative' }} ref={rootRef}>
      {toolbarButtons.map((btn) => {
        if (btn.type === 'raid' && !btn.text) {
          return (
            <button
              key={btn.id}
              className={popover === 'raid' ? 'primary' : ''}
              onClick={() => setPopover((p) => (p === 'raid' ? null : 'raid'))}
              title={t('mod.raid')}
            >
              <BtnIcon icon={btn.icon} /> {btn.label}
            </button>
          )
        }
        if (btn.type === 'announce' && !btn.text) {
          return (
            <button
              key={btn.id}
              className={popover === 'announce' ? 'primary' : ''}
              onClick={() => setPopover((p) => (p === 'announce' ? null : 'announce'))}
              title={t('mod.announce')}
            >
              <BtnIcon icon={btn.icon} /> {btn.label}
            </button>
          )
        }
        return (
          <button
            key={btn.id}
            title={btn.label}
            onClick={() => runModButton(btn, { account, channel: pane.channel, channelId, paneId: pane.id })}
          >
            <BtnIcon icon={btn.icon} /> {btn.label}
          </button>
        )
      })}
      <button
        className="ghost"
        title={t('set.modBtn.add')}
        style={{ opacity: 0.7 }}
        onClick={() => {
          useUiStore.getState().setSettingsSection('moderation')
          if (useSettingsStore.getState().settings.settingsAsWindow) {
            window.sticki.openSettingsWindow('settings=moderation')
          } else {
            useUiStore.getState().setSettingsOpen(true)
          }
        }}
      >
        +
      </button>
      <div className="spacer" />
      {isMod && (
        <>
          <button
            className={popover === 'modes' ? 'primary' : ''}
            title={t('modes.title')}
            onClick={openModes}
          >
            🛡 {t('modes.title')}
          </button>
          <button disabled title={t('mod.pinUnavailable')}>
            📌 {t('mod.pin')}
          </button>
        </>
      )}

      {popover === 'raid' && (
        <div className="popover" style={{ top: '100%', left: 8 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              autoFocus
              placeholder={t('mod.raidTarget')}
              value={raidTarget}
              spellCheck={false}
              onChange={(e) => setRaidTarget(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && raidTarget.trim()) doRaid(raidTarget)
              }}
            />
            <button className="primary" disabled={!raidTarget.trim()} onClick={() => doRaid(raidTarget)}>
              {t('mod.raidGo')}
            </button>
          </div>
          {raidFavorites.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ color: 'var(--text-faint)', fontSize: 11, marginBottom: 4 }}>
                {t('mod.raidFavorites')}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {raidFavorites.map((f) => (
                  <button key={f} onClick={() => doRaid(f)}>
                    {f}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {popover === 'modes' && (
        <div className="popover" style={{ top: '100%', right: 8, width: 280 }}>
          {modes === null ? (
            <div style={{ textAlign: 'center', color: 'var(--text-faint)' }}>…</div>
          ) : (
            <>
              <div className="mode-row">
                <label>
                  <input
                    type="checkbox"
                    checked={!!modes.slow_mode}
                    onChange={(e) =>
                      patchModes({
                        slow_mode: e.target.checked,
                        slow_mode_wait_time: e.target.checked ? (modes.slow_mode_wait_time ?? 30) : undefined
                      })
                    }
                  />
                  {t('modes.slow')}
                </label>
                <input
                  type="number"
                  min={3}
                  max={120}
                  style={{ width: 60 }}
                  disabled={!modes.slow_mode}
                  value={modes.slow_mode_wait_time ?? 30}
                  onChange={(e) =>
                    patchModes({ slow_mode: true, slow_mode_wait_time: parseInt(e.target.value, 10) || 30 })
                  }
                />
              </div>
              <div className="mode-row">
                <label>
                  <input
                    type="checkbox"
                    checked={!!modes.follower_mode}
                    onChange={(e) =>
                      patchModes({
                        follower_mode: e.target.checked,
                        follower_mode_duration: e.target.checked ? (modes.follower_mode_duration ?? 0) : undefined
                      })
                    }
                  />
                  {t('modes.followers')}
                </label>
                <input
                  type="number"
                  min={0}
                  max={129600}
                  style={{ width: 60 }}
                  disabled={!modes.follower_mode}
                  value={modes.follower_mode_duration ?? 0}
                  onChange={(e) =>
                    patchModes({ follower_mode: true, follower_mode_duration: parseInt(e.target.value, 10) || 0 })
                  }
                />
              </div>
              <div className="mode-row">
                <label>
                  <input
                    type="checkbox"
                    checked={!!modes.subscriber_mode}
                    onChange={(e) => patchModes({ subscriber_mode: e.target.checked })}
                  />
                  {t('modes.subs')}
                </label>
              </div>
              <div className="mode-row">
                <label>
                  <input
                    type="checkbox"
                    checked={!!modes.emote_mode}
                    onChange={(e) => patchModes({ emote_mode: e.target.checked })}
                  />
                  {t('modes.emote')}
                </label>
              </div>
              <div className="mode-row">
                <label>
                  <input
                    type="checkbox"
                    checked={!!modes.unique_chat_mode}
                    onChange={(e) => patchModes({ unique_chat_mode: e.target.checked })}
                  />
                  {t('modes.unique')}
                </label>
              </div>
            </>
          )}
        </div>
      )}

      {popover === 'announce' && (
        <div className="popover" style={{ top: '100%', left: 8, width: 320 }}>
          <textarea
            autoFocus
            style={{ width: '100%', height: 60, resize: 'none' }}
            placeholder={t('mod.announcePlaceholder')}
            value={announceText}
            onChange={(e) => setAnnounceText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                doAnnounce()
              }
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <select value={announceColor} onChange={(e) => setAnnounceColor(e.target.value as typeof announceColor)}>
              <option value="primary">primary</option>
              <option value="blue">blue</option>
              <option value="green">green</option>
              <option value="orange">orange</option>
              <option value="purple">purple</option>
            </select>
            <div style={{ flex: 1 }} />
            <button className="primary" disabled={!announceText.trim()} onClick={doAnnounce}>
              {t('mod.announceSend')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
