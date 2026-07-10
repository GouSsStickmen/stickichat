import { IrcClient, IrcMessage, parseIrcLine } from '../lib/irc'
import { ChatMessage, Account } from '../types'
import { useChatStore } from '../store/chat'
import { useLayoutStore, allOpenChannels } from '../store/layout'
import { useSettingsStore } from '../store/settings'
import { formatDuration } from '../lib/tokenize'
import { fetchRecentMessages } from '../lib/recentMessages'
import { loadChannelBadges, loadChannelEmotes, loadGlobalBadges, loadGlobalEmotes } from './emoteService'
import { ensureFreshToken } from '../lib/twitchAuth'
import { translate } from '../i18n'
import { useAccountsStore } from '../store/accounts'
import { playMentionSound, playFirstMessageSound, playKeywordSound } from '../lib/sound'
import { getLiveChannels, getUsers } from '../lib/helix'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Chat architecture:
 *  - ONE anonymous reader connection joined to every open channel. It is the
 *    single source of truth for displayed messages, so even our own messages
 *    arrive with real server message ids (required to delete own messages).
 *  - Per-account sender connections created lazily, used only for PRIVMSG.
 */
class ChatService {
  private reader: IrcClient | null = null
  private senders = new Map<string, IrcClient>() // accountId -> client
  private pendingByChannel = new Map<string, ChatMessage[]>()
  private flushTimer: number | null = null
  private historyLoaded = new Set<string>()
  /**
   * channel -> logins that already wrote during the CURRENT STREAM. Reset when a new stream
   * starts; persisted per stream so an app restart mid-stream doesn't re-ping everyone.
   */
  private seenThisSession = new Map<string, Set<string>>()
  /** channel -> started_at of the stream whose first-messages we're tracking */
  private streamStartedAt = new Map<string, string>()
  private started = false

  start(): void {
    if (this.started) return
    this.started = true

    this.reader = new IrcClient({
      nick: 'anon',
      onMessage: (m) => this.handleReaderMessage(m),
      onOpen: () => useChatStore.getState().setConnState('open'),
      onClose: () => useChatStore.getState().setConnState('closed')
    })

    // keep reader joins in sync with open panes
    let prev: string[] = []
    const sync = (): void => {
      const channels = allOpenChannels(useLayoutStore.getState().tabs)
      for (const ch of channels) {
        if (!this.reader!.isJoined(ch)) {
          this.reader!.join(ch)
          this.onChannelOpened(ch)
        }
      }
      for (const ch of prev) {
        if (!channels.includes(ch)) {
          this.reader!.part(ch)
          this.historyLoaded.delete(ch)
          this.seenThisSession.delete(ch)
          useChatStore.getState().dropChannel(ch)
        }
      }
      prev = channels
    }
    useLayoutStore.subscribe(sync)
    sync()
    loadGlobalEmotes()
    loadGlobalBadges()

    this.pollLive()
    window.setInterval(() => this.pollLive(), 60000)

    // mod status can change while the app is closed — refresh the cached list once per launch,
    // otherwise the chatters list silently falls back to "recently active" on channels where
    // the user actually IS a moderator
    import('./accountService').then(({ refreshModeratedChannels }) => {
      for (const a of useAccountsStore.getState().accounts) refreshModeratedChannels(a.id)
    })
  }

  /** which open channels are currently streaming (for tab/pane indicators) */
  private async pollLive(): Promise<void> {
    const account = useAccountsStore.getState().accounts[0]
    if (!account) return
    const channels = allOpenChannels(useLayoutStore.getState().tabs)
    if (channels.length === 0) {
      useChatStore.getState().setLiveChannels({})
      return
    }
    try {
      const live = await getLiveChannels(account, channels)
      for (const ch of channels) {
        const startedAt = live.get(ch)?.startedAt
        if (startedAt && this.streamStartedAt.get(ch) !== startedAt) {
          this.streamStartedAt.set(ch, startedAt)
          this.onStreamStarted(ch, startedAt)
        }
        if (!startedAt) this.streamStartedAt.delete(ch)
      }
      useChatStore
        .getState()
        .setLiveChannels(Object.fromEntries(channels.map((c) => [c, live.has(c)])))
      useChatStore.getState().setStreamInfo(
        Object.fromEntries(
          channels.flatMap((c) => {
            const info = live.get(c)
            return info ? [[c, { viewers: info.viewers, title: info.title, startedAt: info.startedAt }]] : []
          })
        )
      )
      this.resolveChannelNames(account, channels)
    } catch {
      /* keep previous state */
    }
  }

  private channelNamesRequested = new Set<string>()

  /** broadcaster display names (proper capitalization) for tab/pane titles */
  private async resolveChannelNames(account: Account, channels: string[]): Promise<void> {
    const known = useChatStore.getState().channelNames
    const missing = channels.filter((c) => !known[c] && !this.channelNamesRequested.has(c))
    if (missing.length === 0) return
    missing.forEach((c) => this.channelNamesRequested.add(c))
    try {
      const users = await getUsers(account, { logins: missing })
      const names: Record<string, string> = {}
      for (const u of users) names[u.login.toLowerCase()] = u.display_name
      if (Object.keys(names).length) useChatStore.getState().setChannelNames(names)
    } finally {
      // allow a retry for logins that failed to resolve
      missing.forEach((c) => {
        if (!useChatStore.getState().channelNames[c]) this.channelNamesRequested.delete(c)
      })
    }
  }

  private firstSeenKey(channel: string): string {
    return `sticki:firstSeen:${channel}`
  }

  /**
   * A stream (етер) just started — or we just learned about the current one after a restart.
   * "First message" is per-stream: same stream after a restart restores who already wrote;
   * a genuinely new stream starts with a clean slate so everyone pings once again.
   */
  private onStreamStarted(channel: string, startedAt: string): void {
    try {
      const raw = localStorage.getItem(this.firstSeenKey(channel))
      const saved = raw ? (JSON.parse(raw) as { startedAt: string; logins: string[] }) : null
      if (saved?.startedAt === startedAt) {
        this.seenThisSession.set(channel, new Set(saved.logins))
        return
      }
    } catch {
      /* corrupt cache — treat as new stream */
    }
    this.seenThisSession.set(channel, new Set())
    try {
      localStorage.setItem(this.firstSeenKey(channel), JSON.stringify({ startedAt, logins: [] }))
    } catch {
      /* best-effort */
    }
  }

  private persistFirstSeen(channel: string): void {
    const startedAt = this.streamStartedAt.get(channel)
    const seen = this.seenThisSession.get(channel)
    if (!startedAt || !seen) return
    try {
      localStorage.setItem(
        this.firstSeenKey(channel),
        JSON.stringify({ startedAt, logins: [...seen] })
      )
    } catch {
      /* best-effort */
    }
  }

  private onChannelOpened(channel: string): void {
    const { settings, } = useSettingsStore.getState()
    if (settings.loadHistory && !this.historyLoaded.has(channel)) {
      this.historyLoaded.add(channel)
      fetchRecentMessages(channel).then((lines) => {
        const msgs: ChatMessage[] = []
        for (const line of lines) {
          const parsed = parseIrcLine(line)
          if (!parsed) continue
          if (parsed.command === 'PRIVMSG') {
            const m = this.privmsgToChatMessage(parsed)
            if (m) {
              m.historical = true
              msgs.push(m)
            }
          }
        }
        if (msgs.length) useChatStore.getState().prependMessages(channel, msgs)
      })
    }
  }

  // ---------- incoming ----------

  private handleReaderMessage(m: IrcMessage): void {
    switch (m.command) {
      case 'PRIVMSG': {
        const msg = this.privmsgToChatMessage(m)
        if (msg) {
          let seen = this.seenThisSession.get(msg.channel)
          if (!seen) {
            seen = new Set()
            this.seenThisSession.set(msg.channel, seen)
          }
          if (!seen.has(msg.login)) {
            seen.add(msg.login)
            msg.isFirstInSession = true
            this.persistFirstSeen(msg.channel)
          }
          const myLogins = useAccountsStore.getState().accounts.map((a) => a.login.toLowerCase())
          if (msg.replyParent && myLogins.includes(msg.replyParent.login.toLowerCase())) {
            msg.replyToMe = true
            msg.isMention = true
          }
          this.detectMention(msg)
          this.maybePlayFirstSeenSound(msg)
          this.markUnreadIfInactive(msg.channel)
          this.queue(msg.channel, msg)
        }
        break
      }
      case 'ROOMSTATE': {
        const id = m.tags['room-id']
        if (id && m.channel) {
          useChatStore.getState().setChannelId(m.channel, id)
          loadChannelEmotes(m.channel, id)
          loadChannelBadges(m.channel, id)
        }
        break
      }
      case 'CLEARCHAT': {
        const channel = m.channel
        const lang = useSettingsStore.getState().settings.language
        if (m.trailing) {
          // targeted: trailing = login of the timed out / banned user
          const userId = m.tags['target-user-id']
          if (userId) useChatStore.getState().markUserMessagesDeleted(channel, userId)
          const dur = m.tags['ban-duration']
          const text = dur
            ? translate(lang, 'misc.timedOut', { user: m.trailing, duration: formatDuration(parseInt(dur, 10)) })
            : translate(lang, 'misc.banned', { user: m.trailing })
          this.queue(channel, this.systemMessage(channel, text))
        } else {
          useChatStore.getState().clearChannel(channel)
          this.queue(channel, this.systemMessage(channel, translate(lang, 'misc.chatCleared')))
        }
        break
      }
      case 'CLEARMSG': {
        const id = m.tags['target-msg-id']
        if (id && m.channel) useChatStore.getState().markDeleted(m.channel, id)
        break
      }
      case 'USERNOTICE': {
        // subs, resubs, raids, announcements...
        const sysText = this.usernoticeText(m)
        const msg = this.privmsgToChatMessage(m)
        if (msg) {
          msg.system = 'usernotice'
          msg.systemText = sysText
          if (m.tags['msg-id'] === 'announcement') {
            msg.announceColor = (m.tags['msg-param-color'] || 'PRIMARY').toLowerCase()
          }
          this.queue(m.channel, msg)
        } else if (m.channel && sysText) {
          this.queue(m.channel, this.systemMessage(m.channel, sysText))
        }
        break
      }
      case 'NOTICE': {
        if (m.channel && m.trailing) {
          this.queue(m.channel, this.systemMessage(m.channel, m.trailing))
        }
        break
      }
    }
  }

  /**
   * Human-readable text for USERNOTICE events. Twitch's system-msg is always English —
   * with the Ukrainian locale we build our own accented strings from the tags instead.
   */
  private usernoticeText(m: IrcMessage): string {
    const en = m.tags['system-msg'] || m.tags['msg-id'] || ''
    if (useSettingsStore.getState().settings.language !== 'uk') return en
    const id = m.tags['msg-id']
    const name = m.tags['display-name'] || m.tags['login'] || ''
    const months = m.tags['msg-param-cumulative-months']
    const streak = m.tags['msg-param-streak-months']
    const tier = (m.tags['msg-param-sub-plan'] ?? '').replace('Prime', 'Prime').replace('1000', 'T1').replace('2000', 'T2').replace('3000', 'T3')
    switch (id) {
      case 'sub':
        return `⭐ ${name} оформив підписку (${tier || 'T1'})!`
      case 'resub': {
        const base = `⭐ ${name} продовжив підписку (${tier || 'T1'}) — ${months || '?'} міс.`
        return m.tags['msg-param-should-share-streak'] === '1' && streak
          ? `${base} 🔥 Стрик: ${streak} міс. поспіль!`
          : `${base}`
      }
      case 'subgift':
        return `🎁 ${name} подарував підписку для ${m.tags['msg-param-recipient-display-name'] || '?'} (${tier || 'T1'})!`
      case 'submysterygift':
        return `🎁 ${name} дарує ${m.tags['msg-param-mass-gift-count'] || '?'} підписок чату!`
      case 'giftpaidupgrade':
      case 'primepaidupgrade':
        return `⭐ ${name} перейшов на платну підписку!`
      case 'raid':
        return `🚨 РЕЙД! ${m.tags['msg-param-displayName'] || name} привів ${m.tags['msg-param-viewerCount'] || '?'} глядачів!`
      case 'unraid':
        return `↩️ Рейд скасовано`
      case 'announcement':
        return ''
      case 'bitsbadgetier':
        return `💎 ${name} отримав новий рівень біт-бейджа!`
      case 'communitypayforward':
        return `💜 ${name} передає подарунок далі!`
      case 'standardpayforward':
        return `💜 ${name} передає подарунок далі!`
      case 'highlighted-message':
        return `⭐ Виділене повідомлення`
      default:
        return en
    }
  }

  private privmsgToChatMessage(m: IrcMessage): ChatMessage | null {
    if (!m.channel) return null
    let text = m.trailing
    let isAction = false
    // /me messages arrive as \x01ACTION text\x01
    if (text.startsWith('\x01ACTION ') && text.endsWith('\x01')) {
      text = text.slice(8, -1)
      isAction = true
    }
    const badges = (m.tags['badges'] ?? '')
      .split(',')
      .filter(Boolean)
      .map((b) => {
        const i = b.indexOf('/')
        return { setId: b.slice(0, i), version: b.slice(i + 1) }
      })
    const login = m.tags['login'] || m.nick
    if (!login) return null
    const replyLogin = m.tags['reply-parent-user-login']
    return {
      id: m.tags['id'] ?? `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      channel: m.channel,
      channelId: m.tags['room-id'] ?? '',
      userId: m.tags['user-id'] ?? '',
      login,
      displayName: m.tags['display-name'] || login,
      color: m.tags['color'] || undefined,
      badges,
      text,
      emotesTag: m.tags['emotes'] || undefined,
      timestamp: m.tags['tmi-sent-ts'] ? parseInt(m.tags['tmi-sent-ts'], 10) : Date.now(),
      isAction,
      isFirstMsg: m.tags['first-msg'] === '1',
      replyParent: replyLogin
        ? {
            login: replyLogin,
            displayName: m.tags['reply-parent-display-name'] || replyLogin,
            text: m.tags['reply-parent-msg-body'] ?? '',
            msgId: m.tags['reply-parent-msg-id'] || undefined
          }
        : undefined
    }
  }

  /** flags mentions of any of my accounts; plays a sound + marks the tab */
  private detectMention(msg: ChatMessage): void {
    const accounts = useAccountsStore.getState().accounts
    if (accounts.length === 0 || !msg.text) return
    const caseSensitive = useSettingsStore.getState().settings.caseSensitiveNicks
    const lower = msg.text.toLowerCase()
    const mentioned = accounts.some((a) => {
      if (msg.userId === a.id) return false // own messages don't count
      if (caseSensitive) {
        const name = escapeRegExp(a.displayName)
        return msg.text.includes(`@${a.displayName}`) || new RegExp(`(^|[^\\w])${name}([^\\w]|$)`).test(msg.text)
      }
      const l = a.login.toLowerCase()
      return lower.includes(`@${l}`) || new RegExp(`(^|[^\\w])${l}([^\\w]|$)`).test(lower)
    })
    if (!mentioned) {
      this.detectKeywords(msg)
      return
    }
    msg.isMention = true
    if (msg.historical) return

    const settings = useSettingsStore.getState().settings
    if (settings.mentionSound) playMentionSound(settings)

    // badge the tab unless the channel is visible in the active tab right now
    const { tabs, activeTabId } = useLayoutStore.getState()
    const activeChannels = tabs.find((t) => t.id === activeTabId)?.panes.map((p) => p.channel) ?? []
    if (!activeChannels.includes(msg.channel)) {
      useChatStore.getState().setUnreadMention(msg.channel)
    }
  }

  /** user-configured words/phrases that should alert like a mention */
  private detectKeywords(msg: ChatMessage): void {
    if (msg.historical || !msg.text) return
    // own messages never trigger keyword alerts
    if (useAccountsStore.getState().accounts.some((a) => a.id === msg.userId)) return
    const settings = useSettingsStore.getState().settings
    if (!settings.keywordSound || settings.keywordAlerts.length === 0) return
    const lower = msg.text.toLowerCase()
    const hit = settings.keywordAlerts.some((w) => {
      const needle = w.trim().toLowerCase()
      return needle.length > 0 && lower.includes(needle)
    })
    if (!hit) return
    msg.isMention = true // highlight it like a mention so it's visible in chat/sidebar
    playKeywordSound(settings)
  }

  /** lights up the tab (subtle, distinct from the @ mention dot) for any new message while inactive */
  private markUnreadIfInactive(channel: string): void {
    const { tabs, activeTabId } = useLayoutStore.getState()
    const activeChannels = tabs.find((t) => t.id === activeTabId)?.panes.map((p) => p.channel) ?? []
    if (!activeChannels.includes(channel)) {
      useChatStore.getState().setUnreadMessage(channel)
    } else {
      // the user is watching this channel right now — advance its "read up to" mark
      useChatStore.getState().markChannelsRead([channel])
    }
  }

  /** optional sound for someone's first message this stream — only for the ACTIVE tab */
  private maybePlayFirstSeenSound(msg: ChatMessage): void {
    if (!msg.isFirstInSession || msg.historical) return
    // don't ping yourself
    if (useAccountsStore.getState().accounts.some((a) => a.id === msg.userId)) return
    const settings = useSettingsStore.getState().settings
    if (!settings.firstMessageSound) return
    const { tabs, activeTabId } = useLayoutStore.getState()
    const activeChannels = tabs.find((t) => t.id === activeTabId)?.panes.map((p) => p.channel) ?? []
    if (!activeChannels.includes(msg.channel)) return
    playFirstMessageSound(settings)
  }

  private systemMessage(channel: string, text: string): ChatMessage {
    return {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      channel,
      channelId: '',
      userId: '',
      login: '',
      displayName: '',
      badges: [],
      text: '',
      timestamp: Date.now(),
      isAction: false,
      isFirstMsg: false,
      system: 'info',
      systemText: text
    }
  }

  /** batch store updates so message floods don't re-render per message */
  private queue(channel: string, msg: ChatMessage): void {
    const arr = this.pendingByChannel.get(channel) ?? []
    arr.push(msg)
    this.pendingByChannel.set(channel, arr)
    if (this.flushTimer === null) {
      this.flushTimer = window.setTimeout(() => this.flush(), 60)
    }
  }

  private flush(): void {
    this.flushTimer = null
    const store = useChatStore.getState()
    for (const [channel, msgs] of this.pendingByChannel) {
      store.appendMessages(channel, msgs)
    }
    this.pendingByChannel.clear()
  }

  // ---------- outgoing ----------

  async sendMessage(
    account: Account,
    channel: string,
    text: string,
    replyParentMsgId?: string
  ): Promise<void> {
    const clientId = useSettingsStore.getState().clientId
    const token = await ensureFreshToken(clientId, account)
    let sender = this.senders.get(account.id)
    if (!sender) {
      sender = new IrcClient({
        nick: account.login,
        token,
        onMessage: (m) => {
          // sender connections only care about being kicked / notices
          if (m.command === 'NOTICE' && m.channel) {
            this.queue(m.channel, this.systemMessage(m.channel, m.trailing))
          }
        }
      })
      this.senders.set(account.id, sender)
    }
    sender.join(channel)
    sender.say(channel, text, replyParentMsgId)
  }

  dropSender(accountId: string): void {
    this.senders.get(accountId)?.close()
    this.senders.delete(accountId)
  }

  /** force-reconnects the reader connection (F5 / manual "reconnect") */
  reconnect(): void {
    this.reader?.close()
    useChatStore.getState().setConnState('connecting')
    this.reader = new IrcClient({
      nick: 'anon',
      onMessage: (m) => this.handleReaderMessage(m),
      onOpen: () => useChatStore.getState().setConnState('open'),
      onClose: () => useChatStore.getState().setConnState('closed')
    })
    for (const ch of allOpenChannels(useLayoutStore.getState().tabs)) this.reader.join(ch)
  }
}

export const chatService = new ChatService()
