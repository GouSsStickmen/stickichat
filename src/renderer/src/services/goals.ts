import { GoalOverlayConfig, OverlayLineData } from '../types'
import { useSettingsStore } from '../store/settings'
import { useAccountsStore } from '../store/accounts'
import { useChatStore } from '../store/chat'
import { getFollowerTotal, getSubTotal, getUsers } from '../lib/helix'
import { diagWarn } from '../lib/diag'

/**
 * Keeping goal overlays supplied with a number.
 *
 * Two sources, because there is no single one that works for everything. Followers and
 * subscribers have a real total on Twitch, so a goal for those should show the real total —
 * anything else would disagree with the dashboard the streamer is looking at. Bits have no such
 * endpoint at all, and neither does "how many since I started tonight", so those are counted from
 * what chat announces.
 *
 * The count lives in the config rather than in the overlay page: OBS sources reload, and a
 * counter that resets when a browser source restarts is worse than no counter. It also means the
 * editor can show the number, reset it, and set the starting point.
 */

const POLL_MS = 60_000

function goalsOf(): GoalOverlayConfig[] {
  const list = useSettingsStore.getState().settings.chatOverlays
  return list.filter((o): o is GoalOverlayConfig => o.type === 'goal')
}

/** write a new progress value back into the overlay it belongs to */
function setProgress(id: string, value: number): void {
  const st = useSettingsStore.getState()
  const list = st.settings.chatOverlays
  const cur = list.find((o) => o.id === id)
  if (!cur || cur.type !== 'goal' || cur.progress === value) return
  st.setSettings({ chatOverlays: list.map((o) => (o.id === id ? { ...o, progress: value } : o)) })
}

/**
 * The channel a goal watches.
 *
 * Falling back to "the first open chat" was wrong in the way that is hardest to notice: the first
 * key of the channel-id map is whichever channel happened to answer first, so a goal with no
 * channel of its own quietly asked Twitch about somebody else's followers, got a 401 because the
 * account does not moderate them, and sat at zero forever with nothing to show for it.
 *
 * A follower or subscriber goal is nearly always about the streamer's own channel, so that is the
 * fallback — and only then whatever chat is open.
 */
function channelOf(g: GoalOverlayConfig): string {
  if (g.channel) return g.channel.toLowerCase()
  const mine = useAccountsStore.getState().accounts.find((a) => a._accessToken)?.login?.toLowerCase()
  if (mine) return mine
  return Object.keys(useChatStore.getState().channelIds)[0] ?? ''
}

/**
 * login → broadcaster id, for channels whose chat is not open.
 *
 * The app normally learns ids from ROOMSTATE, which only arrives on joining a chat — so a goal
 * could only ever watch a channel that happened to have a tab open, and said so with a message
 * about an id it did not have. Asking Twitch directly removes the dependency entirely. Ids never
 * change, so one lookup per login for the life of the session is enough.
 */
const idCache = new Map<string, string>()

async function broadcasterId(channel: string): Promise<string | null> {
  const known = useChatStore.getState().channelIds[channel]
  if (known) return known
  const cached = idCache.get(channel)
  if (cached) return cached
  const account = useAccountsStore.getState().accounts.find((a) => a._accessToken)
  if (!account) return null
  const users = await getUsers(account, { logins: [channel] })
  const id = users[0]?.id
  if (!id) return null
  idCache.set(channel, id)
  return id
}

/** what the last attempt to read this goal's number did; the editor shows it */
export type GoalStatus = { ok: boolean; text: string; at: number }
const status = new Map<string, GoalStatus>()
export function goalStatus(id: string): GoalStatus | undefined {
  return status.get(id)
}

/**
 * Add up what chat announces. Called for every overlay line, so it stays cheap: the common case
 * is a plain message with no goal wanting it, and that costs one loop over a list that is almost
 * always empty.
 */
export function countGoalEvent(channel: string, line: OverlayLineData): void {
  const list = goalsOf()
  if (!list.length) return
  const ch = channel.toLowerCase()
  for (const g of list) {
    if (g.source !== 'events') continue
    if ((g.channel ? g.channel.toLowerCase() : channelOf(g)) !== ch) continue
    let add = 0
    if (g.metric === 'bits' && line.bits) add = line.bitsAmount ?? 0
    else if (g.metric === 'subs' && line.subCount) {
      // a gift only counts when the streamer wants gifts counted; the mass-gift header is
      // already worth zero, so a batch adds exactly as many as were actually given
      if (line.subGift && !g.countGifts) add = 0
      else add = line.subCount
    }
    if (add > 0) setProgress(g.id, (g.progress || 0) + add)
  }
}

/**
 * A follow, straight from EventSub.
 *
 * Follows are the one metric with no trace in chat at all, which is why a follower goal set to
 * count events never moved a pixel. This is called from the EventSub dispatcher.
 */
export function countFollow(channel: string): void {
  const ch = channel.toLowerCase()
  for (const g of goalsOf()) {
    if (g.metric !== 'followers') continue
    if (channelOf(g) !== ch) continue
    // an automatic goal is showing Twitch's own total, so a new follow moves it by one right away
    // instead of waiting out the poll interval; the next poll corrects any drift
    setProgress(g.id, (g.progress || 0) + 1)
  }
}

/** read one goal's number now, and remember why if it could not be read */
export async function refreshGoal(g: GoalOverlayConfig): Promise<GoalStatus> {
  const mark = (ok: boolean, text: string): GoalStatus => {
    const s = { ok, text, at: Date.now() }
    status.set(g.id, s)
    return s
  }
  if (g.source !== 'auto' || (g.metric !== 'followers' && g.metric !== 'subs')) {
    return mark(true, 'Рахується з подій чату')
  }
  const ch = channelOf(g)
  if (!ch) return mark(false, 'Немає каналу — обери його в цьому оверлеї')
  const bid = await broadcasterId(ch)
  if (!bid) return mark(false, `Не вдалось дізнатись id каналу ${ch} — перевір назву та авторизацію акаунта`)
  const accounts = useAccountsStore.getState().accounts
  // the subscriber total is broadcaster-only and the follower total wants the broadcaster or one
  // of its mods, so the account that IS this channel is the one to ask with
  const account =
    accounts.find((a) => a.login?.toLowerCase() === ch && a._accessToken) ??
    accounts.find((a) => a._accessToken)
  if (!account) return mark(false, 'Немає авторизованого акаунта')
  try {
    const total =
      g.metric === 'followers' ? await getFollowerTotal(account, bid) : await getSubTotal(account, bid)
    if (typeof total !== 'number') {
      return mark(
        false,
        g.metric === 'subs'
          ? `Twitch відмовив: підписників видно лише власнику каналу (${ch})`
          : `Twitch відмовив: потрібні права модератора каналу ${ch}`
      )
    }
    setProgress(g.id, total)
    return mark(true, `Twitch: ${total} — ${ch}`)
  } catch (e) {
    diagWarn('goals', `poll failed for ${g.name}: ${String(e)}`)
    return mark(false, `Помилка запиту: ${String(e)}`)
  }
}

let timer: ReturnType<typeof setInterval> | null = null
let running = false

/** ask Twitch for the totals the automatic goals want */
async function poll(): Promise<void> {
  if (running) return
  running = true
  try {
    for (const g of goalsOf()) {
      if (g.source !== 'auto' || (g.metric !== 'followers' && g.metric !== 'subs')) continue
      await refreshGoal(g)
    }
  } finally {
    running = false
  }
}

/**
 * Reference counted, because the caller is a React effect whose cleanup arrives through a dynamic
 * import: under a double-invoked effect the stop for the first mount can land AFTER the start for
 * the second, and a plain flag would leave the app with no poller at all.
 */
let holders = 0

export function startGoals(): void {
  holders += 1
  if (timer) return
  void poll()
  timer = setInterval(() => void poll(), POLL_MS)
}

export function stopGoals(): void {
  holders = Math.max(0, holders - 1)
  if (holders > 0 || !timer) return
  clearInterval(timer)
  timer = null
}
