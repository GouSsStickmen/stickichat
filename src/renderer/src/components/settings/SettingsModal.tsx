import { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../../store/settings'
import { useAccountsStore } from '../../store/accounts'
import { useUiStore } from '../../store/ui'
import { useT } from '../../i18n'
import { ModButton, ModActionType, HighlightRule, Settings } from '../../types'
import { nextId, useLayoutStore } from '../../store/layout'
import { startPointerReorder } from '../../lib/pointerReorder'
import { removeAccountEverywhere, refreshModeratedChannels } from '../../services/accountService'
import { playMentionSound, playFirstMessageSound, playKeywordSound } from '../../lib/sound'
import BtnIcon from '../BtnIcon'
import EmotePicker, { PinButton } from '../EmotePicker'

type Section =
  | 'accounts'
  | 'appearance'
  | 'notifications'
  | 'windows'
  | 'moderation'
  | 'highlights'
  | 'language'
  | 'advanced'

const BUTTON_TYPES: ModActionType[] = [
  'timeout', 'ban', 'unban', 'delete', 'warn', 'shoutout', 'raid', 'announce', 'snippet', 'link', 'fill', 'copy'
]

export default function SettingsModal({
  standalone,
  initialSection
}: {
  standalone?: boolean
  initialSection?: string
}): React.JSX.Element {
  const t = useT()
  const close = (): void => (standalone ? window.close() : useUiStore.getState().setSettingsOpen(false))
  // NOTE: read-only in the initializer — StrictMode runs it twice, so clearing here
  // would wipe the requested section before the second run sees it
  const [section, setSection] = useState<Section>(
    () => ((initialSection ?? useUiStore.getState().settingsSection) as Section | null) ?? 'accounts'
  )
  useEffect(() => {
    useUiStore.getState().setSettingsSection(null)
  }, [])

  // Escape closes; clicking the backdrop intentionally does NOT (misclicks were annoying)
  useEffect(() => {
    if (standalone) return
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standalone])

  const openInWindow = (): void => {
    useUiStore.getState().setSettingsOpen(false)
    window.sticki.openSettingsWindow('settings')
  }

  const body = (
    <>
      <div className="modal-header">
        {t('set.title')}
        <div className="spacer" />
        {standalone && <PinButton settingKey="settingsPinned" />}
        {!standalone && (
          <button className="ghost" title={t('set.openInWindow')} onClick={openInWindow}>
            ⧉
          </button>
        )}
        <button className="ghost" onClick={close}>
          ✕
        </button>
      </div>
      <div className="settings-layout">
        <div className="settings-nav">
          {(
            [
              ['accounts', t('set.accounts')],
              ['appearance', t('set.appearance')],
              ['notifications', t('set.notifications')],
              ['windows', t('set.windows')],
              ['moderation', t('set.moderation')],
              ['highlights', t('set.highlights')],
              ['language', t('set.language')],
              ['advanced', t('set.advanced')]
            ] as [Section, string][]
          ).map(([key, label]) => (
            <button key={key} className={section === key ? 'active' : ''} onClick={() => setSection(key)}>
              {label}
            </button>
          ))}
        </div>
        <div className="settings-content">
          {section === 'accounts' && <AccountsSection />}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'notifications' && <NotificationsSection />}
          {section === 'windows' && <WindowsSection />}
          {section === 'moderation' && <ModerationSection />}
          {section === 'highlights' && <HighlightsSection />}
          {section === 'language' && <LanguageSection />}
          {section === 'advanced' && <AdvancedSection />}
        </div>
      </div>
    </>
  )

  if (standalone) return <div className="modal standalone-settings">{body}</div>

  return (
    <div className="modal-backdrop">
      <div className="modal wide">{body}</div>
    </div>
  )
}

/** color input with right-click reset and a system-wide eyedropper */
function ColorField({
  value,
  defaultValue,
  onChange
}: {
  value: string
  defaultValue: string
  onChange: (v: string) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <input
        type="color"
        value={value}
        title={t('set.colorReset')}
        onChange={(e) => onChange(e.target.value)}
        onContextMenu={(e) => {
          e.preventDefault()
          onChange(defaultValue)
        }}
      />
      <button
        className="ghost"
        title={t('set.eyedropper')}
        onClick={async () => {
          try {
            const ed = new (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper()
            const r = await ed.open()
            onChange(r.sRGBHex)
          } catch {
            /* cancelled / unsupported */
          }
        }}
      >
        💧
      </button>
    </span>
  )
}

function AccountsSection(): React.JSX.Element {
  const t = useT()
  const accounts = useAccountsStore((s) => s.accounts)
  return (
    <div>
      {accounts.map((a) => (
        <div key={a.id} className="account-row">
          {a.avatarUrl && <img src={a.avatarUrl} alt="" />}
          <div className="grow">
            <b>{a.displayName}</b>
            <span className="hint" style={{ marginLeft: 8 }}>
              {a.login} · mod in {a.moderatedChannelIds.length} channels
            </span>
          </div>
          <button onClick={() => refreshModeratedChannels(a.id)}>⟳</button>
          <button className="danger" onClick={() => removeAccountEverywhere(a.id)}>
            {t('set.accounts.remove')}
          </button>
        </div>
      ))}
      <div style={{ marginTop: 12 }}>
        <button className="primary" onClick={() => useUiStore.getState().setAddAccountOpen(true)}>
          + {t('auth.addAccount')}
        </button>
      </div>
    </div>
  )
}

function AppearanceSection(): React.JSX.Element {
  const t = useT()
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  const [systemFonts, setSystemFonts] = useState<string[]>([])
  // custom combobox instead of <datalist>: the native dropdown filters by the CURRENT
  // value (with a font already picked nothing else is selectable) and doesn't scroll
  const [fontOpen, setFontOpen] = useState(false)
  const [fontQuery, setFontQuery] = useState('')
  // Windows-installed fonts via the Local Font Access API (needs a user gesture)
  const loadSystemFonts = async (): Promise<void> => {
    if (systemFonts.length) return
    try {
      const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts
      if (!q) return
      const fonts = await q()
      setSystemFonts([...new Set(fonts.map((f) => f.family))].sort())
    } catch {
      /* permission denied / unsupported — keep the short built-in list */
    }
  }
  const allFonts = [
    ...settings.customFonts.map((f) => f.name),
    ...(systemFonts.length
      ? systemFonts
      : ['Inter', 'Verdana', 'Tahoma', 'Arial', 'Calibri', 'Georgia', 'Consolas', 'Comic Sans MS'])
  ]
  const fontMatches = fontQuery
    ? allFonts.filter((f) => f.toLowerCase().includes(fontQuery.toLowerCase()))
    : allFonts
  return (
    <div>
      <div className="set-group-title">{t('set.group.general')}</div>
      <div className="set-row">
        <label>{t('set.theme')}</label>
        <select value={settings.theme} onChange={(e) => set({ theme: e.target.value as 'dark' | 'light' })}>
          <option value="dark">{t('set.theme.dark')}</option>
          <option value="light">{t('set.theme.light')}</option>
        </select>
      </div>
      <div className="set-row">
        <label>{t('set.fontFamily')}</label>
        <div className="font-combo">
          <input
            style={{ width: 190 }}
            placeholder={t('set.fontFamily.placeholder')}
            value={settings.fontFamily}
            spellCheck={false}
            onChange={(e) => {
              set({ fontFamily: e.target.value })
              setFontQuery(e.target.value)
              setFontOpen(true)
            }}
            onFocus={() => {
              loadSystemFonts()
              // opening shows the FULL list; only typing after that narrows it
              setFontQuery('')
              setFontOpen(true)
            }}
            onBlur={() => setFontOpen(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' || e.key === 'Enter') setFontOpen(false)
            }}
          />
          {fontOpen && fontMatches.length > 0 && (
            <div className="font-combo-list">
              {fontMatches.map((f) => (
                <div
                  key={f}
                  className={`font-combo-item ${f === settings.fontFamily ? 'selected' : ''}`}
                  style={{ fontFamily: `'${f}'` }}
                  // mousedown, not click: click fires after the input's blur closes the list
                  onMouseDown={(e) => {
                    e.preventDefault()
                    set({ fontFamily: f })
                    setFontOpen(false)
                  }}
                >
                  {f}
                </div>
              ))}
            </div>
          )}
        </div>
        <label className="ghost" style={{ cursor: 'pointer' }}>
          <input
            type="file"
            accept=".ttf,.otf,.woff,.woff2"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (!file) return
              if (file.size > 5 * 1024 * 1024) return
              const reader = new FileReader()
              reader.onload = () => {
                const name = file.name.replace(/\.[a-z0-9]+$/i, '')
                const fresh = useSettingsStore.getState().settings
                set({
                  customFonts: [...fresh.customFonts.filter((f) => f.name !== name), { name, data: String(reader.result) }],
                  fontFamily: name
                })
              }
              reader.readAsDataURL(file)
              e.target.value = ''
            }}
          />
          <span className="hint">📁 {t('set.fontUpload')}</span>
        </label>
      </div>
      <div className="set-row">
        <label>{t('set.fontSize')}</label>
        <input
          type="number"
          min={10}
          max={22}
          style={{ width: 70 }}
          value={settings.fontSize}
          onChange={(e) => set({ fontSize: parseInt(e.target.value, 10) || 13 })}
        />
      </div>
      <div className="set-group-title">{t('set.group.emotes')}</div>
      <div className="set-row">
        <label>{t('set.emoteScale')}</label>
        <select value={String(settings.emoteScale)} onChange={(e) => set({ emoteScale: parseFloat(e.target.value) })}>
          <option value="0.75">75%</option>
          <option value="1">100%</option>
          <option value="1.25">125%</option>
          <option value="1.5">150%</option>
          <option value="2">200%</option>
        </select>
      </div>
      <div className="set-group-title">{t('set.group.chat')}</div>
      <div className="set-row">
        <label>{t('set.lineSpacing')}</label>
        <input
          type="number"
          min={0}
          max={24}
          style={{ width: 70 }}
          value={settings.lineSpacing}
          onChange={(e) => set({ lineSpacing: parseInt(e.target.value, 10) || 0 })}
        />
      </div>
      <div className="set-row">
        <label>{t('set.messageSpacing')}</label>
        <input
          type="number"
          min={0}
          max={20}
          style={{ width: 70 }}
          value={settings.messageSpacing}
          onChange={(e) => set({ messageSpacing: parseInt(e.target.value, 10) || 0 })}
        />
      </div>
      <div className="set-row">
        <label>{t('set.badgeSize')}</label>
        <input
          type="number"
          min={12}
          max={32}
          style={{ width: 70 }}
          value={settings.badgeSize}
          onChange={(e) => set({ badgeSize: parseInt(e.target.value, 10) || 18 })}
        />
      </div>
      <div className="set-row">
        <label>{t('set.emojiNameLang')}</label>
        <select
          value={settings.emojiNameLang}
          onChange={(e) => set({ emojiNameLang: e.target.value as Settings['emojiNameLang'] })}
        >
          <option value="uk">Українська</option>
          <option value="en">English</option>
          <option value="both">{t('set.emojiNameLang.both')}</option>
        </select>
      </div>
      <Toggle label={t('set.timestamps')} value={settings.showTimestamps} onChange={(v) => set({ showTimestamps: v })} />
      <Toggle label={t('set.timestampSeconds')} value={settings.timestampSeconds} onChange={(v) => set({ timestampSeconds: v })} />
      <Toggle label={t('set.altBg')} value={settings.alternatingBackground} onChange={(v) => set({ alternatingBackground: v })} />
      <Toggle label={t('set.highlightMentions')} value={settings.highlightMentions} onChange={(v) => set({ highlightMentions: v })} />
      <Toggle label={t('set.caseSensitiveNicks')} value={settings.caseSensitiveNicks} onChange={(v) => set({ caseSensitiveNicks: v })} />
      <Toggle label={t('set.charCounter')} value={settings.showCharCounter} onChange={(v) => set({ showCharCounter: v })} />
      <Toggle label={t('set.translit')} value={settings.translitEnabled} onChange={(v) => set({ translitEnabled: v })} />
      <Toggle label={t('set.streamInfo')} value={settings.showStreamInfo} onChange={(v) => set({ showStreamInfo: v })} />
      <Toggle
        label={t('set.highlightSidebar')}
        value={settings.showHighlightSidebar}
        onChange={(v) => set({ showHighlightSidebar: v })}
      />
      <div className="set-row">
        <label>{t('set.sidebarDefault')}</label>
        <select
          value={settings.highlightSidebarDefault}
          onChange={(e) => set({ highlightSidebarDefault: e.target.value as 'highlights' | 'mentions' })}
        >
          <option value="highlights">{t('highlights.title')}</option>
          <option value="mentions">{t('highlights.mentions')}</option>
        </select>
      </div>
    </div>
  )
}

function NotificationsSection(): React.JSX.Element {
  const t = useT()
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  return (
    <div>
      <Toggle label={t('set.mentionSound')} value={settings.mentionSound} onChange={(v) => set({ mentionSound: v })} />
      {settings.mentionSound && <SoundSettings kind="mention" />}
      <Toggle
        label={t('set.firstMessageSound')}
        value={settings.firstMessageSound}
        onChange={(v) => set({ firstMessageSound: v })}
      />
      {settings.firstMessageSound && <SoundSettings kind="firstMessage" />}
      <Toggle label={t('set.keywordSound')} value={settings.keywordSound} onChange={(v) => set({ keywordSound: v })} />
      {settings.keywordSound && (
        <>
          <div className="set-row" style={{ alignItems: 'flex-start' }}>
            <label>{t('set.keywords')}</label>
            <textarea
              rows={4}
              style={{ flex: 1, resize: 'vertical' }}
              placeholder={t('set.keywords.placeholder')}
              value={settings.keywordAlerts.join('\n')}
              onChange={(e) => set({ keywordAlerts: e.target.value.split('\n') })}
              onBlur={(e) =>
                set({ keywordAlerts: e.target.value.split('\n').map((w) => w.trim()).filter(Boolean) })
              }
            />
          </div>
          <SoundSettings kind="keyword" />
        </>
      )}
    </div>
  )
}

function WindowsSection(): React.JSX.Element {
  const t = useT()
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  return (
    <div>
      <div className="set-row">
        <label>{t('set.pickerDefaultTab')}</label>
        <select
          value={settings.emotePickerDefaultTab}
          onChange={(e) => set({ emotePickerDefaultTab: e.target.value as typeof settings.emotePickerDefaultTab })}
        >
          <option value="favorites">{t('picker.favorites')}</option>
          <option value="twitch">Twitch</option>
          <option value="thirdparty">7TV · BTTV · FFZ</option>
        </select>
      </div>
      <div className="set-row">
        <label>{t('set.previewSize')}</label>
        <input
          type="number"
          min={48}
          max={256}
          style={{ width: 70 }}
          value={settings.emotePreviewSize}
          onChange={(e) => set({ emotePreviewSize: parseInt(e.target.value, 10) || 112 })}
        />
      </div>
      <Toggle
        label={t('set.emotePickerAsWindow')}
        value={settings.emotePickerAsWindow}
        onChange={(v) => set({ emotePickerAsWindow: v })}
      />
      <Toggle
        label={t('set.settingsAsWindow')}
        value={settings.settingsAsWindow}
        onChange={(v) => set({ settingsAsWindow: v })}
      />
      <Toggle
        label={t('set.alwaysOnTop')}
        value={settings.alwaysOnTop}
        onChange={(v) => set({ alwaysOnTop: v })}
      />
      <Toggle
        label={t('set.rememberPin')}
        value={settings.rememberPinState}
        onChange={(v) => set({ rememberPinState: v })}
      />
      <Toggle
        label={t('set.rememberWindowSize')}
        value={settings.rememberWindowSize}
        onChange={(v) => set({ rememberWindowSize: v })}
      />
    </div>
  )
}

type SoundKind = 'mention' | 'firstMessage' | 'keyword'

const SOUND_KEYS = {
  mention: { type: 'mentionSoundType', volume: 'mentionSoundVolume', customId: 'mentionSoundCustomId' },
  firstMessage: {
    type: 'firstMessageSoundType',
    volume: 'firstMessageSoundVolume',
    customId: 'firstMessageSoundCustomId'
  },
  keyword: { type: 'keywordSoundType', volume: 'keywordSoundVolume', customId: 'keywordSoundCustomId' }
} as const

const SOUND_PLAYERS: Record<SoundKind, (s: Settings, force?: boolean) => void> = {
  mention: playMentionSound,
  firstMessage: playFirstMessageSound,
  keyword: playKeywordSound
}

function SoundSettings({ kind }: { kind: SoundKind }): React.JSX.Element {
  const t = useT()
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  const toast = useUiStore.getState().toast

  const typeKey = SOUND_KEYS[kind].type
  const volumeKey = SOUND_KEYS[kind].volume
  const customIdKey = SOUND_KEYS[kind].customId
  const type = settings[typeKey]
  const volume = settings[volumeKey]
  const customId = settings[customIdKey]
  const play = (force: boolean): void => SOUND_PLAYERS[kind](settings, force)

  // the <select> encodes built-in presets as-is, and custom sounds as "custom:{id}"
  const selectValue = type === 'custom' && customId ? `custom:${customId}` : type
  const onSelectChange = (value: string): void => {
    if (value.startsWith('custom:')) {
      set({ [typeKey]: 'custom', [customIdKey]: value.slice(7) } as Partial<Settings>)
    } else {
      set({ [typeKey]: value } as Partial<Settings>)
    }
  }

  const uploadSound = (file: File | undefined): void => {
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      toast(t('set.sound.tooBig'), 'error')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const entry = { id: nextId('snd'), name: file.name.replace(/\.[a-z0-9]+$/i, ''), data: String(reader.result) }
      const fresh = useSettingsStore.getState().settings
      set({ customSounds: [...fresh.customSounds, entry], [typeKey]: 'custom', [customIdKey]: entry.id } as Partial<Settings>)
      SOUND_PLAYERS[kind](useSettingsStore.getState().settings, true)
    }
    reader.onerror = () => toast('Не вдалося прочитати файл', 'error')
    reader.readAsDataURL(file)
  }

  const removeCustomSound = (id: string): void => {
    set({ customSounds: settings.customSounds.filter((c) => c.id !== id) })
    if (customId === id) set({ [typeKey]: 'ping', [customIdKey]: undefined } as Partial<Settings>)
  }

  return (
    <>
      <div className="set-row">
        <label>{t('set.sound.type')}</label>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select value={selectValue} onChange={(e) => onSelectChange(e.target.value)}>
            <option value="ping">{t('set.sound.ping')}</option>
            <option value="pop">{t('set.sound.pop')}</option>
            <option value="bell">{t('set.sound.bell')}</option>
            {settings.customSounds.map((c) => (
              <option key={c.id} value={`custom:${c.id}`}>
                🎵 {c.name}
              </option>
            ))}
          </select>
          <button onClick={() => play(true)} title={t('set.sound.preview')}>
            ▶
          </button>
        </div>
      </div>
      <div className="set-row">
        <label>{t('set.sound.volume')}</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            onChange={(e) => set({ [volumeKey]: parseInt(e.target.value, 10) / 100 } as Partial<Settings>)}
            onMouseUp={() => play(true)}
          />
          <span style={{ width: 36, textAlign: 'right', color: 'var(--text-muted)' }}>
            {Math.round(volume * 100)}%
          </span>
        </div>
      </div>
      <div className="set-row">
        <label>{t('set.sound.upload')}</label>
        <input
          type="file"
          accept="audio/*"
          onChange={(e) => {
            uploadSound(e.target.files?.[0])
            e.target.value = ''
          }}
          style={{ maxWidth: 240 }}
        />
      </div>
      {settings.customSounds.length > 0 && (
        <div className="set-row" style={{ alignItems: 'flex-start' }}>
          <label>{t('set.sound.library')}</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {settings.customSounds.map((c) => (
              <span key={c.id} className="chip">
                {c.name}
                <button className="ghost" onClick={() => removeCustomSound(c.id)}>
                  ✕
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <div className="set-row">
      <label>{label}</label>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
    </div>
  )
}

function ModerationSection(): React.JSX.Element {
  const t = useT()
  const modButtons = useSettingsStore((s) => s.modButtons)
  const setModButtons = useSettingsStore((s) => s.setModButtons)
  const raidFavorites = useSettingsStore((s) => s.raidFavorites)
  const setRaidFavorites = useSettingsStore((s) => s.setRaidFavorites)
  const tabs = useLayoutStore((s) => s.tabs)
  const [favInput, setFavInput] = useState('')
  const [iconPickerFor, setIconPickerFor] = useState<string | null>(null)
  const [draggingBtn, setDraggingBtn] = useState<string | null>(null)
  const modListRef = useRef<HTMLDivElement>(null)
  const firstAccount = useAccountsStore((s) => s.accounts[0])

  const knownChannels = [...new Set(tabs.flatMap((tab) => tab.panes.map((p) => p.channel)))]

  const update = (id: string, patch: Partial<ModButton>): void => {
    setModButtons(modButtons.map((b) => (b.id === id ? { ...b, ...patch } : b)))
  }
  const reorder = (draggedId: string, targetId: string): void => {
    if (draggedId === targetId) return
    // always read fresh state: during a pointer drag this is called many times in a row
    const list = [...useSettingsStore.getState().modButtons]
    const from = list.findIndex((b) => b.id === draggedId)
    const to = list.findIndex((b) => b.id === targetId)
    if (from === -1 || to === -1) return
    const [item] = list.splice(from, 1)
    list.splice(to, 0, item)
    setModButtons(list)
  }
  const needsText = (type: ModActionType): boolean =>
    ['announce', 'snippet', 'link', 'warn', 'timeout', 'ban', 'fill'].includes(type)

  const addFavorite = (): void => {
    const v = favInput.trim().replace(/^[#@]/, '').toLowerCase()
    if (!v || raidFavorites.includes(v)) return
    setRaidFavorites([...raidFavorites, v])
    setFavInput('')
  }

  return (
    <div ref={modListRef}>
      <p className="hint" style={{ color: 'var(--text-faint)', marginTop: 0 }}>
        {t('set.modBtn.hint')}
      </p>
      {modButtons.map((b, index) => (
        <div key={b.id} className={`modbtn-card ${draggingBtn === b.id ? 'dragging' : ''}`}>
          <div className="modbtn-line">
            <span
              className="modbtn-drag"
              title="⠿"
              onPointerDown={(e) => {
                if (!modListRef.current) return
                e.preventDefault()
                startPointerReorder({
                  e,
                  container: modListRef.current,
                  itemSelector: '.modbtn-card',
                  index,
                  axis: 'y',
                  threshold: 3,
                  onMove: (from, to) => {
                    const list = useSettingsStore.getState().modButtons
                    reorder(list[from].id, list[to].id)
                  },
                  onDragState: (d) => setDraggingBtn(d ? b.id : null)
                })
              }}
            >
              ⠿
            </span>
            <span className="modbtn-preview">
              <BtnIcon icon={b.icon} /> {b.label}
            </span>
            <span style={{ position: 'relative' }}>
              <input
                style={{ width: 120 }}
                placeholder={t('set.modBtn.icon')}
                value={b.icon ?? ''}
                spellCheck={false}
                onChange={(e) => update(b.id, { icon: e.target.value })}
              />
              <button
                type="button"
                title={t('picker.open')}
                onClick={() => setIconPickerFor((cur) => (cur === b.id ? null : b.id))}
              >
                😊
              </button>
              {iconPickerFor === b.id && (
                <EmotePicker
                  channel=""
                  channelId=""
                  account={firstAccount}
                  fixed
                  onPick={(emote) => {
                    update(b.id, { icon: emote.provider === 'emoji' ? emote.code : emote.url })
                    setIconPickerFor(null)
                  }}
                  onClose={() => setIconPickerFor(null)}
                />
              )}
            </span>
            <input
              style={{ width: 100 }}
              placeholder={t('set.modBtn.label')}
              value={b.label}
              onChange={(e) => update(b.id, { label: e.target.value })}
            />
            <div className="modbtn-actions">
              <button
                className="danger"
                title={t('set.modBtn.delete')}
                onClick={() => setModButtons(modButtons.filter((x) => x.id !== b.id))}
              >
                ✕
              </button>
            </div>
          </div>
          <div className="modbtn-line">
            <select value={b.type} onChange={(e) => update(b.id, { type: e.target.value as ModActionType })}>
              {BUTTON_TYPES.map((bt) => (
                <option key={bt} value={bt}>
                  {t(`btn.type.${bt}` as Parameters<typeof t>[0])}
                </option>
              ))}
            </select>
            <select value={b.scope} onChange={(e) => update(b.id, { scope: e.target.value as 'message' | 'toolbar' })}>
              <option value="message">{t('set.modBtn.scope.message')}</option>
              <option value="toolbar">{t('set.modBtn.scope.toolbar')}</option>
            </select>
            <input
              style={{ flex: 1 }}
              placeholder={t('set.modBtn.channels')}
              title={t('set.modBtn.channels.hint')}
              value={(b.channels ?? []).join(', ')}
              spellCheck={false}
              onChange={(e) =>
                update(b.id, {
                  channels: e.target.value
                    .split(',')
                    .map((c) => c.trim().toLowerCase().replace(/^#/, ''))
                    .filter(Boolean)
                })
              }
            />
          </div>
          {knownChannels.length > 0 && (
            <div className="modbtn-line modbtn-channel-chips">
              {knownChannels.map((ch) => {
                const active = (b.channels ?? []).includes(ch)
                return (
                  <button
                    key={ch}
                    className={`chip ${active ? 'active' : ''}`}
                    onClick={() => {
                      const cur = b.channels ?? []
                      update(b.id, { channels: active ? cur.filter((c) => c !== ch) : [...cur, ch] })
                    }}
                  >
                    {ch}
                  </button>
                )
              })}
            </div>
          )}
          {(b.type === 'timeout' || needsText(b.type)) && (
            <div className="modbtn-line">
              {b.type === 'timeout' && (
                <input
                  type="number"
                  style={{ width: 110 }}
                  placeholder={t('set.modBtn.seconds')}
                  value={b.seconds ?? ''}
                  onChange={(e) => update(b.id, { seconds: parseInt(e.target.value, 10) || undefined })}
                />
              )}
              {b.type === 'announce' && (
                <select
                  value={b.color ?? 'primary'}
                  onChange={(e) => update(b.id, { color: e.target.value as ModButton['color'] })}
                >
                  {['primary', 'blue', 'green', 'orange', 'purple'].map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              )}
              {needsText(b.type) && (
                <input
                  style={{ flex: 1 }}
                  placeholder={
                    b.type === 'timeout' || b.type === 'ban' ? t('mod.reason') : t('set.modBtn.text')
                  }
                  value={b.text ?? ''}
                  spellCheck={false}
                  onChange={(e) => update(b.id, { text: e.target.value })}
                />
              )}
            </div>
          )}
        </div>
      ))}
      <button
        style={{ marginTop: 8 }}
        onClick={() =>
          setModButtons([
            ...modButtons,
            { id: nextId('mb'), label: 'New', icon: '⭐', type: 'snippet', text: '', scope: 'toolbar' }
          ])
        }
      >
        + {t('set.modBtn.add')}
      </button>

      <h4 style={{ marginTop: 22, marginBottom: 6 }}>{t('set.raidFavorites')}</h4>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input
          placeholder={t('pane.channelPlaceholder')}
          value={favInput}
          spellCheck={false}
          onChange={(e) => setFavInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addFavorite()
          }}
        />
        <button onClick={addFavorite}>{t('set.raidFav.add')}</button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {raidFavorites.map((f) => (
          <span key={f} className="chip">
            {f}
            <button className="ghost" onClick={() => setRaidFavorites(raidFavorites.filter((x) => x !== f))}>
              ✕
            </button>
          </span>
        ))}
      </div>
    </div>
  )
}

// real Twitch badge set ids — note lead_moderator uses an underscore, not a hyphen
const BADGE_OPTIONS: { id: string; labelKey: string }[] = [
  { id: 'broadcaster', labelKey: 'badge.broadcaster' },
  { id: 'moderator', labelKey: 'badge.moderator' },
  { id: 'lead_moderator', labelKey: 'badge.leadModerator' },
  { id: 'vip', labelKey: 'badge.vip' },
  { id: 'subscriber', labelKey: 'badge.subscriber' },
  { id: 'founder', labelKey: 'badge.founder' },
  { id: 'artist-badge', labelKey: 'badge.artist' },
  { id: 'staff', labelKey: 'badge.staff' },
  { id: 'partner', labelKey: 'badge.partner' },
  { id: 'turbo', labelKey: 'badge.turbo' },
  { id: 'premium', labelKey: 'badge.premium' }
]

function HighlightsSection(): React.JSX.Element {
  const t = useT()
  const rules = useSettingsStore((s) => s.highlightRules)
  const setRules = useSettingsStore((s) => s.setHighlightRules)
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)

  const update = (id: string, patch: Partial<HighlightRule>): void => {
    setRules(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  return (
    <div>
      <div className="set-group-title">{t('set.group.msgColors')}</div>
      <Toggle label={t('set.showMentionBg')} value={settings.showMentionBg} onChange={(v) => set({ showMentionBg: v })} />
      <Toggle label={t('set.showFirstMsgBg')} value={settings.showFirstMsgBg} onChange={(v) => set({ showFirstMsgBg: v })} />
      <div className="set-row">
        <label>{t('set.mentionColor')}</label>
        <ColorField
          value={settings.mentionBgColor}
          defaultValue="#8b5cf6"
          onChange={(v) => set({ mentionBgColor: v })}
        />
      </div>
      <div className="set-row">
        <label>{t('set.firstMsgColor')}</label>
        <ColorField
          value={settings.firstMessageBgColor}
          defaultValue="#22c55e"
          onChange={(v) => set({ firstMessageBgColor: v })}
        />
      </div>
      <div className="set-group-title">{t('set.highlights')}</div>
      <p className="hint" style={{ color: 'var(--text-faint)', marginTop: 0 }}>
        {t('hl.hint')}
      </p>
      {rules.map((r) => (
        <div key={r.id} className="modbtn-line" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <input
            type="checkbox"
            title={t('hl.enabled')}
            checked={r.enabled}
            onChange={(e) => update(r.id, { enabled: e.target.checked })}
          />
          <select value={r.kind} onChange={(e) => update(r.id, { kind: e.target.value as 'badge' | 'nick' })}>
            <option value="badge">{t('hl.kind.badge')}</option>
            <option value="nick">{t('hl.kind.nick')}</option>
          </select>
          {r.kind === 'badge' ? (
            <select value={r.value} onChange={(e) => update(r.id, { value: e.target.value })}>
              <option value="" disabled>
                {t('hl.value')}
              </option>
              {BADGE_OPTIONS.map((b) => (
                <option key={b.id} value={b.id}>
                  {t(b.labelKey as Parameters<typeof t>[0])}
                </option>
              ))}
            </select>
          ) : (
            <input
              placeholder={t('hl.nickPlaceholder')}
              value={r.value}
              spellCheck={false}
              onChange={(e) => update(r.id, { value: e.target.value.toLowerCase().trim() })}
            />
          )}
          <ColorField value={r.color} defaultValue="#9147ff" onChange={(v) => update(r.id, { color: v })} />
          <input
            type="range"
            title={`${t('hl.opacity')}: ${Math.round(r.opacity * 100)}%`}
            min={5}
            max={100}
            value={Math.round(r.opacity * 100)}
            onChange={(e) => update(r.id, { opacity: parseInt(e.target.value, 10) / 100 })}
          />
          <span
            className="hl-preview"
            style={{ background: `${r.color}${Math.round(r.opacity * 255).toString(16).padStart(2, '0')}` }}
          >
            Text
          </span>
          <div className="spacer" />
          <button className="danger" onClick={() => setRules(rules.filter((x) => x.id !== r.id))}>
            ✕
          </button>
        </div>
      ))}
      <button
        style={{ marginTop: 10 }}
        onClick={() =>
          setRules([
            ...rules,
            { id: nextId('hl'), kind: 'badge', value: 'moderator', color: '#00c853', opacity: 0.18, enabled: true }
          ])
        }
      >
        + {t('hl.add')}
      </button>
    </div>
  )
}

function LanguageSection(): React.JSX.Element {
  const t = useT()
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  return (
    <div className="set-row">
      <label>{t('set.language')}</label>
      <select value={settings.language} onChange={(e) => set({ language: e.target.value as 'uk' | 'en' })}>
        <option value="uk">Українська</option>
        <option value="en">English</option>
      </select>
    </div>
  )
}

function AdvancedSection(): React.JSX.Element {
  const t = useT()
  const clientId = useSettingsStore((s) => s.clientId)
  const setClientId = useSettingsStore((s) => s.setClientId)
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  const [version, setVersion] = useState('')

  useEffect(() => {
    window.sticki.getVersion().then(setVersion)
  }, [])

  return (
    <div>
      <div className="set-row">
        <label>{t('set.clientId')}</label>
        <input style={{ width: 260 }} value={clientId} spellCheck={false} onChange={(e) => setClientId(e.target.value.trim())} />
      </div>
      <Toggle label={t('set.history')} value={settings.loadHistory} onChange={(v) => set({ loadHistory: v })} />
      <div className="set-row">
        <label>{t('set.msgLimit')}</label>
        <input
          type="number"
          min={100}
          max={5000}
          style={{ width: 90 }}
          value={settings.messageLimit}
          onChange={(e) => set({ messageLimit: parseInt(e.target.value, 10) || 800 })}
        />
      </div>
      <div className="set-row">
        <label>
          {t('set.version')}: v{version}
        </label>
        <button onClick={() => window.sticki.checkForUpdates()}>{t('set.checkUpdates')}</button>
      </div>
    </div>
  )
}
