import { IrcClient, IrcMessage, parseIrcLine } from '../lib/irc'
import { ChatMessage, Account } from '../types'
import { useChatStore, lookupUserColor } from '../store/chat'
import { useLayoutStore, allOpenChannels } from '../store/layout'
import { useSettingsStore } from '../store/settings'
import { formatDuration } from '../lib/tokenize'
import { findTerm } from '../lib/keywordMatch'
import { fetchRecentMessages } from '../lib/recentMessages'
import { loadChannelBadges, loadChannelEmotes, loadCheermotes, loadGlobalBadges, loadGlobalEmotes } from './emoteService'
import { ensureFreshToken } from '../lib/twitchAuth'
import { translate, TranslationKey } from '../i18n'
import { useAccountsStore, getAccount } from '../store/accounts'
import { useUiStore } from '../store/ui'
import { useWhispersStore, getOpenWhisperThread } from '../store/whispers'
import {
  playMentionSound,
  playFirstMessageSound,
  playKeywordSound,
  playNickAlertSound,
  playStreamUpSound,
  playWhisperSound,
  playRaidSound,
  playHypeTrainStartSound,
  playHypeTrainLevelSound
} from '../lib/sound'
import { getLiveChannels, getUsers, getUserChatColors } from '../lib/helix'
import { EventSubClient, EventSubDesired } from '../lib/eventsub'
import { recordWatchStreak } from '../lib/watchStreaks'
import { hlIngest } from './hlAccumulator'

/** usernotice msg-ids that count as "sub events" for the highlights subs tab */
const SUB_EVENT_IDS = new Set([
  'sub', 'resub', 'subgift', 'submysterygift',
  'giftpaidupgrade', 'anongiftpaidupgrade', 'primepaidupgrade'
])
import { HypeTrainEvent, PollEvent, PubSubClient, RaidEvent, RedemptionEvent } from '../lib/pubsub'
import { diagInfo, diagWarn } from '../lib/diag'
import { queueWrite } from '../lib/lsWriter'

/**
 * Invisible U+E0000 (a Unicode TAG character): appended to a repeated message so Twitch
 * sees a different string and stops rejecting it as "identical to the previous one".
 * Chat clients render nothing for it — the same trick 7TV and Chatterino use.
 */
const DEDUPE_TAG = '\u{E0000}'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** persisted redemption record (localStorage) — replayed into reopened windows/restarts */
interface PersistedRedeem {
  id: string
  text: string
  ts: number
  login?: string
  name?: string
  color?: string
  title?: string
  cost?: number
  icon?: string
  input?: string
}

/**
 * Ukrainian counts three ways, and getting it wrong is what makes a translated app read as
 * translated: 1 рік, 2 роки, 5 років — and 11–14 take the last form even though they end in
 * 1–4.
 */
function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100
  const mod10 = mod100 % 10
  if (mod100 >= 11 && mod100 <= 14) return many
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
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
  private senderTokens = new Map<string, string>() // accountId -> token the sender logged in with
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
  /** "channel:login" -> active mass-gift group (individual subgifts collapse under it) */
  private mysteryGifts = new Map<string, { id: string; until: number }>()
  private eventSub: EventSubClient | null = null
  private pubSub: PubSubClient | null = null
  /** channels with an ACTIVE channel.moderate subscription (their bare IRC ban/timeout
   *  lines are suppressed — the full "who did it" lines replace them) */
  private modEventChannels = new Set<string>()
  /** channels we've polled at least once (so we don't fire a "went live" alert on startup) */
  private liveKnown = new Set<string>()
  /** channel -> was live at the previous poll */
  private wasLive = new Map<string, boolean>()
  private started = false
  /**
   * Alert sounds belong to exactly ONE window. Utility windows (highlights, user card,
   * detached chat) each run a full chatService — same reader, same PubSub, and each with its
   * own 2s throttle — so a mention or raid played once per open window. The main window owns
   * the audio; everything else stays silent.
   */
  private readonly ownsSound = !window.location.hash

  start(): void {
    if (this.started) return
    this.started = true

    this.reader = new IrcClient({
      nick: 'anon',
      onMessage: (m) => this.handleReaderMessage(m),
      onOpen: () => this.announceConnection(true),
      onClose: (silentFor) => this.announceConnection(false, silentFor)
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
          this.liveKnown.delete(ch)
          this.wasLive.delete(ch)
          useChatStore.getState().dropChannel(ch)
        }
      }
      prev = channels
      // channels changed — make sure raid + redemption subscriptions cover the new set
      this.eventSub?.resync()
      this.pubSub?.resync()
    }
    useLayoutStore.subscribe(sync)
    sync()
    loadGlobalEmotes()
    loadGlobalBadges()

    this.pollLive()
    window.setInterval(() => this.pollLive(), 60000)

    // mod status can change at any time (a broadcaster mods/unmods you mid-stream) — poll the
    // cached list so mod rights appear/disappear without an app restart. Main window only:
    // utility windows (user card, detached) also call start(), and their parallel refreshes
    // race the token rotation and produce spurious 401s
    const hash = window.location.hash
    const isMain = !hash
    if (isMain) {
      const refreshMods = (): void => {
        import('./accountService').then(({ refreshModeratedChannels }) => {
          for (const a of useAccountsStore.getState().accounts) refreshModeratedChannels(a.id)
        })
      }
      refreshMods()
      window.setInterval(refreshMods, 120000)
      // and immediately when the user returns to the window (they likely just got modded)
      window.addEventListener('focus', refreshMods)
      // when the moderated-channel set actually changes, resync EventSub so the mod feed +
      // shoutout subscriptions (which need moderator authorization) come online without a
      // restart — the layout-only `sync` above never fires on a pure mod-status change
      let modSig = ''
      useAccountsStore.subscribe(() => {
        const sig = useAccountsStore
          .getState()
          .accounts.map((a) => `${a.id}:${[...a.moderatedChannelIds].sort().join(',')}`)
          .join('|')
        if (sig === modSig) return
        modSig = sig
        this.eventSub?.resync()
      })
    }
    // EventSub carries what IRC no longer does: whispers, raids, the who-did-what mod feed.
    // Whisper/raid subs live in the main window only; the MOD FEED also runs in utility
    // windows that show chat (usercard/highlights/detached), each with its own store.
    if (isMain || hash.startsWith('#usercard') || hash.startsWith('#highlights') || hash.startsWith('#detached')) {
      this.eventSub = new EventSubClient(
        () => this.desiredEventSubs(isMain),
        (type, event, envelopeId) => this.handleEventSub(type, event, envelopeId),
        (desired, status) => this.onEventSubError(desired, status),
        (desired) => {
          // it worked, so the next failure is news again rather than a repeat
          this.subErrorSeen.delete(desired.key)
          // suppress duplicate IRC lines only once the rich mod feed is REALLY active
          if (desired.type === 'channel.moderate' && desired.channelLogin) {
            this.modEventChannels.add(desired.channelLogin)
          }
        }
      )
    }
    // PubSub gives us channel-point redemptions (incl. message-less ones) with full reward
    // names, which no viewer-token EventSub subscription can — same trick Chatterino uses.
    // Runs in the main window AND the standalone highlights window (its redeems tab).
    if (!window.location.hash || window.location.hash.startsWith('#highlights')) {
      this.pubSub = new PubSubClient(
        () => useAccountsStore.getState().accounts.find((a) => a._accessToken),
        () => {
          const ids = useChatStore.getState().channelIds
          return allOpenChannels(useLayoutStore.getState().tabs)
            .map((ch) => ids[ch])
            .filter(Boolean)
        },
        (e) => this.handleRedemption(e),
        (e) => this.handlePubSubRaid(e),
        (e) => this.handlePollStart(e),
        (e) => this.relayHypeTrain(e)
      )
    }
    // A chat popped into its own window is a separate renderer with no PubSub of its own, so
    // the train would ride only in the main window while the window you are actually watching
    // showed nothing. The socket owner relays every event through localStorage; the others
    // replay it into their own stores and announce it for the channels THEY have open.
    if (hash.startsWith('#detached')) {
      window.addEventListener('storage', (ev) => {
        if (ev.key !== ChatService.HYPE_RELAY || !ev.newValue) return
        try {
          this.handleHypeTrain(JSON.parse(ev.newValue) as HypeTrainEvent)
        } catch {
          /* malformed relay payload */
        }
      })
    }
  }

  /** message-carrying redemptions: raw PRIVMSG held/dropped so only ONE styled line shows */
  private redeemSuppress = new Map<string, number>()
  private pendingRedeemMsgs = new Map<string, ChatMessage>()
  private maybeHoldRedeemPrivmsg(msg: ChatMessage): boolean {
    // PubSub (which delivers the reward name) runs in the main window only
    if (window.location.hash) return false
    if (!msg.redeemed || !msg.text || msg.historical) return false
    if (!useSettingsStore.getState().settings.showRedeems) return false
    const key = `${msg.channel}:${msg.login}:${(msg.text ?? '').trim()}`
    const sup = this.redeemSuppress.get(key)
    if (sup && Date.now() - sup < 8000) {
      this.redeemSuppress.delete(key)
      return true // the styled PubSub line is already in chat — drop the raw duplicate
    }
    // hold briefly: when PubSub delivers the styled line within the window, the raw
    // message is dropped; otherwise it shows after all (PubSub missed/offline)
    this.pendingRedeemMsgs.set(key, msg)
    window.setTimeout(() => {
      const held = this.pendingRedeemMsgs.get(key)
      if (!held) return
      this.pendingRedeemMsgs.delete(key)
      // belt-and-braces: if a styled redeem line with this text ALREADY landed in the
      // buffer (key mismatch, races), still drop the raw copy
      const recent = useChatStore.getState().messages[held.channel]?.slice(-40) ?? []
      const dup = recent.some(
        (m) =>
          m.redeemed && m.rewardTitle && m.login === held.login && (m.text ?? '').trim() === (held.text ?? '').trim()
      )
      if (dup) return
      this.markUnreadIfInactive(held.channel)
      this.queue(held.channel, held)
    }, 1500)
    return true
  }

  /** "channel:target" raids we've already announced/prompted (PubSub + EventSub overlap) */
  private raidAnnounced = new Map<string, number>()
  private shoutoutAnnounced = new Map<string, number>()
  /** "channel:login" follows already recorded — EventSub redelivers */
  private followSeen = new Map<string, number>()

  /** outgoing raid seen on PubSub — catches raids started from the Twitch page instantly */
  private handlePubSubRaid(e: RaidEvent): void {
    const ids = useChatStore.getState().channelIds
    const channel = Object.keys(ids).find((login) => ids[login] === e.channelId)
    if (!channel) return
    const key = `${channel}:${e.targetLogin}`
    if (e.kind === 'cancel') {
      // aborted raid: forget it, so the NEXT raid to the same target prompts again
      this.raidAnnounced.delete(key)
      useUiStore.getState().setChannelPrompt(null)
      return
    }
    // the countdown repeats raid_update every second — announce only once per raid,
    // but a fresh raid after go/cancel prompts again (short 2-minute window)
    const last = this.raidAnnounced.get(key) ?? 0
    if (Date.now() - last < 2 * 60_000) {
      this.raidAnnounced.set(key, Date.now()) // keep the window sliding during the countdown
      return
    }
    this.raidAnnounced.set(key, Date.now())
    const lang = useSettingsStore.getState().settings.language
    this.localInfo(channel, translate(lang, 'info.raidStart', { target: e.targetDisplay, count: '…' }))
    this.promptAddChannel(channel, e.targetLogin)
  }

  /** a poll or prediction just started — announce it with an info line in that chat */
  private handlePollStart(e: PollEvent): void {
    // the standalone highlights window shares the PubSub client — only the main window announces
    if (window.location.hash) return
    const ids = useChatStore.getState().channelIds
    const channel = Object.keys(ids).find((login) => ids[login] === e.channelId)
    if (!channel) return
    const lang = useSettingsStore.getState().settings.language
    const key = e.kind === 'prediction' ? 'info.predictionStart' : 'info.pollStart'
    this.localInfo(channel, translate(lang, key, { title: e.title, choices: e.choices.join(' · ') }))
  }

  /** level of the train we last announced, per channel — progression fires per contribution */
  private hypeLevel = new Map<string, number>()
  /** localStorage key the PubSub owner writes so other windows see the same train */
  private static readonly HYPE_RELAY = 'sticki:hypeTrain'

  /** pass the event to the other windows, then handle it here */
  private relayHypeTrain(e: HypeTrainEvent): void {
    // the highlights window runs a PubSub client too; if it relayed as well, every detached
    // window would get each event twice
    if (window.location.hash) return this.handleHypeTrain(e)
    try {
      // the value has to differ every time or the storage event does not fire twice in a row
      localStorage.setItem(ChatService.HYPE_RELAY, JSON.stringify({ ...e, at: Date.now() }))
    } catch {
      /* storage full or unavailable — the main window still gets its train */
    }
    this.handleHypeTrain(e)
  }

  /**
   * A hype train in one of the open channels.
   *
   * Three separate things, each behind its own switch: an info line in that chat, a sound, and
   * the floating popup with the live level. `progression` arrives on EVERY contribution, so the
   * chat line and the sound are tied to the LEVEL changing — the popup takes every update,
   * because that is what makes its bar move.
   */
  private handleHypeTrain(e: HypeTrainEvent): void {
    // the standalone highlights window shares the PubSub client but shows no chat — it would
    // announce into a buffer nobody reads. The main window and popped-out chats do announce,
    // each for the channels it has open.
    const hash = window.location.hash
    if (hash && !hash.startsWith('#detached')) return
    const ids = useChatStore.getState().channelIds
    const channel = Object.keys(ids).find((login) => ids[login] === e.channelId)
    if (!channel) return
    const settings = useSettingsStore.getState().settings
    const lang = settings.language
    const ui = useUiStore.getState()

    if (e.kind === 'end') {
      const level = this.hypeLevel.get(channel) ?? 0
      this.hypeLevel.delete(channel)
      diagInfo('hype', `${channel}: train over at level ${level} (${e.endReason})`)
      if (settings.hypeTrainLine && level > 0) {
        this.localInfo(channel, translate(lang, 'info.hypeEnd', { level: String(level) }))
      }
      // this train is over, so a dismissal of ITS popup expires with it — the next train is
      // news again and gets announced normally
      if (ui.hypeDismissed === channel) ui.allowHypeTrain()
      // leave the popup up for a moment on the result, then let it go
      if (ui.hypeTrain?.channel === channel) {
        ui.setHypeTrain({ ...ui.hypeTrain, ended: e.endReason ?? 'EXPIRE' })
        window.setTimeout(() => {
          const cur = useUiStore.getState().hypeTrain
          if (cur?.channel === channel && cur.ended) useUiStore.getState().setHypeTrain(null)
        }, 8000)
      }
      return
    }

    const prev = this.hypeLevel.get(channel) ?? 0
    const climbed = e.level > prev
    this.hypeLevel.set(channel, e.level)

    if (settings.hypeTrainPopup) {
      ui.setHypeTrain({
        channel,
        flavour: e.flavour,
        level: e.level,
        value: e.value,
        goal: Math.max(1, e.goal),
        expiresAt: e.expiresAt,
        by: e.userDisplay
      })
    }
    if (!climbed) return
    diagInfo('hype', `${channel}: level ${e.level} (${e.value}/${e.goal})`)
    if (settings.hypeTrainLine) {
      const key = prev === 0 ? 'info.hypeStart' : 'info.hypeLevel'
      this.localInfo(channel, translate(lang, key, { level: String(e.level) }))
    }
    /**
     * A train in a channel you are not looking at is news you may or may not want announced.
     *
     * With thirty channels open, a train is running somewhere most of the time, and a chime for
     * every level of every one of them is noise rather than information. Off by default for
     * channels whose tab is not in front; the channel you ARE watching always sounds.
     */
    const { tabs, activeTabId } = useLayoutStore.getState()
    const onScreen = (tabs.find((t) => t.id === activeTabId)?.panes ?? []).some(
      (p) => p.channel === channel
    )
    // departure and a level-up are different moments, so they get different sounds
    const mayInterrupt = onScreen || settings.hypeTrainInactiveKinds.includes(e.flavour)
    if (settings.hypeTrainSound && mayInterrupt) {
      if (prev === 0) playHypeTrainStartSound(settings)
      else playHypeTrainLevelSound(settings)
    }
  }

  /** a channel-point redemption from PubSub — announce it with the real reward name/cost */
  private handleRedemption(e: RedemptionEvent): void {
    if (!useSettingsStore.getState().settings.showRedeems) return
    // map the broadcaster id back to the open channel login
    const ids = useChatStore.getState().channelIds
    const channel = Object.keys(ids).find((login) => ids[login] === e.channelId)
    if (!channel) return
    const lang = useSettingsStore.getState().settings.language
    const text = translate(lang, 'info.redeem', {
      user: e.userDisplay,
      reward: e.rewardTitle,
      cost: String(e.rewardCost)
    })
    const full = e.userInput ? `${text}: ${e.userInput}` : text
    const msg = this.systemMessage(channel, full)
    msg.id = `redeem-${e.id}`
    msg.redeemed = true
    // structured reward data so the chat line can render the points icon + reward name + cost
    msg.rewardTitle = e.rewardTitle
    msg.rewardCost = e.rewardCost
    msg.rewardIcon = e.rewardIcon
    msg.text = e.userInput ?? ''
    // who redeemed — with their Twitch chat color (from the local buffer when known),
    // so the highlights panel can render the nick properly
    msg.login = e.userLogin
    msg.displayName = e.userDisplay
    msg.color = lookupUserColor(channel, e.userLogin)
    if (e.userInput) {
      // pair up with the raw PRIVMSG copy of this redemption (either direction of the race)
      const key = `${channel}:${e.userLogin}:${e.userInput.trim()}`
      if (this.pendingRedeemMsgs.has(key)) this.pendingRedeemMsgs.delete(key)
      else this.redeemSuppress.set(key, Date.now())
    }
    this.queue(channel, msg)
    this.persistRedeem(channel, msg)
  }

  /**
   * Redemption lines exist only in the window that received the PubSub event — persist them
   * so the highlights window (or a restart) can replay recent ones instead of starting empty.
   */
  private redeemKey(channel: string): string {
    return `sticki:redeems:${channel}`
  }

  private persistRedeem(channel: string, msg: ChatMessage): void {
    try {
      const raw = localStorage.getItem(this.redeemKey(channel))
      const list = raw ? (JSON.parse(raw) as PersistedRedeem[]) : []
      if (list.some((r) => r.id === msg.id)) return // the other window already wrote it
      list.push({
        id: msg.id,
        text: msg.systemText ?? '',
        ts: msg.timestamp,
        login: msg.login,
        name: msg.displayName,
        color: msg.color,
        title: msg.rewardTitle,
        cost: msg.rewardCost,
        icon: msg.rewardIcon,
        input: msg.text
      })
      localStorage.setItem(this.redeemKey(channel), JSON.stringify(list.slice(-100)))
    } catch {
      /* best-effort */
    }
  }

  private loadPersistedRedeems(channel: string): ChatMessage[] {
    try {
      const raw = localStorage.getItem(this.redeemKey(channel))
      const list = raw ? (JSON.parse(raw) as PersistedRedeem[]) : []
      return list.map((r) => {
        const msg = this.systemMessage(channel, r.text)
        msg.id = r.id
        msg.timestamp = r.ts
        msg.redeemed = true
        msg.historical = true
        msg.login = r.login ?? ''
        msg.displayName = r.name ?? ''
        msg.color = r.color
        msg.rewardTitle = r.title
        msg.rewardCost = r.cost
        msg.rewardIcon = r.icon
        msg.text = r.input ?? ''
        return msg
      })
    } catch {
      return []
    }
  }

  /** a subscription was rejected — the common cause is an account authorized before the
   *  whisper scope existed, so surface a single actionable hint instead of failing silently */
  private eventSubErrorShown = false
  private modSubErrorShown = false
  private subErrorSeen = new Map<string, number>()
  private onEventSubError(desired: EventSubDesired, status: number): void {
    const lang = useSettingsStore.getState().settings.language
    /*
     * A channel is marked as having the rich mod feed when its subscription succeeds, and the plain
     * IRC "X was banned" line is suppressed there to avoid saying it twice. Nothing ever unmarked it
     * on the way back down — so once a later resubscribe failed, usually with the 429 that means the
     * account's websocket subscription budget is spent, both lines were gone: the rich one never
     * arrived and the plain one was still being hidden for its sake. Moderation appeared to do
     * nothing at all.
     */
    if (desired.type === 'channel.moderate' && desired.channelLogin) {
      this.modEventChannels.delete(desired.channelLogin)
    }
    // Every rejection is worth a line — a report that says "feature X does nothing" is
    // answerable at once if the log says X was never subscribed. Every rejection of the SAME
    // thing for the same reason is not: with a subscription per open channel, one rate limit
    // wrote a line per channel per retry until the file was nothing else. Once per key per
    // status, and a recovery clears it so the next spell is reported again.
    if (this.subErrorSeen.get(desired.key) === status) return
    this.subErrorSeen.set(desired.key, status)
    diagWarn('eventsub', `${desired.type} rejected for ${desired.account.login}: HTTP ${status}`)
    if (desired.type === 'user.whisper.message') {
      if (this.eventSubErrorShown) return
      this.eventSubErrorShown = true
      // a scope/permission problem (401/403) is fixable by re-auth; show that hint. Any other
      // status is unexpected — surface the code so it can actually be diagnosed.
      if (status === 401 || status === 403) {
        useUiStore.getState().toast(translate(lang, 'whisper.needReauth', { login: desired.account.login }), 'error')
      } else {
        useUiStore.getState().toast(translate(lang, 'whisper.subFail', { status: String(status), login: desired.account.login }), 'error')
      }
    } else if (desired.type === 'channel.moderate' && (status === 401 || status === 403)) {
      if (this.modSubErrorShown) return
      this.modSubErrorShown = true
      useUiStore.getState().toast(translate(lang, 'modact.needReauth', { login: desired.account.login }), 'error')
    } else if (status === 429 && desired.channelLogin) {
      /*
       * Say it out loud, in the channel it happened to.
       *
       * Twitch caps the total cost of one account's websocket subscriptions, and with several
       * channels open — or the same account signed in on a second device — that cap is reached and
       * stays reached. The retry with backoff is already running, but until it wins, follows do not
       * arrive, the mod feed is silent, raids go unannounced, and nothing anywhere says why. The
       * feature simply looks broken, intermittently, which is the hardest kind of thing to report.
       *
       * Once per channel per session: a line, not a stream of them.
       */
      if (this.subLimitShown.has(desired.channelLogin)) return
      this.subLimitShown.add(desired.channelLogin)
      this.localInfo(desired.channelLogin, translate(lang, 'info.subLimit', { type: desired.type }))
    }
  }

  /** channels already told that Twitch's subscription budget is full — one notice each */
  private subLimitShown = new Set<string>()

  /** whisper (per account, main only) + raid-out + mod-feed subscriptions for this session */
  private desiredEventSubs(includeGlobal: boolean): EventSubDesired[] {
    const accounts = useAccountsStore.getState().accounts
    const out: EventSubDesired[] = []
    if (includeGlobal) {
      for (const a of accounts) {
        if (!a._accessToken) continue
        out.push({ account: a, type: 'user.whisper.message', version: '1', condition: { user_id: a.id }, key: `whisper:${a.id}` })
      }
    }
    const auth = accounts.find((a) => a._accessToken)
    const ids = useChatStore.getState().channelIds
    const open = allOpenChannels(useLayoutStore.getState().tabs)
    for (const ch of open) {
      const cid = ids[ch]
      if (!cid) continue // learned from ROOMSTATE shortly after join; resync() picks it up
      if (auth && includeGlobal) {
        out.push({
          account: auth,
          type: 'channel.raid',
          version: '1',
          condition: { from_broadcaster_user_id: cid },
          key: `raid:${cid}`
        })
      }
      // full moderation feed ("who banned/deleted whom") for channels one of my accounts mods
      const modAccount = accounts.find(
        (a) => a._accessToken && (a.moderatedChannelIds.includes(cid) || a.login.toLowerCase() === ch)
      )
      if (modAccount) {
        out.push({
          account: modAccount,
          type: 'channel.moderate',
          version: '2',
          condition: { broadcaster_user_id: cid, moderator_user_id: modAccount.id },
          key: `mod:${cid}`,
          channelLogin: ch
        })
        // shoutouts GIVEN in this channel — surface who was shouted out + offer to open them
        out.push({
          account: modAccount,
          type: 'channel.shoutout.create',
          version: '1',
          condition: { broadcaster_user_id: cid, moderator_user_id: modAccount.id },
          key: `sho:${cid}`,
          channelLogin: ch
        })
        /**
         * Follows, but only when something is actually listening for them.
         *
         * A follow leaves no trace in chat, so this subscription is the only place the app can
         * learn about one — a follower goal, the chat announcement, the events panel and a follow
         * overlay all depend on it. It stays demand-driven because every subscription is a real
         * socket topic, and nobody needs a follow feed for a channel they merely moderate.
         */
        const s = useSettingsStore.getState()
        const wantsFollows =
          s.settings.announceFollows ||
          s.highlightRules.some((r) => r.enabled && r.kind === 'follow') ||
          s.settings.chatOverlays.some(
            (o) =>
              (o.type === 'goal' && o.metric === 'followers' && (o.channel ? o.channel.toLowerCase() === ch : true)) ||
              (o.type === 'follow' && (o.channel ? o.channel.toLowerCase() === ch : true))
          )
        if (wantsFollows) {
          out.push({
            account: modAccount,
            type: 'channel.follow',
            version: '2',
            condition: { broadcaster_user_id: cid, moderator_user_id: modAccount.id },
            key: `follow:${cid}`,
            channelLogin: ch
          })
        }
      }
    }
    return out
  }

  /** dispatch an EventSub event to the right handler */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleEventSub(type: string, event: Record<string, any>, envelopeId = ''): void {
    if (type === 'user.whisper.message') {
      const account = useAccountsStore.getState().accounts.find((a) => a.id === event.to_user_id)
      if (!account) return
      useWhispersStore.getState().add({
        id: `w-${event.whisper_id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
        accountId: account.id,
        otherLogin: (event.from_user_login ?? '').toLowerCase(),
        otherDisplay: event.from_user_name || event.from_user_login || '?',
        otherId: event.from_user_id ?? '',
        text: event.whisper?.text ?? '',
        timestamp: Date.now(),
        incoming: true
      })
      const settings = useSettingsStore.getState().settings
      // no ping for the conversation the user is looking at right now (any window)
      const openThread = getOpenWhisperThread()
      const from = (event.from_user_login ?? '').toLowerCase()
      const ping = this.ownsSound && settings.whisperSound && openThread !== from
      /**
       * Say WHY, every time. "Whispers arrive but never notify" was reported once and could
       * not be told apart from "whispers do not arrive" without this line — there are four
       * separate reasons the ping is skipped and none of them used to leave a trace.
       */
      diagInfo(
        'whisper',
        ping
          ? `from ${from} → ping`
          : `from ${from} → silent (${!this.ownsSound ? 'not the sound-owning window' : !settings.whisperSound ? 'whisper sound is off in settings' : `thread "${openThread}" is open and focused`})`
      )
      if (ping) playWhisperSound(settings)
      // a toast as well as the sound: with the app behind a game, a "pop" three windows away
      // is the whole notification, and it is easy to miss or to not attribute to anything
      if (ping && settings.whisperNotify) {
        const who = event.from_user_name || event.from_user_login || '?'
        const body = String(event.whisper?.text ?? '')
        useUiStore.getState().toast(`✉ ${who}: ${body.length > 80 ? `${body.slice(0, 80)}…` : body}`, 'ok')
      }
    } else if (type === 'channel.raid') {
      const fromLogin = (event.from_broadcaster_user_login ?? '').toLowerCase()
      const toLogin = (event.to_broadcaster_user_login ?? '').toLowerCase()
      const toName = event.to_broadcaster_user_name || toLogin
      const viewers = event.viewers ?? 0
      const open = allOpenChannels(useLayoutStore.getState().tabs)
      if (!open.includes(fromLogin)) return
      // PubSub usually announces the raid first (at countdown start) — don't repeat
      const key = `${fromLogin}:${toLogin}`
      const last = this.raidAnnounced.get(key) ?? 0
      if (Date.now() - last < 2 * 60_000) return
      this.raidAnnounced.set(key, Date.now())
      const lang = useSettingsStore.getState().settings.language
      this.localInfo(fromLogin, translate(lang, 'info.raidStart', { target: toName, count: String(viewers) }))
      // outgoing raid from an open channel — offer to follow it to the target
      this.promptAddChannel(fromLogin, toLogin)
    } else if (type === 'channel.moderate') {
      this.handleModerateEvent(event, envelopeId)
    } else if (type === 'channel.shoutout.create') {
      this.handleShoutout(event)
    } else if (type === 'channel.follow') {
      this.handleFollow(event)
    }
  }

  /**
   * channel.follow — the only event with no chat message behind it.
   *
   * Twitch sends nothing to IRC when somebody follows, so the line is built here from the payload.
   * The follower goes in as `login`/`displayName` rather than only into the text, which is what
   * lets the events panel say who it was and the usercard open on them like on any other entry.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleFollow(event: Record<string, any>): void {
    const channel = String(event.broadcaster_user_login ?? '').toLowerCase()
    const login = String(event.user_login ?? '').toLowerCase()
    if (!channel) return
    void import('./goals').then((m) => m.countFollow(channel))
    if (!login) return
    // EventSub can redeliver; the same person following twice within a minute is a duplicate
    const key = `${channel}:${login}`
    if (Date.now() - (this.followSeen.get(key) ?? 0) < 60_000) return
    this.followSeen.set(key, Date.now())
    if (!allOpenChannels(useLayoutStore.getState().tabs).includes(channel)) return
    const st = useSettingsStore.getState()
    const name = String(event.user_name || event.user_login)
    const msg = this.systemMessage(channel, translate(st.settings.language, 'info.follow', { user: name }))
    msg.follow = true
    msg.login = login
    msg.displayName = name
    msg.userId = String(event.user_id ?? '')
    // The events panel keeps every follow regardless; the setting only decides whether the line
    // also appears in the chat itself, which is the part that can get in the way during a raid.
    if (st.settings.announceFollows) {
      this.queue(channel, msg)
      return
    }
    hlIngest(channel, msg)
    // An alert overlay is a different question from a chat line, so it must not depend on that
    // answer. queue() would have pushed this for us; without it, the push happens here.
    if (window.location.hash || !st.settings.overlayEnabled) return
    void import('../lib/overlayRender').then(({ buildOverlayLine }) => {
      const line = buildOverlayLine(msg)
      if (line) window.sticki.overlayPush(channel, line)
    })
  }

  /**
   * Remember a shoutout this app just gave, so its EventSub echo is not announced again.
   *
   * The mod button writes its own line the moment the call succeeds — it was written when shoutouts
   * did not come back at all. They do now, through channel.shoutout.create, so both lines appeared
   * and the chat said the same thing twice. The echo lands in the same 30-second window the redelivery
   * dedupe already uses, so noting it here is enough to silence exactly one of the two.
   */
  noteShoutoutGiven(channel: string, target: string): void {
    this.shoutoutAnnounced.set(`${channel.toLowerCase()}:${target.toLowerCase()}`, Date.now())
  }

  /** channel.shoutout.create — the broadcaster gave a shoutout; show it + offer to open the target */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleShoutout(event: Record<string, any>): void {
    const channel = (event.broadcaster_user_login ?? '').toLowerCase()
    const target = (event.to_broadcaster_user_login ?? '').toLowerCase()
    const targetName = event.to_broadcaster_user_name || target
    if (!channel || !target) return
    const open = allOpenChannels(useLayoutStore.getState().tabs)
    if (!open.includes(channel)) return
    // dedupe: EventSub can redeliver; one shoutout per target per 30s is plenty
    const key = `${channel}:${target}`
    const last = this.shoutoutAnnounced.get(key) ?? 0
    if (Date.now() - last < 30_000) return
    this.shoutoutAnnounced.set(key, Date.now())
    const lang = useSettingsStore.getState().settings.language
    this.localInfo(channel, translate(lang, 'info.shoutout', { target: targetName }))
    // offer to open the shouted-out channel's chat (+ follow via their Twitch page)
    const existing = open.includes(target)
    useUiStore.getState().setChannelPrompt({ channel: target, from: channel, existing, shoutout: true })
  }

  /** channel.moderate v2 — the full "who did what to whom" moderation feed */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleModerateEvent(event: Record<string, any>, envelopeId = ''): void {
    const channel = (event.broadcaster_user_login ?? '').toLowerCase()
    if (!channel) return
    const lang = useSettingsStore.getState().settings.language
    const mod = event.moderator_user_name || event.moderator_user_login || '?'
    const action = event.action as string
    let text = ''
    let targetId = ''
    switch (action) {
      case 'ban': {
        targetId = event.ban?.user_id ?? ''
        const reason = event.ban?.reason ? ` (${event.ban.reason})` : ''
        text = translate(lang, 'modact.ban', { mod, user: event.ban?.user_name ?? '?' }) + reason
        if (targetId && useAccountsStore.getState().accounts.some((a) => a.id === targetId)) {
          useChatStore.getState().setSelfTimeout(channel, targetId, -1, event.ban?.reason || undefined)
        }
        break
      }
      case 'timeout': {
        targetId = event.timeout?.user_id ?? ''
        const until = event.timeout?.expires_at ? new Date(event.timeout.expires_at).getTime() : 0
        const secs = until ? Math.max(1, Math.round((until - Date.now()) / 1000)) : 0
        const reason = event.timeout?.reason ? ` (${event.timeout.reason})` : ''
        text =
          translate(lang, 'modact.timeout', {
            mod,
            user: event.timeout?.user_name ?? '?',
            duration: formatDuration(secs)
          }) + reason
        // my own account: remember the reason for the locked-input placeholder
        if (targetId && until && useAccountsStore.getState().accounts.some((a) => a.id === targetId)) {
          useChatStore.getState().setSelfTimeout(channel, targetId, until, event.timeout?.reason || undefined)
        }
        break
      }
      /*
       * Lifting a ban or a timeout has to unlock the input, and nothing here did.
       *
       * Only the punishment was ever recorded. Twitch sends no CLEARCHAT when a timeout is lifted —
       * this event is the only notice of it — so a timeout removed after ten seconds left the input
       * locked for the full original duration, counting down against something that no longer
       * existed. `until: 0` is the state the input reads as "nothing is in force".
       */
      case 'unban':
        targetId = event.unban?.user_id ?? ''
        text = translate(lang, 'modact.unban', { mod, user: event.unban?.user_name ?? '?' })
        if (targetId && useAccountsStore.getState().accounts.some((a) => a.id === targetId)) {
          useChatStore.getState().setSelfTimeout(channel, targetId, 0, '')
        }
        break
      case 'untimeout':
        targetId = event.untimeout?.user_id ?? ''
        text = translate(lang, 'modact.unban', { mod, user: event.untimeout?.user_name ?? '?' })
        if (targetId && useAccountsStore.getState().accounts.some((a) => a.id === targetId)) {
          useChatStore.getState().setSelfTimeout(channel, targetId, 0, '')
        }
        break
      case 'delete': {
        targetId = event.delete?.user_id ?? ''
        const body = String(event.delete?.message_body ?? '')
        const short = body.length > 80 ? `${body.slice(0, 80)}…` : body
        text = translate(lang, 'modact.delete', { mod, user: event.delete?.user_name ?? '?', text: short })
        break
      }
      case 'clear':
        text = translate(lang, 'modact.clear', { mod })
        break
      case 'warn':
        targetId = event.warn?.user_id ?? ''
        text = translate(lang, 'modact.warn', { mod, user: event.warn?.user_name ?? '?' })
        break
      default:
        // mode toggles (slow, emoteonly, followers…) and the rest — compact generic line
        text = `🛡 ${mod}: ${action}`
    }
    if (!text) return
    const msg = this.systemMessage(channel, text)
    if (envelopeId) msg.id = `modact-${envelopeId}` // stable across windows for persistence
    msg.modAction = true
    if (targetId) msg.modTargetUserId = targetId
    this.queue(channel, msg)
    this.persistModAction(channel, msg)
  }

  /**
   * Mod-action lines exist only in windows with a live mod feed — persist them (like
   * redemptions) so a reopened usercard/highlights window replays the recent ones.
   */
  private modActKey(channel: string): string {
    return `sticki:modacts:${channel}`
  }

  private persistModAction(channel: string, msg: ChatMessage): void {
    try {
      const raw = localStorage.getItem(this.modActKey(channel))
      const list = raw
        ? (JSON.parse(raw) as { id: string; text: string; ts: number; target?: string }[])
        : []
      if (list.some((r) => r.id === msg.id)) return // another window already wrote it
      list.push({ id: msg.id, text: msg.systemText ?? '', ts: msg.timestamp, target: msg.modTargetUserId })
      localStorage.setItem(this.modActKey(channel), JSON.stringify(list.slice(-100)))
    } catch {
      /* best-effort */
    }
  }

  private loadPersistedModActions(channel: string): ChatMessage[] {
    try {
      const raw = localStorage.getItem(this.modActKey(channel))
      const list = raw
        ? (JSON.parse(raw) as { id: string; text: string; ts: number; target?: string }[])
        : []
      return list.map((r) => {
        const msg = this.systemMessage(channel, r.text)
        msg.id = r.id
        msg.timestamp = r.ts
        msg.modAction = true
        msg.modTargetUserId = r.target
        msg.historical = true
        return msg
      })
    } catch {
      return []
    }
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
        // offline → live transition: notify (but never on the very first poll of a channel,
        // which would fire for everyone already streaming when the app opens)
        const isLive = live.has(ch)
        if (this.liveKnown.has(ch)) {
          if (isLive && !this.wasLive.get(ch)) this.onStreamWentLive(ch)
        } else {
          this.liveKnown.add(ch)
        }
        this.wasLive.set(ch, isLive)
      }
      useChatStore.getState().setLiveChannels(Object.fromEntries(channels.map((c) => [c, live.has(c)])))
      useChatStore.getState().setStreamInfo(
        Object.fromEntries(
          channels.flatMap((c) => {
            const info = live.get(c)
            return info ? [[c, { viewers: info.viewers, title: info.title, startedAt: info.startedAt, game: info.game }]] : []
          })
        )
      )
      this.resolveChannelNames(account, channels)
    } catch {
      /* keep previous state */
    }
  }

  /** a watched channel just went live: optional sound + a banner toast */
  private onStreamWentLive(channel: string): void {
    const settings = useSettingsStore.getState().settings
    if (this.ownsSound && settings.streamUpSound) playStreamUpSound(settings)
    if (settings.streamUpNotify) {
      const name = useChatStore.getState().channelNames[channel] ?? channel
      const lang = settings.language
      useUiStore.getState().toast(translate(lang, 'info.streamUp', { channel: name }))
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
      // broadcaster chat colors — the accent for PRIMARY announcements on their channel
      const colors = await getUserChatColors(account, users.map((u) => u.id))
      const accents: Record<string, string> = {}
      for (const u of users) if (colors[u.id]) accents[u.login.toLowerCase()] = colors[u.id]
      if (Object.keys(accents).length) useChatStore.getState().setChannelAccents(accents)
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

  /**
   * Called every time somebody speaks for the first time this stream — which on a big channel is
   * most messages for the first hour, and each call rewrote the entire login list. On kaicenat
   * that list reached 330 KB, so a synchronous serialize-and-store ran per new chatter. Deferred
   * and coalesced: the set is serialised once, when the browser is idle.
   */
  private persistFirstSeen(channel: string): void {
    const startedAt = this.streamStartedAt.get(channel)
    const seen = this.seenThisSession.get(channel)
    if (!startedAt || !seen) return
    try {
      queueWrite(this.firstSeenKey(channel), () =>
        JSON.stringify({ startedAt, logins: [...seen] })
      )
    } catch {
      /* best-effort */
    }
  }

  /**
   * Pull the channel's recent-messages scrollback and turn it into chat messages.
   *
   * `historical` controls whether they are painted as scrollback (dimmed, no sounds) or as
   * ordinary chat: true when filling the view on open, false when filling a gap the user
   * lived through — those are real messages that merely arrived late, and dimming them would
   * say "old" about something that happened thirty seconds ago.
   */
  private async fetchHistoryMessages(channel: string, historical: boolean): Promise<ChatMessage[]> {
    const lines = await fetchRecentMessages(channel)
    const msgs: ChatMessage[] = []
    for (const line of lines) {
      const parsed = parseIrcLine(line)
      if (!parsed) continue
      if (parsed.command === 'PRIVMSG') {
        const m = this.privmsgToChatMessage(parsed)
        if (m) {
          m.historical = historical
          // mentions/keywords must be flagged for history too, or the "mentions" tab of
          // the highlights panel starts empty after every launch (no sounds: historical)
          const myLogins = useAccountsStore.getState().accounts.map((a) => a.login.toLowerCase())
          if (m.replyParent && myLogins.includes(m.replyParent.login.toLowerCase())) {
            m.replyToMe = true
            m.isMention = true
          }
          // flag it, never ring for it: see detectMention's `alert`
          this.detectMention(m, false)
          msgs.push(m)
        }
      } else if (parsed.command === 'USERNOTICE') {
        // scrollback should show subs/resubs/raids too, not just plain chat
        const m = this.usernoticeToHistorical(parsed)
        if (m) msgs.push(m)
      }
    }
    return msgs
  }

  private onChannelOpened(channel: string): void {
    const { settings, } = useSettingsStore.getState()
    if (settings.loadHistory && !this.historyLoaded.has(channel)) {
      this.historyLoaded.add(channel)
      void this.fetchHistoryMessages(channel, true).then((msgs) => {
        // replay recent redemptions + mod actions (they never come from IRC history)
        const redeems = this.loadPersistedRedeems(channel)
        const modacts = this.loadPersistedModActions(channel)
        const all = [...msgs, ...redeems, ...modacts].sort((a, b) => a.timestamp - b.timestamp)
        if (all.length) useChatStore.getState().prependMessages(channel, all)
      })
    }
  }

  /**
   * Refill what the chat missed while the socket was down.
   *
   * Reconnecting to IRC gets you the live stream and nothing else — Twitch does not replay
   * what happened while you were away. Until now that gap was simply lost: "the chat stops
   * loading and the messages disappear into nowhere" was literally true, and the only reason
   * anything ever came back was that the user restarted the app. The recent-messages
   * scrollback covers exactly that window, and seedMessages merges it by id and sorts by
   * time, so the recovered lines slot into their real place instead of piling up at the end.
   *
   * Gated on the history setting: it is the same third-party source, and someone who turned
   * that off has said they do not want us asking it for their channels.
   */
  private backfillAfterOutage(downSince: number): void {
    if (!useSettingsStore.getState().settings.loadHistory) return
    const gapSec = Math.round((Date.now() - downSince) / 1000)
    for (const channel of allOpenChannels(useLayoutStore.getState().tabs)) {
      void this.fetchHistoryMessages(channel, false)
        .then((msgs) => {
          // only what arrived during the outage — the rest is already in the buffer, and
          // seedMessages would dedupe it anyway, but there is no point handing it a thousand
          // rows to compare. A little slack either side of the gap covers clock skew.
          const since = downSince - 5000
          const missed = msgs.filter((m) => m.timestamp >= since)
          if (!missed.length) return
          useChatStore.getState().seedMessages(channel, missed)
          diagInfo('chat', `${channel}: backfilled ${missed.length} message(s) missed during a ${gapSec}s outage`)
        })
        .catch(() => {
          /* the scrollback service is best-effort; a failed refill must not break reconnect */
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
          // NOTE: we intentionally do NOT auto-tag chat messages as "raider" any more.
          // Twitch gives no per-user signal for who arrived from a raid, so the old
          // "first message shortly after a raid" heuristic tagged ordinary new chatters as
          // raiders (false positives). The raid itself is still announced as a system line.
          const raidUntil = this.raidWindow.get(msg.channel)
          if (raidUntil && Date.now() > raidUntil) {
            this.raidWindow.delete(msg.channel)
            this.raidDetectUntil.delete(msg.channel)
            this.raiders.delete(msg.channel)
            this.raidSource.delete(msg.channel)
          }
          const myLogins = useAccountsStore.getState().accounts.map((a) => a.login.toLowerCase())
          if (msg.replyParent && myLogins.includes(msg.replyParent.login.toLowerCase())) {
            msg.replyToMe = true
            msg.isMention = true
          }
          this.detectMention(msg)
          this.maybePlayFirstSeenSound(msg)
          if (this.maybeHoldRedeemPrivmsg(msg)) break
          this.markUnreadIfInactive(msg.channel)
          this.queue(msg.channel, msg)
        }
        break
      }
      case 'ROOMSTATE': {
        /**
         * Which restrictions the channel has on, merged rather than replaced.
         *
         * Twitch sends the full set once on join and then only the tag that CHANGED — so
         * assigning the parsed object wholesale would forget every other mode the moment a
         * moderator toggled one of them.
         */
        if (m.channel) {
          const num = (v: string | undefined): number | undefined =>
            v === undefined ? undefined : parseInt(v, 10)
          const bool = (v: string | undefined): boolean | undefined =>
            v === undefined ? undefined : v === '1'
          const patch = {
            emoteOnly: bool(m.tags['emote-only']),
            subsOnly: bool(m.tags['subs-only']),
            uniqueChat: bool(m.tags['r9k']),
            followersOnly: num(m.tags['followers-only']),
            slow: num(m.tags['slow'])
          }
          // drop the keys this particular ROOMSTATE said nothing about
          const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
          if (Object.keys(clean).length) useChatStore.getState().patchRoomModes(m.channel, clean)
        }
        const id = m.tags['room-id']
        if (id && m.channel) {
          const known = useChatStore.getState().channelIds[m.channel]
          useChatStore.getState().setChannelId(m.channel, id)
          loadChannelEmotes(m.channel, id)
          loadChannelBadges(m.channel, id)
          loadCheermotes(m.channel, id)
          // now that we know this channel's id, its raid + redemption topics can be created
          if (known !== id) {
            this.eventSub?.resync()
            this.pubSub?.resync()
          }
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
          const secs = dur ? parseInt(dur, 10) : 0
          // one of MY accounts got timed out / banned here → the input locks with a countdown
          if (userId && useAccountsStore.getState().accounts.some((a) => a.id === userId)) {
            useChatStore.getState().setSelfTimeout(channel, userId, dur ? Date.now() + secs * 1000 : -1)
          }
          const text = dur
            ? translate(lang, 'misc.timedOut', {
                user: m.trailing,
                duration: formatDuration(secs)
              })
            : translate(lang, 'misc.banned', { user: m.trailing })
          // full "who did it" lines come from channel.moderate where we're a mod — the bare
          // IRC line would duplicate them there
          if (!this.modEventChannels.has(channel)) {
            const sys = this.systemMessage(channel, text)
            sys.modAction = true
            sys.modTargetUserId = userId
            this.queue(channel, sys)
          }
          // the overlay drops that user's lines either way
          if (!window.location.hash && userId) window.sticki.overlayDelete(channel, { user: userId })
        } else {
          useChatStore.getState().clearChannel(channel)
          const sys = this.systemMessage(channel, translate(lang, 'misc.chatCleared'))
          sys.modAction = true
          this.queue(channel, sys)
          if (!window.location.hash) window.sticki.overlayDelete(channel, { all: true })
        }
        break
      }
      case 'CLEARMSG': {
        const id = m.tags['target-msg-id']
        if (id && m.channel) {
          useChatStore.getState().markDeleted(m.channel, id)
          if (!window.location.hash) window.sticki.overlayDelete(m.channel, { id })
        }
        break
      }
      case 'USERNOTICE': {
        // subs, resubs, raids, announcements...
        const sysText = this.usernoticeText(m)
        const msg = this.privmsgToChatMessage(m) ?? (m.channel && sysText ? this.systemMessage(m.channel, '') : null)
        if (msg) {
          msg.system = 'usernotice'
          msg.systemText = sysText
          if (m.tags['msg-id'] === 'announcement') {
            msg.announceColor = (m.tags['msg-param-color'] || 'PRIMARY').toLowerCase()
          }
          if (m.tags['msg-id'] === 'viewermilestone') {
            msg.watchStreak = true
            recordWatchStreak(m.channel, m.tags['login'] || '', parseInt(m.tags['msg-param-value'] || '', 10), msg.timestamp)
          }
          if (SUB_EVENT_IDS.has(m.tags['msg-id'] ?? '')) msg.subEvent = true
          if (m.tags['msg-id'] === 'raid') this.onIncomingRaid(m, msg)
          // mass gifts: the "X дарує N підписок" header groups the individual subgift lines.
          // Twitch delivers them in ANY order — a late header must also swallow subgifts
          // that already went through (pending queue + store).
          const login = (m.tags['login'] || '').toLowerCase()
          if (m.tags['msg-id'] === 'submysterygift') {
            /*
             * A gift of one needs no header.
             *
             * Twitch announces every mass gift twice: a header saying how many were given, and a line
             * per recipient. For a single sub that is "X дарує 1 підписок чату" followed by a
             * collapsed child saying who actually got it — two lines and a disclosure triangle to
             * read one fact. The header only earns its place when there is more than one line to
             * group, so for a count of one it is dropped and the recipient's own line stands alone.
             */
            const count = parseInt(m.tags['msg-param-mass-gift-count'] ?? '', 10)
            if (count === 1) break

            msg.giftGroupId = msg.id
            this.mysteryGifts.set(`${m.channel}:${login}`, { id: msg.id, until: Date.now() + 90_000 })
            const since = Date.now() - 90_000
            // subgifts still waiting in the flush queue
            for (const p of this.pendingByChannel.get(m.channel) ?? []) {
              if (p.giftFrom === login && !p.groupedUnder && p.timestamp >= since) p.groupedUnder = msg.id
            }
            // subgifts already rendered
            useChatStore.getState().groupGifts(m.channel, login, msg.id, since)
          } else if (m.tags['msg-id'] === 'subgift') {
            msg.giftFrom = login
            const g = this.mysteryGifts.get(`${m.channel}:${login}`)
            if (g && Date.now() < g.until) msg.groupedUnder = g.id
          }
          this.queue(m.channel, msg)
        }
        break
      }
      case 'NOTICE': {
        if (m.channel && m.trailing) {
          this.queue(m.channel, this.systemMessage(m.channel, this.noticeText(m), true))
        }
        break
      }
    }
  }

  /**
   * Twitch sends NOTICE bodies in English regardless of anything we ask for, so "Your message
   * was not sent because you are sending messages too quickly." showed up verbatim in a
   * Ukrainian UI. The `msg-id` tag is a stable machine identifier, so translate off that and
   * fall back to Twitch's own text for ids we don't have a string for — an untranslated
   * notice is still better than a swallowed one.
   */
  private noticeText(m: IrcMessage): string {
    const id = m.tags['msg-id']
    if (!id) return m.trailing ?? ''
    const key = `notice.${id}` as TranslationKey
    const lang = useSettingsStore.getState().settings.language
    const translated = translate(lang, key)
    return translated === key ? (m.trailing ?? '') : translated
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
      case 'viewermilestone': {
        // watch-streak milestone
        const val = m.tags['msg-param-value'] || '?'
        return `🔥 ${name} дивиться стрим ${val}-й раз поспіль! Оце стрик!`
      }
      case 'midnightsquid':
      case 'cheer':
        return en
      default: {
        /**
         * Twitch keeps adding notices faster than it documents their ids, and the moderator
         * anniversary is one of them: it arrives with an id we have no mapping for and an
         * English `system-msg`, so it was the one line in a Ukrainian chat still reading
         * "…celebrating N years as a moderator". Recognising it by SHAPE rather than by an id
         * we would have to guess means it works whatever Twitch calls it this month, and
         * anything genuinely unknown still falls through to Twitch's own wording.
         */
        const years = /(\d+)[\s-]*year/i.exec(en)
        if (years && /moderat/i.test(en)) {
          const n = Number(years[1])
          return `🛡️ ${name} — вже ${n} ${plural(n, 'рік', 'роки', 'років')} модерує цей канал!`
        }
        return en
      }
    }
  }

  /** build a historical usernotice line for scrollback (subs/resubs/raids) */
  private usernoticeToHistorical(m: IrcMessage): ChatMessage | null {
    const sysText = this.usernoticeText(m)
    const msg = this.privmsgToChatMessage(m) ?? (m.channel ? this.systemMessage(m.channel, '') : null)
    if (!msg || !sysText) return null
    msg.system = 'usernotice'
    msg.systemText = sysText
    msg.historical = true
    if (m.tags['msg-id'] === 'announcement') msg.announceColor = (m.tags['msg-param-color'] || 'PRIMARY').toLowerCase()
    if (m.tags['msg-id'] === 'viewermilestone') {
      msg.watchStreak = true
      recordWatchStreak(m.channel ?? '', m.tags['login'] || '', parseInt(m.tags['msg-param-value'] || '', 10), msg.timestamp)
    }
    if (SUB_EVENT_IDS.has(m.tags['msg-id'] ?? '')) msg.subEvent = true
    return msg
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
    // channel-point redemptions: custom rewards carry custom-reward-id, "highlight my
    // message" arrives as msg-id=highlighted-message. First-ever messages sometimes carry a
    // highlight msg-id too — without a reward id those are NOT redemptions.
    const redeemed =
      !!m.tags['custom-reward-id'] ||
      (m.tags['msg-id'] === 'highlighted-message' && m.tags['first-msg'] !== '1')
    const bits = m.tags['bits'] ? parseInt(m.tags['bits'], 10) || undefined : undefined
    // bits power-ups: "Gigantify an Emote" and "Message Effect" (animated background)
    const gigantified = m.tags['msg-id'] === 'gigantified-emote-message' || undefined
    const messageEffect = m.tags['animation-id'] || undefined
    // Twitch SHARED CHAT: relayed messages carry the origin broadcaster in source-room-id
    const srcRoom = m.tags['source-room-id']
    const sourceRoomId = srcRoom && srcRoom !== (m.tags['room-id'] ?? '') ? srcRoom : undefined
    return {
      sourceRoomId,
      redeemed: redeemed || undefined,
      bits,
      gigantified,
      messageEffect,
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
  /**
   * @param alert whether this message may ring and mark a tab unread.
   *
   * Looking like scrollback and being worth a sound were the same question until now, answered by
   * `historical` alone — and the backfill after a dropped connection deliberately says it is NOT
   * historical, because those messages arrived thirty seconds ago and dimming them would lie. So
   * every reconnect replayed the pings for every mention it refilled, in every open channel at once,
   * including ones that had already been read. The flag still gets set either way, or the mentions
   * tab would be empty after a restart; only the noise is withheld.
   */
  private detectMention(msg: ChatMessage, alert = true): void {
    const accounts = useAccountsStore.getState().accounts
    if (accounts.length === 0 || !msg.text) return
    const caseSensitive = useSettingsStore.getState().settings.caseSensitiveNicks
    const lower = msg.text.toLowerCase()
    // a reply to me and a plain nick tag notify identically (same tab @ dot, same sound)
    const mentioned =
      !!msg.replyToMe ||
      accounts.some((a) => {
        if (msg.userId === a.id) return false // own messages don't count
        /*
         * An @tag is an address, and a Twitch login is not case-sensitive: @gous_stickmen and
         * @GouS_Stickmen reach the same person, so both have to count. Only the display spelling was
         * accepted here, which is why mentions fired "sometimes" — it depended entirely on how the
         * other person had capitalised the name, and most people type it in lower case.
         *
         * The setting still governs the bare word, which is what it is for: it stops a nick that is
         * also an ordinary word from ringing every time somebody uses that word.
         */
        if (lower.includes(`@${a.login.toLowerCase()}`)) return true
        if (caseSensitive) {
          const name = escapeRegExp(a.displayName)
          return msg.text.includes(`@${a.displayName}`) || new RegExp(`(^|[^\\w])${name}([^\\w]|$)`).test(msg.text)
        }
        const l = a.login.toLowerCase()
        return lower.includes(`@${l}`) || new RegExp(`(^|[^\\w])${l}([^\\w]|$)`).test(lower)
      })
    if (!mentioned) {
      if (alert) this.detectKeywords(msg)
      return
    }
    msg.isMention = true
    if (msg.historical || !alert) return

    // is the mentioned channel visible in the active tab right now?
    const { tabs, activeTabId } = useLayoutStore.getState()
    const activeChannels = tabs.find((t) => t.id === activeTabId)?.panes.map((p) => p.channel) ?? []
    const visible = activeChannels.includes(msg.channel)

    const settings = useSettingsStore.getState().settings
    // by default no ping for a channel you're already watching — you can see the mention.
    // The switch exists because a busy chat scrolls a mention away before you notice it.
    if (this.ownsSound && settings.mentionSound && (!visible || settings.mentionSoundOnActive)) playMentionSound(settings)

    if (!visible) useChatStore.getState().setUnreadMention(msg.channel)
  }

  /** user-configured words/phrases that should alert like a mention */
  private detectKeywords(msg: ChatMessage): void {
    if (msg.historical || !msg.text) return
    // own messages never trigger keyword alerts
    if (useAccountsStore.getState().accounts.some((a) => a.id === msg.userId)) return
    const settings = useSettingsStore.getState().settings

    // nickname spellings come first and get their OWN sound: being called by name is a
    // different kind of ping than a topic word. Each list carries its own whole-word switch,
    // because a handle usually wants the strict reading and a topic word usually does not.
    const nickHit = settings.nickAlertSound
      ? findTerm(msg.text, settings.nickAlerts, settings.nickAlertWholeWord)
      : undefined
    const hit =
      nickHit ??
      (settings.keywordSound
        ? findTerm(msg.text, settings.keywordAlerts, settings.keywordWholeWord)
        : undefined)
    if (!hit) return
    msg.isMention = true // highlight it like a mention so it's visible in chat/sidebar
    const { tabs, activeTabId } = useLayoutStore.getState()
    const activeChannels = tabs.find((t) => t.id === activeTabId)?.panes.map((p) => p.channel) ?? []
    const visible = activeChannels.includes(msg.channel)
    // each alert kind decides for itself whether it still sounds while you're on that tab
    if (this.ownsSound) {
      if (nickHit) {
        if (!visible || settings.nickAlertSoundOnActive) playNickAlertSound(settings)
      } else if (!visible || settings.keywordSoundOnActive) {
        playKeywordSound(settings)
      }
    }
    // tag the channel's tab with the matched word while the tab is inactive
    if (!visible) {
      useChatStore.getState().setUnreadKeyword(msg.channel, hit.trim())
    }
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
    if (!this.ownsSound || !settings.firstMessageSound) return
    const { tabs, activeTabId } = useLayoutStore.getState()
    const activeChannels = tabs.find((t) => t.id === activeTabId)?.panes.map((p) => p.channel) ?? []
    if (!activeChannels.includes(msg.channel)) return
    playFirstMessageSound(settings)
  }

  private systemMessage(channel: string, text: string, clientNotice = false): ChatMessage {
    return {
      clientNotice,
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
    // highlights accumulator: mentions/keywords/subs/redeems are recorded even while the
    // highlights panel and window are CLOSED (main window only — it ingests everything)
    hlIngest(channel, msg)
    this.pendingByChannel.set(channel, arr)
    if (this.flushTimer === null) {
      this.flushTimer = window.setTimeout(() => this.flush(), 60)
    }
    // OBS overlay: stream rendered lines to the local SSE server (main window only —
    // detached/usercard windows join channels too and would duplicate every line)
    if (!window.location.hash && useSettingsStore.getState().settings.overlayEnabled) {
      import('../lib/overlayRender').then(async ({ buildOverlayLine }) => {
        // the overlay line is built once; resolve async cosmetics FIRST (cached after the
        // first message per user) so 7TV colors/avatars are baked into the pushed line.
        // Cap the waits so a slow fetch never stalls the overlay.
        const st = useSettingsStore.getState().settings
        const waits: Promise<unknown>[] = []
        if (st.sevenTvNickColors && msg.userId && !msg.system) {
          const { awaitSevenTvCosmetic } = await import('../lib/seventvCosmetics')
          waits.push(awaitSevenTvCosmetic(msg.userId))
        }
        if (st.chatOverlays.some((o) => o.type === 'chat' && o.avatarShow) && msg.login && !msg.system) {
          const { awaitAvatar } = await import('../lib/twitchAvatars')
          waits.push(awaitAvatar(msg.login))
        }
        if (waits.length) {
          await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, 1500))])
        }
        const line = buildOverlayLine(msg)
        if (line) {
          window.sticki.overlayPush(channel, line)
          // goal overlays that count events rather than polling Twitch get their number here,
          // where every cheer and every sub already passes through exactly once
          const { countGoalEvent } = await import('./goals')
          countGoalEvent(channel, line)
        }
        // a wheel listening for a command or a reward sees the same message
        const { maybeSpinFromChat } = await import('./wheel')
        maybeSpinFromChat(channel, msg)
      })
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

  /**
   * Offer to add a channel involved in a raid.
   * @param contextChannel where the raid is happening (used for the "active tab only" option)
   * @param targetChannel  the channel we'd add
   */
  private promptAddChannel(contextChannel: string, targetChannel: string): void {
    const s = useSettingsStore.getState().settings
    if (!s.raidPrompt || !targetChannel) return
    if (s.raidPromptActiveOnly) {
      const { tabs, activeTabId } = useLayoutStore.getState()
      const active = tabs.find((t) => t.id === activeTabId)?.panes.map((p) => p.channel) ?? []
      if (!active.includes(contextChannel)) return
    }
    // channel already open somewhere → offer to switch to that tab instead of adding
    const open = allOpenChannels(useLayoutStore.getState().tabs)
    useUiStore.getState().setChannelPrompt({
      channel: targetChannel,
      from: contextChannel,
      existing: open.includes(targetChannel)
    })
    if (this.ownsSound && s.raidSound) playRaidSound(s)
  }

  /** channel -> highlight expiry: known raiders keep the tag until this time */
  private raidWindow = new Map<string, number>()
  /**
   * channel -> DETECTION cutoff: raiders flood in as a burst right after the raid, so only
   * first-messages within this short window are counted as raiders. Regulars trickle in over
   * the whole stream and would otherwise all get falsely tagged.
   */
  private raidDetectUntil = new Map<string, number>()
  /** channel -> logins marked as raiders (highlighted while the raid window lasts) */
  private raiders = new Map<string, Set<string>>()
  /** channel -> the streamer whose raid the current raider window belongs to */
  private raidSource = new Map<string, string>()

  /**
   * An incoming raid (someone raids a channel we watch). No "add channel" prompt here —
   * only OUTGOING raids offer that. Instead: enable the mod shoutout button on the raid
   * message and open the raider-highlight window.
   */
  private onIncomingRaid(m: IrcMessage, msg: ChatMessage): void {
    const raider = (m.tags['msg-param-login'] || m.tags['login'] || '').toLowerCase()
    if (raider) msg.raidFrom = raider
    const minutes = useSettingsStore.getState().settings.raiderHighlightMinutes
    if (m.channel && minutes > 0) {
      this.raidWindow.set(m.channel, Date.now() + minutes * 60_000)
      // raiders arrive in a ~90s burst; only tag first-messages inside it
      this.raidDetectUntil.set(m.channel, Date.now() + 90_000)
      this.raiders.set(m.channel, new Set(raider ? [raider] : []))
      if (raider) this.raidSource.set(m.channel, raider)
    }
  }

  /** injects a local system line into a channel (client-side actions like shoutouts) */
  localInfo(channel: string, text: string): void {
    this.queue(channel, this.systemMessage(channel, text))
  }

  /** a 7TV set change, carrying the emotes so the line can draw them */
  localEmoteEvent(channel: string, event: NonNullable<ChatMessage['emoteEvent']>, text: string): void {
    const msg = this.systemMessage(channel, text)
    msg.emoteEvent = event
    this.queue(channel, msg)
  }

  /**
   * Losing the connection used to be completely silent: the chat simply stopped moving, with
   * no line, no indicator and nothing in the log. A user described it as "messages disappear
   * into nowhere" and had no way to tell a dead socket from a quiet channel. Now every open
   * chat says so, and says when it is back.
   */
  private connDown = false
  /** when the line went down, so the refill knows how far back to reach */
  private downSince = 0

  /**
   * A blip is not news. On a line that recycles idle connections — a router, an ISP, a VPN —
   * the socket dies every ten or twenty minutes and comes back in under two seconds with the
   * missed messages refilled. Writing "connection lost" and "connection restored" for that is
   * how a working chat looks broken: a report came in listing three "disconnects", all three of
   * which were two-second gaps that the refill had already covered.
   *
   * So the announcement waits. Reconnect inside the grace window and nothing is ever written;
   * take longer and the chat says so, and says when it is back.
   */
  private static readonly OUTAGE_GRACE = 6000
  private outageTimer: number | null = null
  private announcedDown = false

  private announceConnection(open: boolean, silentFor = 0): void {
    useChatStore.getState().setConnState(open ? 'open' : 'connecting')
    // don't announce "restored" for the very first connect of the session
    if (open && !this.connDown) return
    if (!open && this.connDown) return // already announced; a retry loop must not spam
    this.connDown = !open
    // the standalone windows share this service — only the main window writes chat lines
    if (window.location.hash) return
    const lang = useSettingsStore.getState().settings.language

    if (!open) {
      // the line may have been dead for a while before the close surfaced — refill from there
      this.downSince = Date.now() - Math.min(silentFor, 5 * 60_000)
      if (this.outageTimer === null) {
        this.outageTimer = window.setTimeout(() => {
          this.outageTimer = null
          this.announcedDown = true
          const text = translate(lang, 'info.connLost')
          for (const ch of allOpenChannels(useLayoutStore.getState().tabs)) this.localInfo(ch, text)
        }, ChatService.OUTAGE_GRACE)
      }
      return
    }

    if (this.outageTimer !== null) {
      clearTimeout(this.outageTimer)
      this.outageTimer = null
    }
    if (this.downSince) {
      // saying "connection restored" while the minute we missed stays a hole is only half the
      // job — go and fetch what happened in it
      this.backfillAfterOutage(this.downSince)
      this.downSince = 0
    }
    // nothing was ever said about it being down, so there is nothing to take back
    if (!this.announcedDown) return
    this.announcedDown = false
    const text = translate(lang, 'info.connRestored')
    for (const ch of allOpenChannels(useLayoutStore.getState().tabs)) this.localInfo(ch, text)
  }

  /**
   * Re-ingest persisted redeems for a channel. Redeems arrive via PubSub in the MAIN window
   * only and are written to localStorage; a standalone highlights window listens for the
   * storage event and calls this so newly-redeemed lines (with the user's color) appear live
   * instead of only after a reopen. prependMessages dedupes by id, so re-adds are no-ops.
   */
  syncPersistedRedeems(channel: string): void {
    const redeems = this.loadPersistedRedeems(channel)
    if (redeems.length) useChatStore.getState().prependMessages(channel, redeems)
  }

  // ---------- outgoing ----------

  /** authenticated per-account connection, used only for sending PRIVMSG */
  private async ensureSender(account: Account): Promise<IrcClient> {
    const existing = this.senders.get(account.id)
    if (existing) return existing
    const clientId = useSettingsStore.getState().clientId
    const token = await ensureFreshToken(clientId, account)
    // ensureFreshToken awaits — a parallel call may have created the sender meanwhile
    const raced = this.senders.get(account.id)
    if (raced) return raced
    this.senderTokens.set(account.id, token)
    const sender = new IrcClient({
      nick: account.login,
      token,
      // re-fetch a fresh (auto-refreshing) token on every reconnect so an expired token can
      // never silently lock the user out — the reconnect logs back in with a refreshed one
      getToken: () => {
        const fresh = getAccount(account.id) ?? account
        return ensureFreshToken(useSettingsStore.getState().clientId, fresh).catch(() => undefined)
      },
      // refresh token itself is dead — surface a persistent "re-authorize" banner
      onAuthFailed: () => useUiStore.getState().markReauthNeeded(account.id, account.login),
      // sender connections only care about being kicked / notices
      onMessage: (m) => {
        if (m.command === 'NOTICE' && m.channel) {
          // "identical to the previous message" — resend it with the invisible tag rather
          // than surfacing an error. This is the safety net for the proactive alternation
          // in dedupeSuffix (which can miss e.g. after a reconnect drops our local state).
          if (m.tags['msg-id'] === 'msg_duplicate' && this.resendTagged(account, m.channel)) return
          this.queue(m.channel, this.systemMessage(m.channel, m.trailing, true))
        }
      }
    })
    this.senders.set(account.id, sender)
    return sender
  }

  /** after a successful re-authorization, resume the account's dead sender connection */
  retrySenderAuth(accountId: string): void {
    this.senders.get(accountId)?.retryAuth()
    useUiStore.getState().clearReauthNeeded(accountId)
  }

  /**
   * Twitch drops a message that is byte-identical to your previous one within ~30s ("your
   * message was not sent because it is identical..."). 7TV/Chatterino get around it by
   * appending an invisible TAG character (U+E0000): Twitch sees a different string while
   * chat renders nothing extra. Alternating it on/off keeps repeats working indefinitely.
   */
  private lastSent = new Map<string, { text: string; at: number; tagged: boolean; retried?: boolean }>()

  /**
   * Twitch refused our last line as a duplicate — push it again with the invisible tag.
   * Returns true when a retry was actually sent (so the error line stays hidden).
   */
  private resendTagged(account: Account, channel: string): boolean {
    if (!useSettingsStore.getState().settings.bypassDuplicateLimit) return false
    const key = `${account.id}:${channel.toLowerCase()}`
    const prev = this.lastSent.get(key)
    if (!prev || Date.now() - prev.at > 30_000 || prev.retried) return false
    this.lastSent.set(key, { ...prev, tagged: true, retried: true })
    this.senders.get(account.id)?.say(channel, `${prev.text} ${DEDUPE_TAG}`)
    return true
  }

  private dedupeSuffix(account: Account, channel: string, text: string): string {
    if (!useSettingsStore.getState().settings.bypassDuplicateLimit) return text
    const key = `${account.id}:${channel.toLowerCase()}`
    const prev = this.lastSent.get(key)
    const now = Date.now()
    const same = !!prev && prev.text === text && now - prev.at < 30_000
    const tagged = same ? !prev.tagged : false
    this.lastSent.set(key, { text, at: now, tagged })
    return tagged ? `${text} ${DEDUPE_TAG}` : text
  }

  async sendMessage(
    account: Account,
    channel: string,
    text: string,
    replyParentMsgId?: string
  ): Promise<void> {
    text = this.dedupeSuffix(account, channel, text)
    const sender = await this.ensureSender(account)
    // send FIRST — no awaits in the hot path (the token check used to add visible input lag).
    // If the socket is stale, say() queues the line and reconnects with a fresh token anyway.
    sender.join(channel)
    sender.say(channel, text, replyParentMsgId)
    // proactive token rotation in the BACKGROUND: if the (cached, cheap) fresh token differs
    // from the one this live connection logged in with, reconnect onto the new one before
    // Twitch drops us — future sends never land in the dead-token window
    void (async () => {
      try {
        const clientId = useSettingsStore.getState().clientId
        const fresh = await ensureFreshToken(clientId, getAccount(account.id) ?? account)
        if (fresh !== this.senderTokens.get(account.id)) {
          this.senderTokens.set(account.id, fresh)
          sender.reconnectWithToken(fresh)
        }
      } catch {
        /* refresh failed — the onAuthFailed path will surface the re-auth banner */
      }
    })()
  }

  dropSender(accountId: string): void {
    this.senders.get(accountId)?.close()
    this.senders.delete(accountId)
    this.senderTokens.delete(accountId)
  }

  /** accounts/channels changed in another window — refresh EventSub + PubSub subscriptions */
  resyncSubscriptions(): void {
    this.eventSub?.resync()
    this.pubSub?.resync()
  }

  /**
   * F5 / manual "reconnect".
   *
   * It used to tear the chat connection down unconditionally, which is wrong when nothing was
   * broken: on a busy channel that is a real gap in the stream, a "connection lost" line, a
   * "restored" line, and every channel rejoining — for a keypress people press to refresh
   * their EMOTES. If the reader is genuinely alive, leave it alone; the rest of what F5 does
   * (emotes, badges, subscriptions) does not need the socket rebuilt.
   */
  reconnect(): void {
    if (this.reader?.isHealthy()) {
      diagInfo('irc', 'refresh requested, connection is healthy — leaving the socket alone')
    } else {
      diagInfo('irc', 'refresh requested, connection is not healthy — rebuilding the socket')
      this.reader?.close()
      useChatStore.getState().setConnState('connecting')
      this.reader = new IrcClient({
        nick: 'anon',
        onMessage: (m) => this.handleReaderMessage(m),
        onOpen: () => this.announceConnection(true),
        onClose: (silentFor) => this.announceConnection(false, silentFor)
      })
      for (const ch of allOpenChannels(useLayoutStore.getState().tabs)) this.reader.join(ch)
    }
    // F5 is the "something's stuck" button — refresh emotes/badges too, and re-establish
    // the EventSub/PubSub subscriptions in case those sockets silently died
    import('./emoteService').then(({ reloadAllEmotes }) => reloadAllEmotes())
    this.eventSub?.resync()
    this.pubSub?.resync()
  }
}

export const chatService = new ChatService()
