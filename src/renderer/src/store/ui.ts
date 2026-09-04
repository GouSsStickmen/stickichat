import { create } from 'zustand'
import { BadgeRef, FavoriteEmote } from '../types'
import { useSettingsStore } from './settings'
import type { ModConfirmRequest } from '../lib/confirmMod'
import type { DropsInfo, SharePrompt } from '../lib/playerPage'

/*
 * What identifies one poll from another, for remembering a dismissal.
 *
 * Not the question: the same card can reach us from two places, Twitch's topic and a reading of
 * the page, and the page does not always find the question. The options are the same either way,
 * which is what makes them the reliable name for it. Without this, closing a finished card only
 * cleared it, the next reading of the page built it again from scratch, without the winner, and it
 * came back from the dead.
 */
function pollKey(poll: PagePollState | null | undefined): string {
  if (!poll) return ''
  // sorted, because a finished poll comes back with the winner first and the same card would
  // otherwise look like a different one
  return poll.options
    .map((o) => o.label.trim())
    .sort()
    .join('|')
}

/** enough of a drop to say whether it has landed */
interface PagePollDropLike {
  claim: boolean
  percent: number
  earned?: boolean
}

/** a card closed by hand: which one it was, and when */
interface PollDismissal {
  key: string
  id: string
  at: number
}

/** ids the page reading invents when Twitch's own id never reached us */
const NAMELESS = ['page', 'poll', 'prediction']

/**
 * Whether a card was closed by hand and must stay closed.
 *
 * Matched on the id whenever there is a real one, and only on the option labels when there is not.
 *
 * The labels alone were the whole test, and they are not one: a prediction is usually the same two
 * words every time, so closing one finished "Так / Ні" card quietly blocked EVERY later prediction
 * with those outcomes — the app announced the next one in chat and then showed no card for it at
 * all, for the rest of the session. Twitch's id is different for each, which is exactly the
 * distinction that was missing. The label match is kept for the one case that needs it, a reading
 * of the page rebuilding a card we have just closed, and it lets go after a quarter of an hour,
 * because by then their card is long out of the page and any match is a new poll.
 */
function dismissed(gone: PollDismissal[] | undefined, poll: PagePollState): boolean {
  if (!gone?.length) return false
  if (poll.id && !NAMELESS.includes(poll.id)) return gone.some((d) => d.id === poll.id)
  const key = pollKey(poll)
  return gone.some((d) => d.key === key && Date.now() - d.at < 900000)
}

/** a poll or prediction as the page shows it */
export interface PagePollState {
  /**
   * Twitch's own id for it, and the reason this is a list rather than one card per channel.
   *
   * A channel can run a poll and a prediction at the same time, and Twitch shows both: keyed by
   * one card per channel, whichever arrived last hid the other.
   */
  id: string
  kind: string
  question: string
  options: { label: string; share: string; votes: string; picked: boolean; mine: number }[]
  open: boolean
  voted: boolean
  /** the poll is over: kept on screen a little longer, with the winner marked */
  ended: boolean
  /**
   * Submissions are closed but the result is not in yet.
   *
   * A prediction sits like this for as long as the streamer takes to pick a winner, which can be
   * most of a stream: nothing more can be staked, and the card says so instead of offering presses
   * that would be refused.
   */
  locked: boolean
  /** the outcome Twitch declared the winner, when it says so outright */
  winner: string | null
  /** who was paid what, for a prediction that has been resolved */
  payouts: { name: string; points: number }[]
  /** how long is left, as the page writes it */
  timeLeft: string | null
  /** how much of the run is gone, 0 to 1 */
  ran: number | null
  /**
   * When voting closes, from Twitch's own poll topic.
   *
   * Their card in the page has no countdown in it at all, so this is where the clock comes from;
   * the card ticks it down itself rather than asking anybody every second.
   */
  endsAt: number | null
  /** how long the whole thing runs for, so the bar knows what a full bar means */
  runsFor: number | null
  /**
   * A prediction rather than a poll.
   *
   * They are taken part in differently: a poll wants one press, a prediction wants an amount of
   * channel points on one side, and its card has to offer that.
   */
  isPrediction: boolean
  /**
   * What THIS account has put on each outcome, by label, as far as we know it ourselves.
   *
   * Twitch's topic names only the top ten predictors of each side, so a modest bet of our own is
   * simply not in it: the card had no way to show what you had staked, and the side you backed was
   * not marked at all until you were among the biggest bettors on it. What we placed ourselves is
   * remembered here instead, and every update takes the larger of the two.
   */
  myStakes?: Record<string, number>
}

/** everything the open Twitch page says about this channel's points */
export interface PagePoints {
  balance: number | null
  /** the balance exactly as the page writes it, abbreviations and all */
  balanceText: string | null
  chest: boolean
  icon: string | null
  multiplier: string | null
  live: boolean
  streak: number | null
  streakLeft: number | null
  streakReward: number | null
  /** this stream has been counted towards the streak, as the page's own progress bar says */
  streakClaimed: boolean
}

const EMPTY_POINTS: PagePoints = {
  balance: null,
  balanceText: null,
  chest: false,
  icon: null,
  multiplier: null,
  live: false,
  streak: null,
  streakLeft: null,
  streakReward: null,
  streakClaimed: false
}

export interface UserCardTarget {
  channel: string
  channelId: string
  userId: string
  login: string
  displayName: string
  color?: string
  badges: BadgeRef[]
  /** pane account used for mod actions from the card */
  accountId: string | null
  x: number
  y: number
}

/** an emote awaiting a decision about which favourite categories it belongs to */
export interface EmoteFolderMenu {
  key: string
  emote: FavoriteEmote
  x: number
  y: number
  /** the shelf it was right-clicked in, which is the only one "remove from this category" can mean */
  fromFolderId?: string | null
}

/** a rectangle a pane has reserved for its player, in viewport coordinates */
export interface PlayerSlot {
  x: number
  y: number
  w: number
  h: number
  /** the pane's own box, which the resize drags measure against */
  boxRight: number
  boxHeight: number
}

export interface Toast {
  id: number
  text: string
  kind: 'ok' | 'error'
  /** stable key for "don't show again": the message text with volatile bits stripped */
  muteKey?: string
  /** how long it should stay, in ms. The row owns the clock so hovering can stop it. */
  ms: number
}

export interface EmotePreviewTarget {
  url: string
  code: string
  x: number
  y: number
  /** link-preview artwork: render big and aspect-correct instead of in a square emote box */
  wide?: boolean
  /** zero-width emotes layered on top of this one — previewed as the finished combination */
  overlayUrls?: string[]
  /** extra caption lines under the name (provider, author…) */
  subtitle?: string[]
  /** requested width for a `wide` preview, px */
  wideSize?: number
}

export interface ChannelPrompt {
  /** channel login the user is offered to add */
  channel: string
  /** who started the raid / gave the shoutout (for the "X → Y" prompt text) */
  from?: string
  /** channel is already open in some tab — offer to SWITCH instead of adding */
  existing?: boolean
  /** this prompt is a shoutout (adds a "follow ↗" action + different wording) */
  shoutout?: boolean
}

/** the hype train currently running in one of the open channels (one at a time, like Twitch) */
export interface HypeTrain {
  channel: string
  /** regular · shared · golden/mythic · community — decides its dress and its noise */
  flavour: 'regular' | 'shared' | 'golden' | 'community'
  level: number
  /** points into the current level and what it needs — the bar */
  value: number
  goal: number
  /** unix ms the train expires at unless someone feeds it */
  expiresAt: number
  /** last contributor, shown under the bar */
  by?: string
  /** set when it is over: the popup lingers a few seconds on the result */
  ended?: 'COMPLETED' | 'EXPIRE'
}

/**
 * The link preview that is open right now, and where on screen it was asked for.
 *
 * One at a time, and OUTSIDE the message list. A card drawn inline is part of the document:
 * opening it makes the row taller, which moves every row below it, which is a scroll problem
 * dressed up as a preview. Anchoring it to the click instead means the chat's geometry never
 * changes at all — nothing to compensate for, nothing to jump.
 */
export interface LinkCardTarget {
  url: string
  /** where the link sits on screen, so the card can open beside it and stay in the window */
  x: number
  y: number
  /** hover-opened cards close themselves when the pointer leaves; clicked ones stay */
  sticky: boolean
}

interface UiState {
  settingsOpen: boolean
  /** which settings section to land on when the modal/window opens next */
  settingsSection: string | null
  addAccountOpen: boolean
  userCard: UserCardTarget | null
  toasts: Toast[]
  emotePreview: EmotePreviewTarget | null
  /** the floating link preview card, or null when none is open */
  linkCard: LinkCardTarget | null
  /** mass-gift groups the user expanded (header message id -> true) */
  expandedGifts: Record<string, boolean>
  /** small "add this channel?" prompt (raids) */
  channelPrompt: ChannelPrompt | null
  hypeTrain: HypeTrain | null
  /**
   * The channel whose train popup the reader closed by hand.
   *
   * Closing it used to last until the next contribution, which on a train being fed a gift sub
   * every few seconds is no time at all — the popup came straight back and the ✕ read as
   * broken. A dismissal now holds for the rest of THAT train; the service clears it when the
   * train ends, so the next one is announced normally.
   */
  hypeDismissed: string | null
  whispersOpen: boolean
  /** the followed-channels list, opened from the top bar */
  followsOpen: boolean
  setFollowsOpen: (v: boolean) => void
  /** split mode: scrolling one pane scrolls the others by the same amount */
  /** accounts whose token died and need a full re-authorization (persistent banner) */
  reauthAccounts: { id: string; login: string }[]
  setSettingsOpen: (v: boolean) => void
  setSettingsSection: (v: string | null) => void
  toggleGiftGroup: (id: string) => void
  setAddAccountOpen: (v: boolean) => void
  setUserCard: (v: UserCardTarget | null) => void
  /**
   * @param opts.muteKey lets a non-error toast carry a "don't show again" button too — the mute
   *   machinery already existed, it was simply reachable only from errors.
   * @param opts.ms how long it stays. An explanation needs longer on screen than a confirmation.
   */
  toast: (text: string, kind?: 'ok' | 'error', opts?: { muteKey?: string; ms?: number }) => void
  dismissToast: (id: number) => void
  setEmotePreview: (v: EmotePreviewTarget | null) => void
  setLinkCard: (v: LinkCardTarget | null) => void
  setChannelPrompt: (v: ChannelPrompt | null) => void
  /**
   * A pending "are you sure" for a ban or a timeout, holding the promise that waits on the answer.
   * Null whenever nothing is being asked — see lib/confirmMod.ts.
   */
  modConfirm: ModConfirmRequest | null
  setModConfirm: (v: ModConfirmRequest | null) => void
  /**
   * The message whose action sheet is open, by id — touch only.
   *
   * An id rather than the message: the row that owns it already has everything the sheet needs
   * (its mod buttons, its permissions, its action context), so it draws the sheet itself and no
   * copy of that logic has to exist anywhere else.
   */
  heldMsgId: string | null
  setHeldMsgId: (v: string | null) => void
  /**
   * Seconds the stream is behind the broadcaster, per channel.
   *
   * Lives here rather than inside the player because it is drawn on the pane's own header strip:
   * over the video it covered the picture, and it is information about the stream rather than part
   * of it. Null when no player is running for that channel.
   */
  streamLatency: Record<string, number | null>
  setStreamLatency: (channel: string, seconds: number | null) => void
  /**
   * Channels with a player running, and where on screen each one should be drawn.
   *
   * Both live here rather than in the pane because the pane is unmounted the moment you look at
   * another tab, and taking the player down with it meant every tab switch restarted the stream
   * and played another advert. The players are rendered once, above everything, and follow the
   * empty slot their pane leaves for them; a channel whose pane is not on screen keeps playing
   * parked off to the side.
   */
  openPlayers: string[]
  togglePlayer: (channel: string, on: boolean) => void
  /**
   * Streams silenced the way a browser silences a tab.
   *
   * Turning the player's own volume down is the obvious way to shut a stream up and the wrong one:
   * Twitch counts a muted player as not watching and stops the channel points. This mutes the
   * webview instead, so as far as the page is concerned the sound is still playing.
   *
   * Kept here rather than inside the player because the player is re-created whenever the layout
   * changes, and silence should not come back on by itself.
   */
  mutedPlayers: string[]
  setPlayerMuted: (channel: string, muted: boolean) => void
  /**
   * What the open Twitch page says about this channel's points.
   *
   * Read out of the page rather than fetched: viewer side channel points exist in no API we are
   * allowed to call. Only a channel with a running player in site mode ever appears here.
   */
  playerPoints: Record<string, PagePoints>
  /**
   * What the open page says about this channel's drops.
   *
   * Same reason as the points: a viewer's progress towards a drop exists in no API we may call,
   * only in the page, and only while a player is running there.
   */
  playerDrops: Record<string, DropsInfo>
  setPlayerDrops: (channel: string, info: DropsInfo | null) => void
  /**
   * Rewards that finished while we were watching, per channel.
   *
   * The chest lights up for these and keeps lighting up until the panel is opened, so a drop that
   * lands while you are reading something else is still there to be noticed afterwards.
   */
  dropsGot: Record<string, string[]>
  clearDropsGot: (channel: string) => void
  /**
   * The drops this account already owns, from Twitch's own inventory page.
   *
   * The channel page knows what is on offer and how far along it is, and says nothing at all once
   * a drop has been earned: their chest simply goes. The inventory is the other half, and the only
   * place that names what was actually received and when.
   */
  dropsOwned: { name: string; when: string; icon: string | null }[]
  /** when that list was last read, so the panel does not load their page on every open */
  dropsOwnedAt: number
  setDropsOwned: (items: { name: string; when: string; icon: string | null }[]) => void
  /**
   * What each reward says about itself, per channel, keyed the way the list keys them.
   *
   * Read one at a time out of the page while the rewards panel is open, and kept here so it is
   * only ever read once: opening a reward's own card in their panel is the only place the
   * streamer's explanation exists.
   */
  rewardDesc: Record<string, Record<string, string>>
  setRewardDesc: (channel: string, key: string, desc: string) => void
  /**
   * Twitch's own "share this" card, as the open page shows it.
   *
   * It appears when something has just happened to you on the channel — a watch streak taken, a
   * subscription reward — and it is the only place that offer lives, so it is read out of the page
   * and drawn where the rest of the app can see it. Closed by hand it stays closed until the card
   * itself is about something else.
   */
  playerShare: Record<string, SharePrompt | null>
  setPlayerShare: (channel: string, prompt: SharePrompt | null) => void
  shareDismissed: Record<string, string>
  dismissShare: (channel: string) => void
  /**
   * Folded away into the little button beside the channel rewards, per channel.
   *
   * Closing their offer is not the same as turning it down: the card is in the way of the chat,
   * and the share is still worth having a minute later. It goes into an icon and comes back from
   * there; only sharing it, or the offer itself changing, ends it.
   */
  shareTucked: Record<string, boolean>
  tuckShare: (channel: string, tucked: boolean) => void
  /**
   * Every poll and prediction running in a channel, drawn by the app itself.
   *
   * Their own cards cannot be moved out of the page, and shown over the video they flickered as
   * their React redrew them, so the state comes from Twitch's own topics and the app draws from
   * this, passing votes back to their buttons.
   */
  pagePolls: Record<string, PagePollState[]>
  /** add one or update it in place, matched on its id */
  setPagePoll: (channel: string, poll: PagePollState | null, id?: string) => void
  /**
   * Closed by hand, and it must stay closed.
   *
   * Clearing the card was not enough: Twitch keeps its own card in the page for a while after the
   * voting ends, so the next reading built the whole thing again from scratch, without the winner
   * this time, and the card came back from the dead. A dismissal is remembered against the poll it
   * was for, so only a NEW poll can put a card back.
   */
  dismissPagePoll: (channel: string, id?: string) => void
  /**
   * How much this account has just put on one outcome, remembered card-side.
   *
   * Twitch's topic lists the top ten predictors of a side and nobody else, so our own bet is
   * usually invisible in it. This is what makes the card able to say "you have 300 on this one"
   * the moment the points leave, and to keep saying it as the topic sends its updates.
   */
  notePagePollStake: (channel: string, id: string, label: string, points: number) => void
  /** cards closed by hand, per channel */
  pagePollDismissed: Record<string, PollDismissal[]>
  /**
   * Folded away into the little button beside the channel rewards, per channel.
   *
   * A locked prediction can hang about for an hour, and a panel across the top of the chat for an
   * hour is in the way. Out of sight but one press from coming back.
   */
  pagePollHidden: Record<string, boolean>
  hidePagePoll: (channel: string, hidden: boolean) => void
  setPlayerPoints: (channel: string, points: Partial<PagePoints> | null) => void
  /** where the pane wants its player, in viewport coordinates, plus the box to resize against */
  playerSlots: Record<string, PlayerSlot | null>
  setPlayerSlot: (channel: string, slot: PlayerSlot | null) => void
  /**
   * "Which categories should this emote be in?", opened with Alt+right-click.
   *
   * In the store rather than the picker because the same question is asked from chat, where the
   * picker is not mounted at all — and the answer is the same list either way.
   */
  emoteFolderMenu: EmoteFolderMenu | null
  setEmoteFolderMenu: (v: EmoteFolderMenu | null) => void
  setHypeTrain: (v: HypeTrain | null) => void
  dismissHypeTrain: () => void
  allowHypeTrain: () => void
  setWhispersOpen: (v: boolean) => void
  markReauthNeeded: (id: string, login: string) => void
  clearReauthNeeded: (id: string) => void
}

let toastId = 0

/**
 * Identity of an error for the "don't show again" list: the same failure carries different
 * accounts/nicks/durations each time, so strip the volatile parts and keep the wording.
 */
export function errorMuteKey(text: string): string {
  return text
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

export const useUiStore = create<UiState>()((set) => ({
  settingsOpen: false,
  settingsSection: null,
  addAccountOpen: false,
  userCard: null,
  toasts: [],
  emotePreview: null,
  linkCard: null,
  expandedGifts: {},
  channelPrompt: null,
  hypeTrain: null,
  hypeDismissed: null,
  whispersOpen: false,
  reauthAccounts: [],
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  toggleGiftGroup: (id) =>
    set((s) => ({ expandedGifts: { ...s.expandedGifts, [id]: !s.expandedGifts[id] } })),
  setAddAccountOpen: (addAccountOpen) => set({ addAccountOpen }),
  setUserCard: (userCard) => set({ userCard }),
  toast: (text, kind = 'ok', opts) => {
    const muteKey = opts?.muteKey ?? (kind === 'error' ? errorMuteKey(text) : undefined)
    // silently drop errors the user has told us to stop showing
    if (muteKey && useSettingsStore.getState().settings.mutedErrors.includes(muteKey)) return
    const id = ++toastId
    // errors carry explanations now, so they get longer on screen than a confirmation
    const ms = opts?.ms ?? (kind === 'error' ? 10000 : 3500)
    set((s) => ({ toasts: [...s.toasts, { id, text, kind, muteKey, ms }] }))
    // error toasts can optionally chime; lazy import avoids a static ui⇄sound cycle
    if (kind === 'error') {
      import('../lib/sound').then((m) => m.playErrorSound()).catch(() => {})
    }
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setEmotePreview: (emotePreview) => set({ emotePreview }),
  setLinkCard: (linkCard) => set({ linkCard }),
  setChannelPrompt: (channelPrompt) => set({ channelPrompt }),
  modConfirm: null,
  setModConfirm: (modConfirm) => set({ modConfirm }),
  heldMsgId: null,
  setHeldMsgId: (heldMsgId) => set({ heldMsgId }),
  openPlayers: [],
  togglePlayer: (channel, on) =>
    set((s) => ({
      openPlayers: on
        ? s.openPlayers.includes(channel)
          ? s.openPlayers
          : [...s.openPlayers, channel]
        : s.openPlayers.filter((c) => c !== channel)
    })),
  pagePolls: {},
  pagePollDismissed: {},
  pagePollHidden: {},
  hidePagePoll: (channel, hidden) =>
    set((s) => ({ pagePollHidden: { ...s.pagePollHidden, [channel]: hidden } })),
  dismissPagePoll: (channel, id) =>
    set((s) => {
      const list = s.pagePolls[channel] ?? []
      const gone = id ? list.filter((p) => p.id === id) : list
      const at = Date.now()
      return {
        pagePolls: { ...s.pagePolls, [channel]: id ? list.filter((p) => p.id !== id) : [] },
        pagePollDismissed: {
          ...s.pagePollDismissed,
          [channel]: [
            ...(s.pagePollDismissed[channel] ?? []),
            ...gone.map((p) => ({ key: pollKey(p), id: p.id, at }))
          ].slice(-10)
        }
      }
    }),
  setPagePoll: (channel, poll, id) =>
    set((s) => {
      const list = s.pagePolls[channel] ?? []
      if (!poll) {
        const next = id ? list.filter((p) => p.id !== id) : []
        if (next.length === list.length && next.length === 0) return {}
        return { pagePolls: { ...s.pagePolls, [channel]: next } }
      }
      if (dismissed(s.pagePollDismissed[channel], poll)) return {}
      const at = list.findIndex((p) => p.id === poll.id)
      if (at >= 0 && JSON.stringify(list[at]) === JSON.stringify(poll)) return {}
      const next = at >= 0 ? list.map((p, i) => (i === at ? poll : p)) : [...list, poll]
      return { pagePolls: { ...s.pagePolls, [channel]: next } }
    }),
  notePagePollStake: (channel, id, label, points) =>
    set((s) => {
      const list = s.pagePolls[channel] ?? []
      const at = list.findIndex((p) => p.id === id)
      if (at < 0) return {}
      const card = list[at]
      const had = card.myStakes?.[label] ?? 0
      const mine = had + points
      const grown = {
        ...card,
        myStakes: { ...(card.myStakes ?? {}), [label]: mine },
        options: card.options.map((o) =>
          o.label === label ? { ...o, mine: Math.max(o.mine, mine), picked: true } : o
        )
      }
      return { pagePolls: { ...s.pagePolls, [channel]: list.map((p, i) => (i === at ? grown : p)) } }
    }),
  playerPoints: {},
  setPlayerPoints: (channel, points) =>
    set((s) => {
      const old = s.playerPoints[channel]
      if (!points) {
        if (!old) return {}
        const next = { ...s.playerPoints }
        delete next[channel]
        return { playerPoints: next }
      }
      // merged, because the balance and the streak arrive from two different reads
      const merged = { ...EMPTY_POINTS, ...old, ...points }
      /*
       * A reading that lost the balance does not mean the balance is gone.
       *
       * Twitch borrows that spot in its chat bar for a moment when something lands: a streak
       * takes it over with a flame and a number of its own, and while that is up there is no
       * points balance in the page to read at all. Ours went to "..." at exactly the moment the
       * reader was looking at it. What was last known stays until a real number replaces it.
       */
      if (!merged.balanceText && old?.balanceText) {
        merged.balanceText = old.balanceText
        /*
         * The number goes with the words, not on its own.
         *
         * Without the labelled element the reading falls back to any digits-only line in their
         * summary, and while the streak chip is up that line is the streak itself: the balance
         * would have read 6, and climbing back to 172 057 afterwards would have been announced as
         * a gain of a hundred and seventy thousand points.
         */
        if (old.balance != null) merged.balance = old.balance
      }
      if (merged.balance === null && old?.balance != null) merged.balance = old.balance
      if (merged.icon === null && old?.icon) merged.icon = old.icon
      // the poll runs every few seconds: only a real change should wake the panes
      if (old && (Object.keys(merged) as (keyof PagePoints)[]).every((k) => merged[k] === old[k])) {
        return {}
      }
      return { playerPoints: { ...s.playerPoints, [channel]: merged } }
    }),
  playerDrops: {},
  dropsGot: {},
  playerShare: {},
  shareDismissed: {},
  shareTucked: {},
  tuckShare: (channel, tucked) =>
    set((s) => ({ shareTucked: { ...s.shareTucked, [channel]: tucked } })),
  dismissShare: (channel) =>
    set((s) => {
      const now = s.playerShare[channel]
      if (!now) return {}
      return {
        playerShare: { ...s.playerShare, [channel]: null },
        shareDismissed: { ...s.shareDismissed, [channel]: now.title },
        shareTucked: { ...s.shareTucked, [channel]: false }
      }
    }),
  setPlayerShare: (channel, prompt) =>
    set((s) => {
      const old = s.playerShare[channel]
      if (!prompt) {
        if (!old) return {}
        return { playerShare: { ...s.playerShare, [channel]: null } }
      }
      // the one it was closed for stays closed; a card about something else is a new offer
      if (s.shareDismissed[channel] === prompt.title) return {}
      if (old && old.title === prompt.title && old.note === prompt.note) return {}
      // a different offer is a different card: it deserves to be seen rather than to arrive folded
      const tucked = old && old.title === prompt.title ? s.shareTucked[channel] : false
      return {
        playerShare: { ...s.playerShare, [channel]: prompt },
        shareTucked: { ...s.shareTucked, [channel]: !!tucked }
      }
    }),
  rewardDesc: {},
  setRewardDesc: (channel, key, desc) =>
    set((s) => {
      const had = s.rewardDesc[channel] ?? {}
      if (had[key] === desc) return {}
      return { rewardDesc: { ...s.rewardDesc, [channel]: { ...had, [key]: desc } } }
    }),
  clearDropsGot: (channel) =>
    set((s) => (s.dropsGot[channel]?.length ? { dropsGot: { ...s.dropsGot, [channel]: [] } } : {})),
  dropsOwned: [],
  dropsOwnedAt: 0,
  setDropsOwned: (items) => set({ dropsOwned: items, dropsOwnedAt: Date.now() }),
  setPlayerDrops: (channel, info) =>
    set((s) => {
      const old = s.playerDrops[channel]
      if (!info) {
        if (!old) return {}
        const next = { ...s.playerDrops }
        delete next[channel]
        return { playerDrops: next }
      }
      /*
       * One campaign, several drops, each with a life of its own.
       *
       * A channel can offer more than one at a time — one for watching and one for subscribing is
       * the usual pair — and as each is earned Twitch takes THAT card out of its panel and leaves
       * the rest. So the reading is merged with the last one rather than replacing it: a reward
       * that was there and is not any more has landed, and it stays in our list marked as landed,
       * while the others go on counting. Handled the same way whether one of three goes or the
       * chest disappears altogether, which is what the last of them looks like.
       */
      const before = old?.items ?? []
      const got = [...(s.dropsGot[channel] ?? [])]
      const mark = (name: string): void => {
        if (name && !got.includes(name)) got.push(name)
      }
      const done = (d: PagePollDropLike): boolean => !!d.earned || d.claim || d.percent >= 100
      const now = info.items.map((item) => {
        const was = before.find((b) => b.name === item.name)
        if (done(item) && !(was && done(was))) mark(item.name)
        // a card their panel still shows, but which we already know arrived, stays marked
        return was?.earned ? { ...item, earned: true } : item
      })
      const landed = before
        .filter((b) => !info.items.some((i) => i.name === b.name))
        .map((b) => {
          if (!b.earned) mark(b.name)
          return { ...b, earned: true, percent: 100 }
        })
      const merged = { ...info, items: [...now, ...landed], gone: !info.any }
      if (
        old &&
        JSON.stringify(old) === JSON.stringify(merged) &&
        (s.dropsGot[channel] ?? []).length === got.length
      ) {
        return {}
      }
      // nothing here at all, and nothing ever was: forget the channel rather than keep an empty one
      if (!info.any && merged.items.length === 0) {
        if (!old) return {}
        const next = { ...s.playerDrops }
        delete next[channel]
        return { playerDrops: next }
      }
      return {
        playerDrops: { ...s.playerDrops, [channel]: merged },
        dropsGot: { ...s.dropsGot, [channel]: got }
      }
    }),
  mutedPlayers: [],
  setPlayerMuted: (channel, muted) =>
    set((s) => ({
      mutedPlayers: muted
        ? s.mutedPlayers.includes(channel)
          ? s.mutedPlayers
          : [...s.mutedPlayers, channel]
        : s.mutedPlayers.filter((c) => c !== channel)
    })),
  playerSlots: {},
  setPlayerSlot: (channel, slot) =>
    set((s) => {
      const old = s.playerSlots[channel]
      if (
        old === slot ||
        (old && slot && old.x === slot.x && old.y === slot.y && old.w === slot.w && old.h === slot.h)
      ) {
        return s
      }
      return { playerSlots: { ...s.playerSlots, [channel]: slot } }
    }),
  streamLatency: {},
  setStreamLatency: (channel, seconds) =>
    set((s) =>
      s.streamLatency[channel] === seconds
        ? s
        : { streamLatency: { ...s.streamLatency, [channel]: seconds } }
    ),
  emoteFolderMenu: null,
  setEmoteFolderMenu: (emoteFolderMenu) => set({ emoteFolderMenu }),
  setHypeTrain: (hypeTrain) => set((s) => (hypeTrain && s.hypeDismissed === hypeTrain.channel ? s : { hypeTrain })),
  dismissHypeTrain: () =>
    set((s) => ({ hypeTrain: null, hypeDismissed: s.hypeTrain?.channel ?? s.hypeDismissed })),
  allowHypeTrain: () => set({ hypeDismissed: null }),
  setWhispersOpen: (whispersOpen) => set({ whispersOpen }),
  followsOpen: false,
  setFollowsOpen: (followsOpen) => set({ followsOpen }),
  markReauthNeeded: (id, login) =>
    set((s) =>
      s.reauthAccounts.some((a) => a.id === id)
        ? s
        : { reauthAccounts: [...s.reauthAccounts, { id, login }] }
    ),
  clearReauthNeeded: (id) =>
    set((s) => ({ reauthAccounts: s.reauthAccounts.filter((a) => a.id !== id) }))
}))
