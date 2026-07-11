import { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../../store/settings'
import { useAccountsStore } from '../../store/accounts'
import { useUiStore } from '../../store/ui'
import { useT } from '../../i18n'
import {
  DEFAULT_HOTKEYS,
  HighlightKind,
  HighlightRule,
  HotkeyAction,
  ModButton,
  ModActionType,
  Settings,
  VALUELESS_HL_KINDS
} from '../../types'
import { nextId, useLayoutStore } from '../../store/layout'
import { startPointerReorder } from '../../lib/pointerReorder'
import { useFlip } from '../../lib/useFlip'
import { eventToAccel, hotkeyFor } from '../../lib/hotkeys'
import { hexToRgba } from '../../lib/tokenize'
import { removeAccountEverywhere, refreshModeratedChannels } from '../../services/accountService'
import { playMentionSound, playFirstMessageSound, playKeywordSound, playStreamUpSound, playWhisperSound } from '../../lib/sound'
import { CHANGELOG } from '../../changelog'
import BtnIcon from '../BtnIcon'
import EmotePicker, { PinButton } from '../EmotePicker'

type Section =
  | 'accounts'
  | 'appearance'
  | 'chat'
  | 'highlights'
  | 'notifications'
  | 'moderation'
  | 'hotkeys'
  | 'windows'
  | 'advanced'
  | 'about'

const BUTTON_TYPES: ModActionType[] = [
  'timeout', 'ban', 'unban', 'delete', 'warn', 'shoutout', 'raid', 'announce', 'snippet', 'link', 'fill', 'copy'
]

const DEVELOPER = 'GouS_Stickmen'
const GITHUB_ISSUES = 'https://github.com/GouSsStickmen/stickichat/issues'
const TWITCH_PROFILE = 'https://www.twitch.tv/gous_stickmen'

export default function SettingsModal({
  standalone,
  initialSection
}: {
  standalone?: boolean
  initialSection?: string
}): React.JSX.Element {
  const t = useT()
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
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
        {/* language switcher lives in the header — always one click away */}
        <select
          value={settings.language}
          style={{ marginRight: 6, padding: '4px 7px', fontSize: 12 }}
          onChange={(e) => set({ language: e.target.value as 'uk' | 'en' })}
        >
          <option value="uk">🇺🇦 Українська</option>
          <option value="en">🇬🇧 English</option>
        </select>
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
              ['chat', t('set.chat')],
              ['highlights', t('set.highlights')],
              ['notifications', t('set.notifications')],
              ['moderation', t('set.moderation')],
              ['hotkeys', t('set.hotkeys')],
              ['windows', t('set.windows')],
              ['advanced', t('set.advanced')],
              ['about', t('set.about')]
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
          {section === 'chat' && <ChatSection />}
          {section === 'highlights' && <HighlightsSection />}
          {section === 'notifications' && <NotificationsSection />}
          {section === 'moderation' && <ModerationSection />}
          {section === 'hotkeys' && <HotkeysSection />}
          {section === 'windows' && <WindowsSection />}
          {section === 'advanced' && <AdvancedSection />}
          {section === 'about' && <AboutSection />}
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

/** color input with right-click reset, a system-wide eyedropper and a saved/recent palette */
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
  const set = useSettingsStore((s) => s.setSettings)
  const savedColors = useSettingsStore((s) => s.settings.savedColors)
  const recentColors = useSettingsStore((s) => s.settings.recentColors)
  const [palOpen, setPalOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!palOpen) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setPalOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [palOpen])

  const commitRecent = (v: string): void => {
    const fresh = useSettingsStore.getState().settings
    set({ recentColors: [v, ...fresh.recentColors.filter((c) => c !== v)].slice(0, 10) })
  }
  const apply = (v: string): void => {
    onChange(v)
    commitRecent(v)
  }

  return (
    <span ref={rootRef} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', position: 'relative' }}>
      <input
        type="color"
        value={value}
        title={t('set.colorReset')}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => commitRecent(value)}
        onContextMenu={(e) => {
          e.preventDefault()
          onChange(defaultValue)
        }}
      />
      <button
        className="ghost"
        title={t('set.eyedropper')}
        onClick={async () => {
          // the OS eyedropper loupe renders below any always-on-top window; the settings can be
          // a separate window while the main chat stays pinned, so drop EVERY pinned window for
          // the duration of the pick, then restore them
          await window.sticki.suspendAlwaysOnTop()
          try {
            const ed = new (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper()
            const r = await ed.open()
            apply(r.sRGBHex)
          } catch {
            /* cancelled / unsupported */
          } finally {
            await window.sticki.resumeAlwaysOnTop()
          }
        }}
      >
        💧
      </button>
      <button
        className={`ghost ${palOpen ? 'active' : ''}`}
        title={`${t('color.saved')} · ${t('color.recent')}`}
        onClick={() => setPalOpen((v) => !v)}
      >
        🎨
      </button>
      {palOpen && (
        <div className="color-pal">
          <div className="color-pal-title">{t('color.saved')}</div>
          <div className="color-pal-row">
            {savedColors.map((c) => (
              <button
                key={c}
                className="color-swatch"
                style={{ background: c }}
                title={`${c} · ${t('color.remove')}`}
                onClick={() => apply(c)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  set({ savedColors: savedColors.filter((x) => x !== c) })
                }}
              />
            ))}
            <button
              className="color-swatch color-swatch-add"
              title={t('color.save')}
              onClick={() => {
                if (!savedColors.includes(value)) set({ savedColors: [...savedColors, value].slice(0, 20) })
              }}
            >
              +
            </button>
          </div>
          {recentColors.length > 0 && (
            <>
              <div className="color-pal-title">{t('color.recent')}</div>
              <div className="color-pal-row">
                {recentColors.map((c) => (
                  <button
                    key={c}
                    className="color-swatch"
                    style={{ background: c }}
                    title={c}
                    onClick={() => apply(c)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
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
      <div className="set-row" title={t('hint.emojiNameLang')}>
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
    </div>
  )
}

function ChatSection(): React.JSX.Element {
  const t = useT()
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  return (
    <div>
      <div className="set-group-title">{t('set.group.general')}</div>
      <Toggle label={t('set.timestamps')} value={settings.showTimestamps} onChange={(v) => set({ showTimestamps: v })} />
      <Toggle label={t('set.timestampSeconds')} value={settings.timestampSeconds} onChange={(v) => set({ timestampSeconds: v })} />
      <Toggle label={t('set.altBg')} hint={t('hint.altBg')} value={settings.alternatingBackground} onChange={(v) => set({ alternatingBackground: v })} />
      <Toggle label={t('set.streamInfo')} hint={t('hint.streamInfo')} value={settings.showStreamInfo} onChange={(v) => set({ showStreamInfo: v })} />
      <Toggle label={t('set.showBits')} hint={t('hint.showBits')} value={settings.showBits} onChange={(v) => set({ showBits: v })} />
      <Toggle label={t('set.showRedeems')} hint={t('hint.showRedeems')} value={settings.showRedeems} onChange={(v) => set({ showRedeems: v })} />
      <Toggle label={t('set.history')} hint={t('hint.history')} value={settings.loadHistory} onChange={(v) => set({ loadHistory: v })} />
      <div className="set-row" title={t('hint.lineSpacing')}>
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
      <div className="set-row" title={t('hint.messageSpacing')}>
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
      <div className="set-group-title">{t('input.send')}</div>
      <Toggle label={t('set.emoteSuggestions')} hint={t('hint.emoteSuggestions')} value={settings.emoteSuggestions} onChange={(v) => set({ emoteSuggestions: v })} />
      <Toggle label={t('set.charCounter')} hint={t('hint.charCounter')} value={settings.showCharCounter} onChange={(v) => set({ showCharCounter: v })} />
      <Toggle label={t('set.translit')} hint={t('hint.translit')} value={settings.translitEnabled} onChange={(v) => set({ translitEnabled: v })} />
      <Toggle label={t('set.caseSensitiveNicks')} hint={t('hint.caseSensitiveNicks')} value={settings.caseSensitiveNicks} onChange={(v) => set({ caseSensitiveNicks: v })} />
      <div className="set-group-title">{t('highlights.title')}</div>
      <Toggle
        label={t('set.highlightSidebar')}
        hint={t('hint.highlightSidebar')}
        value={settings.showHighlightSidebar}
        onChange={(v) => set({ showHighlightSidebar: v })}
      />
      <div className="set-row" title={t('hint.sidebarDefault')}>
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
      <Toggle label={t('set.mentionSound')} hint={t('hint.mentionSound')} value={settings.mentionSound} onChange={(v) => set({ mentionSound: v })} />
      {settings.mentionSound && <SoundSettings kind="mention" />}
      <Toggle
        label={t('set.firstMessageSound')}
        hint={t('hint.firstMessageSound')}
        value={settings.firstMessageSound}
        onChange={(v) => set({ firstMessageSound: v })}
      />
      {settings.firstMessageSound && <SoundSettings kind="firstMessage" />}
      <Toggle label={t('set.keywordSound')} hint={t('hint.keywordSound')} value={settings.keywordSound} onChange={(v) => set({ keywordSound: v })} />
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
      <div className="set-group-title">{t('whisper.title')}</div>
      <Toggle label={t('set.whisperSound')} value={settings.whisperSound} onChange={(v) => set({ whisperSound: v })} />
      {settings.whisperSound && <SoundSettings kind="whisper" />}
      <div className="set-group-title">{t('set.group.streamUp')}</div>
      <Toggle label={t('set.streamUpNotify')} hint={t('hint.streamUp')} value={settings.streamUpNotify} onChange={(v) => set({ streamUpNotify: v })} />
      <Toggle label={t('set.streamUpSound')} hint={t('hint.streamUp')} value={settings.streamUpSound} onChange={(v) => set({ streamUpSound: v })} />
      {settings.streamUpSound && <SoundSettings kind="streamUp" />}
      <div className="set-group-title">{t('mod.raid')}</div>
      <Toggle label={t('set.raidPrompt')} hint={t('hint.raidPrompt')} value={settings.raidPrompt} onChange={(v) => set({ raidPrompt: v })} />
      {settings.raidPrompt && (
        <>
          <div className="set-row">
            <label>{t('set.raidDest')}</label>
            <select value={settings.raidPromptDest} onChange={(e) => set({ raidPromptDest: e.target.value as 'tabs' | 'split' })}>
              <option value="split">{t('set.raidDest.split')}</option>
              <option value="tabs">{t('set.raidDest.tabs')}</option>
            </select>
          </div>
          <Toggle
            label={t('set.raidActiveOnly')}
            hint={t('hint.raidActiveOnly')}
            value={settings.raidPromptActiveOnly}
            onChange={(v) => set({ raidPromptActiveOnly: v })}
          />
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
      <div className="set-group-title">{t('set.group.general')}</div>
      <Toggle
        label={t('set.alwaysOnTop')}
        hint={t('hint.alwaysOnTop')}
        value={settings.alwaysOnTop}
        onChange={(v) => set({ alwaysOnTop: v })}
      />
      <Toggle
        label={t('set.rememberWindowSize')}
        hint={t('hint.rememberWindowSize')}
        value={settings.rememberWindowSize}
        onChange={(v) => set({ rememberWindowSize: v })}
      />
      <Toggle
        label={t('set.rememberPin')}
        hint={t('hint.rememberPin')}
        value={settings.rememberPinState}
        onChange={(v) => set({ rememberPinState: v })}
      />
      <div className="set-group-title">{t('set.title')}</div>
      <Toggle
        label={t('set.settingsAsWindow')}
        hint={t('hint.settingsAsWindow')}
        value={settings.settingsAsWindow}
        onChange={(v) => set({ settingsAsWindow: v })}
      />
      <div className="set-group-title">{t('user.viewercard')}</div>
      <Toggle
        label={t('set.usercardAsWindow')}
        hint={t('hint.usercardAsWindow')}
        value={settings.usercardAsWindow}
        onChange={(v) => set({ usercardAsWindow: v })}
      />
      <div className="set-group-title">{t('picker.open')}</div>
      <Toggle
        label={t('set.emotePickerAsWindow')}
        hint={t('hint.emotePickerAsWindow')}
        value={settings.emotePickerAsWindow}
        onChange={(v) => set({ emotePickerAsWindow: v })}
      />
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
    </div>
  )
}

type SoundKind = 'mention' | 'firstMessage' | 'keyword' | 'streamUp' | 'whisper'

const SOUND_KEYS = {
  mention: { type: 'mentionSoundType', volume: 'mentionSoundVolume', customId: 'mentionSoundCustomId' },
  firstMessage: {
    type: 'firstMessageSoundType',
    volume: 'firstMessageSoundVolume',
    customId: 'firstMessageSoundCustomId'
  },
  keyword: { type: 'keywordSoundType', volume: 'keywordSoundVolume', customId: 'keywordSoundCustomId' },
  streamUp: { type: 'streamUpSoundType', volume: 'streamUpSoundVolume', customId: 'streamUpSoundCustomId' },
  whisper: { type: 'whisperSoundType', volume: 'whisperSoundVolume', customId: 'whisperSoundCustomId' }
} as const

const SOUND_PLAYERS: Record<SoundKind, (s: Settings, force?: boolean) => void> = {
  mention: playMentionSound,
  firstMessage: playFirstMessageSound,
  keyword: playKeywordSound,
  streamUp: playStreamUpSound,
  whisper: playWhisperSound
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
          {/* delete the currently-selected uploaded sound right here — no bulky bottom list */}
          {type === 'custom' && customId && (
            <button className="danger" title={t('set.sound.delete')} onClick={() => removeCustomSound(customId)}>
              🗑
            </button>
          )}
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
    </>
  )
}

function Toggle({
  label,
  value,
  onChange,
  hint
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
  hint?: string
}): React.JSX.Element {
  return (
    <div className="set-row" title={hint}>
      <label className={hint ? 'has-hint' : undefined}>{label}</label>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
    </div>
  )
}

/** multi-select dropdown for the channels a mod button is limited to (empty = everywhere) */
function ChannelMultiSelect({
  value,
  known,
  onChange
}: {
  value: string[]
  known: string[]
  onChange: (channels: string[]) => void
}): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [add, setAdd] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // known channels first, then any manually-added ones not currently open
  const options = [...new Set([...known, ...value])]
  const toggle = (ch: string): void =>
    onChange(value.includes(ch) ? value.filter((c) => c !== ch) : [...value, ch])
  const label = value.length === 0 ? t('set.modBtn.allChannels') : value.join(', ')

  return (
    <div className="chan-select" ref={ref}>
      <button className="chan-select-btn" title={t('set.modBtn.channels.hint')} onClick={() => setOpen((v) => !v)}>
        <span className="chan-select-label">{label}</span>
        <span className="chan-select-caret">▾</span>
      </button>
      {open && (
        <div className="chan-select-pop">
          {/* preventDefault on mousedown keeps focus off these buttons — otherwise the browser
              scrolls the focused option into view and the settings pane visibly jumps */}
          <button
            className={`chan-opt ${value.length === 0 ? 'active' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange([])}
          >
            {t('set.modBtn.allChannels')}
          </button>
          {options.map((ch) => (
            <button
              key={ch}
              className={`chan-opt ${value.includes(ch) ? 'active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggle(ch)}
            >
              <input type="checkbox" readOnly checked={value.includes(ch)} /> {ch}
            </button>
          ))}
          <div className="chan-add">
            <input
              placeholder={t('pane.channelPlaceholder')}
              value={add}
              spellCheck={false}
              onChange={(e) => setAdd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                const ch = add.trim().toLowerCase().replace(/^[#@]/, '')
                if (ch && !value.includes(ch)) onChange([...value, ch])
                setAdd('')
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

/** edit the swipe-to-moderate timeout tiers (seconds, shortest→longest) */
function SwipeTiersEditor(): React.JSX.Element {
  const t = useT()
  const tiers = useSettingsStore((s) => s.settings.swipeTimeouts)
  const set = useSettingsStore((s) => s.setSettings)
  const [raw, setRaw] = useState(tiers.join(', '))
  useEffect(() => setRaw(tiers.join(', ')), [tiers])
  const commit = (): void => {
    const parsed = raw
      .split(',')
      .map((x) => parseInt(x.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0)
    set({ swipeTimeouts: parsed.length ? parsed : [60, 300, 600, 1800, 3600, 86400] })
  }
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input
        style={{ flex: 1 }}
        value={raw}
        spellCheck={false}
        placeholder="60, 300, 600, 1800, 3600, 86400"
        onChange={(e) => setRaw(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
      <span className="hint" style={{ color: 'var(--text-faint)' }}>
        {t('set.swipeTiers.unit')}
      </span>
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

  // same glide animation the tab bar uses — cards flow around the dragged one
  useFlip(modListRef, '.modbtn-card', !!draggingBtn)

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
        <div key={b.id} data-flipid={b.id} className={`modbtn-card ${draggingBtn === b.id ? 'dragging' : ''}`}>
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
                className="ghost"
                title={t('set.modBtn.duplicate')}
                onClick={() => {
                  const list = useSettingsStore.getState().modButtons
                  const i = list.findIndex((x) => x.id === b.id)
                  const copy = { ...b, id: nextId('mb') }
                  setModButtons([...list.slice(0, i + 1), copy, ...list.slice(i + 1)])
                }}
              >
                ⧉
              </button>
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
            <ChannelMultiSelect
              value={b.channels ?? []}
              known={knownChannels}
              onChange={(channels) => update(b.id, { channels })}
            />
          </div>
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

      <h4 style={{ marginTop: 22, marginBottom: 6 }}>{t('set.swipeTiers')}</h4>
      <p className="hint" style={{ color: 'var(--text-faint)', marginTop: 0 }}>
        {t('set.swipeTiers.hint')}
      </p>
      <SwipeTiersEditor />

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

const HL_KINDS: HighlightKind[] = ['badge', 'nick', 'own', 'redeem', 'bits', 'firstMsg', 'firstStream', 'watchStreak']

function HighlightsSection(): React.JSX.Element {
  const t = useT()
  const rules = useSettingsStore((s) => s.highlightRules)
  const setRules = useSettingsStore((s) => s.setHighlightRules)
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  const [mutedInput, setMutedInput] = useState('')

  const update = (id: string, patch: Partial<HighlightRule>): void => {
    setRules(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  const addMuted = (): void => {
    const login = mutedInput.trim().replace(/^@/, '').toLowerCase()
    if (!login || settings.mutedUsers.some((u) => u.login === login)) return
    set({ mutedUsers: [...settings.mutedUsers, { login, mode: 'dim', opacity: 0.3 }] })
    setMutedInput('')
  }

  return (
    <div>
      <div className="set-group-title">{t('set.group.msgColors')}</div>
      <p className="hint" style={{ color: 'var(--text-faint)', marginTop: 0 }}>
        {t('hl.hint')}
      </p>
      {/* mentions: built-in category, same standardized row as the rules below */}
      <div className="hl-row" title={t('hint.mentionBg')}>
        <input
          type="checkbox"
          title={t('hl.enabled')}
          checked={settings.showMentionBg}
          onChange={(e) => set({ showMentionBg: e.target.checked })}
        />
        <span className="hl-kind-label">@ {t('hl.mention')}</span>
        <ColorField
          value={settings.mentionBgColor}
          defaultValue="#8b5cf6"
          onChange={(v) => set({ mentionBgColor: v })}
        />
        <input
          type="range"
          title={`${t('hl.opacity')}: ${Math.round(settings.mentionBgOpacity * 100)}%`}
          min={5}
          max={100}
          value={Math.round(settings.mentionBgOpacity * 100)}
          onChange={(e) => set({ mentionBgOpacity: parseInt(e.target.value, 10) / 100 })}
        />
        <span className="hl-preview" style={{ background: hexToRgba(settings.mentionBgColor, settings.mentionBgOpacity) }}>
          Text
        </span>
        <div className="spacer" />
      </div>
      {rules.map((r) => (
        <div key={r.id} className="hl-row">
          <input
            type="checkbox"
            title={t('hl.enabled')}
            checked={r.enabled}
            onChange={(e) => update(r.id, { enabled: e.target.checked })}
          />
          <select
            value={r.kind}
            onChange={(e) => {
              const kind = e.target.value as HighlightKind
              update(r.id, { kind, value: kind === 'badge' ? 'moderator' : '' })
            }}
          >
            {HL_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`hl.kind.${k}` as Parameters<typeof t>[0])}
              </option>
            ))}
          </select>
          {r.kind === 'badge' && (
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
          )}
          {r.kind === 'nick' && (
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
          <span className="hl-preview" style={{ background: hexToRgba(r.color, r.opacity) }}>
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

      <div className="set-group-title" style={{ marginTop: 24 }}>
        {t('muted.title')}
      </div>
      <p className="hint" style={{ color: 'var(--text-faint)', marginTop: 0 }}>
        {t('muted.hint')}
      </p>
      {settings.mutedUsers.map((u) => (
        <div key={u.login} className="hl-row">
          <b style={{ minWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.login}</b>
          <select
            value={u.mode}
            onChange={(e) =>
              set({
                mutedUsers: settings.mutedUsers.map((x) =>
                  x.login === u.login ? { ...x, mode: e.target.value as 'hide' | 'dim' } : x
                )
              })
            }
          >
            <option value="dim">{t('muted.mode.dim')}</option>
            <option value="hide">{t('muted.mode.hide')}</option>
          </select>
          <input
            type="range"
            title={`${t('hl.opacity')}: ${Math.round(u.opacity * 100)}%`}
            min={5}
            max={90}
            disabled={u.mode === 'hide'}
            value={Math.round(u.opacity * 100)}
            onChange={(e) =>
              set({
                mutedUsers: settings.mutedUsers.map((x) =>
                  x.login === u.login ? { ...x, opacity: parseInt(e.target.value, 10) / 100 } : x
                )
              })
            }
          />
          <span className="hl-preview" style={{ opacity: u.mode === 'hide' ? 0.15 : u.opacity }}>
            Text
          </span>
          <div className="spacer" />
          <button
            className="danger"
            onClick={() => set({ mutedUsers: settings.mutedUsers.filter((x) => x.login !== u.login) })}
          >
            ✕
          </button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input
          placeholder={t('muted.placeholder')}
          value={mutedInput}
          spellCheck={false}
          onChange={(e) => setMutedInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addMuted()
          }}
        />
        <button onClick={addMuted}>{t('muted.add')}</button>
      </div>
    </div>
  )
}

const EDITABLE_HOTKEYS: HotkeyAction[] = ['reconnect', 'scrollLock', 'translit', 'resendLast']

function HotkeyInput({ action }: { action: HotkeyAction }): React.JSX.Element {
  const t = useT()
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  const [capturing, setCapturing] = useState(false)
  const current = hotkeyFor(settings, action)
  const isDefault = current === DEFAULT_HOTKEYS[action]

  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <button
        className={`hotkey-btn ${capturing ? 'capturing' : ''}`}
        onClick={() => setCapturing(true)}
        onBlur={() => setCapturing(false)}
        onKeyDown={(e) => {
          if (!capturing) return
          e.preventDefault()
          e.stopPropagation()
          if (e.key === 'Escape') {
            setCapturing(false)
            return
          }
          if (e.key === 'Backspace') {
            // reset to default
            const { [action]: _, ...rest } = settings.hotkeys
            set({ hotkeys: rest })
            setCapturing(false)
            return
          }
          const accel = eventToAccel(e)
          if (accel) {
            set({ hotkeys: { ...settings.hotkeys, [action]: accel } })
            setCapturing(false)
          }
        }}
      >
        {capturing ? t('hk.press') : current}
      </button>
      {!isDefault && !capturing && (
        <button
          className="ghost"
          title={`${t('hk.reset')}: ${DEFAULT_HOTKEYS[action]}`}
          onClick={() => {
            const { [action]: _, ...rest } = settings.hotkeys
            set({ hotkeys: rest })
          }}
        >
          ⟲
        </button>
      )}
    </span>
  )
}

function HotkeysSection(): React.JSX.Element {
  const t = useT()
  const labels: Record<HotkeyAction, string> = {
    reconnect: t('hk.reconnect'),
    scrollLock: t('hk.scrollLock'),
    translit: t('hk.translit'),
    resendLast: t('hk.resendLast')
  }
  const builtin: [string, string][] = [
    ['Enter', t('hk.fixed.send')],
    ['Shift+Enter', t('hk.fixed.newline')],
    ['Tab', t('hk.fixed.autocomplete')],
    ['↑ / ↓', t('hk.fixed.history')],
    ['Ctrl+🖱 wheel', t('hk.fixed.zoom')],
    ['Ctrl+Z / Ctrl+Shift+Z / Ctrl+C / Ctrl+V', t('hk.fixed.native')]
  ]
  return (
    <div>
      <p className="hint" style={{ color: 'var(--text-faint)', marginTop: 0 }}>
        {t('hk.hint')}
      </p>
      {EDITABLE_HOTKEYS.map((a) => (
        <div key={a} className="set-row">
          <label>{labels[a]}</label>
          <HotkeyInput action={a} />
        </div>
      ))}
      <div className="set-group-title" style={{ marginTop: 20 }}>
        {t('hk.builtin')}
      </div>
      {builtin.map(([keys, desc]) => (
        <div key={keys} className="set-row">
          <label>{desc}</label>
          <span className="hotkey-fixed">{keys}</span>
        </div>
      ))}
    </div>
  )
}

function AdvancedSection(): React.JSX.Element {
  const t = useT()
  const clientId = useSettingsStore((s) => s.clientId)
  const setClientId = useSettingsStore((s) => s.setClientId)
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)

  return (
    <div>
      <div className="set-row" title={t('hint.clientId')}>
        <label>{t('set.clientId')}</label>
        <input style={{ width: 260 }} value={clientId} spellCheck={false} onChange={(e) => setClientId(e.target.value.trim())} />
      </div>
      <div className="set-row" title={t('hint.msgLimit')}>
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
    </div>
  )
}

function AboutSection(): React.JSX.Element {
  const t = useT()
  const [version, setVersion] = useState('')
  const [logOpen, setLogOpen] = useState(false)

  useEffect(() => {
    window.sticki.getVersion().then(setVersion)
  }, [])

  return (
    <div>
      <div className="set-row">
        <label>
          <b>StickiChat</b> · {t('set.version')} v{version}
        </label>
        <button onClick={() => window.sticki.checkForUpdates()}>{t('set.checkUpdates')}</button>
      </div>
      <div className="set-row">
        <label>
          {t('about.developer')}: <b>{DEVELOPER}</b>
        </label>
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <button onClick={() => window.sticki.openExternal(TWITCH_PROFILE)}>💜 {t('about.twitch')}</button>
        </span>
      </div>
      <div className="set-row">
        <label>{t('about.feedbackHint')}</label>
        <button onClick={() => window.sticki.openExternal(GITHUB_ISSUES)}>🐞 {t('about.github')}</button>
      </div>
      <div className="set-group-title" style={{ marginTop: 20 }}>
        {t('about.changelog')}
      </div>
      <button className="ghost" onClick={() => setLogOpen((v) => !v)}>
        {logOpen ? '▲' : '▼'} {t('about.changelog')}
      </button>
      {logOpen && (
        <div className="changelog">
          {CHANGELOG.map((entry) => (
            <div key={entry.version} className="changelog-entry">
              <div className="changelog-version">
                v{entry.version} <span className="hint">· {entry.date}</span>
              </div>
              <ul>
                {entry.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
