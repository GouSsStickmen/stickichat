import { ChatMessage, OverlayLineData, RouletteOverlayConfig } from '../types'
import { useSettingsStore } from '../store/settings'

/**
 * Spinning the wheel.
 *
 * The winner is picked HERE, not on the overlay page, for two reasons that both matter on stream:
 * two browser sources pointed at the same overlay must land on the same wedge, and the result has
 * to be announceable in chat as exactly the word the wheel is showing. A page rolling its own dice
 * could guarantee neither.
 *
 * The spin then travels as an ordinary overlay line, so it reaches OBS through the machinery that
 * already exists rather than a second channel that would have to be kept alive separately.
 */

/** last spin per overlay id, for the cooldown */
const lastSpin = new Map<string, number>()

function wheelsOf(): RouletteOverlayConfig[] {
  return useSettingsStore
    .getState()
    .settings.chatOverlays.filter((o): o is RouletteOverlayConfig => o.type === 'roulette')
}

/**
 * Pick a wedge, weighted.
 *
 * A wedge is drawn as wide as its weight, so the odds a viewer can see on screen are the odds the
 * draw actually uses — anything else is a wheel that lies.
 */
export function pickWinner(w: RouletteOverlayConfig): number {
  const list = w.sections ?? []
  if (!list.length) return -1
  let total = 0
  for (const s of list) total += Math.max(0.0001, s.weight || 1)
  let roll = Math.random() * total
  for (let i = 0; i < list.length; i++) {
    roll -= Math.max(0.0001, list[i].weight || 1)
    if (roll <= 0) return i
  }
  return list.length - 1
}

/** the channel a wheel belongs to; its own if it names one, else the first open chat */
function channelOf(w: RouletteOverlayConfig, fallback: string): string {
  return (w.channel || fallback || '').toLowerCase()
}

export interface SpinResult {
  ok: boolean
  label?: string
  reason?: string
}

/**
 * Spin one wheel: choose, send, and optionally say what came up.
 *
 * `force` is the editor's test button, which ignores the cooldown — the cooldown exists to stop
 * chat spamming the wheel, not to stop the streamer from seeing what they are building.
 */
export function spinWheel(w: RouletteOverlayConfig, fallbackChannel: string, force = false): SpinResult {
  const list = w.sections ?? []
  if (!list.length) return { ok: false, reason: 'Немає секцій' }
  const now = Date.now()
  const cd = Math.max(0, w.cooldownS || 0) * 1000
  if (!force && cd > 0 && now - (lastSpin.get(w.id) ?? 0) < cd) {
    const left = Math.ceil((cd - (now - (lastSpin.get(w.id) ?? 0))) / 1000)
    return { ok: false, reason: `Ще ${left} с` }
  }
  const index = pickWinner(w)
  if (index < 0) return { ok: false, reason: 'Немає секцій' }
  lastSpin.set(w.id, now)
  const label = list[index].label
  const channel = channelOf(w, fallbackChannel)
  const spinMs = Math.max(300, (w.spinS || 6) * 1000)

  const line: OverlayLineData = {
    id: `wheel-${now}-${Math.random().toString(36).slice(2)}`,
    user: '',
    login: '',
    nick: '',
    color: '',
    badges: [],
    body: '',
    kind: 'info',
    ts: now,
    wheel: { index, label, spinMs, turns: Math.max(0, w.turns || 5), id: `${w.id}:${now}` }
  }
  window.sticki.overlayPush(channel, line)

  if (w.announce && channel) {
    // said only once the wheel has actually landed, or chat spoils the result before the viewers
    // have watched it stop
    window.setTimeout(() => {
      void (async () => {
        const [{ chatService }, { useAccountsStore }] = await Promise.all([
          import('./chatService'),
          import('../store/accounts')
        ])
        const account =
          useAccountsStore.getState().accounts.find((a) => a.login?.toLowerCase() === channel && a._accessToken) ??
          useAccountsStore.getState().accounts.find((a) => a._accessToken)
        if (!account) return
        const text = (w.announceText || '{result}').split('{result}').join(label)
        await chatService.sendMessage(account, channel, text)
      })()
    }, spinMs + 250)
  }

  // a wedge that removes itself on winning is how a giveaway avoids handing out the same prize
  // twice; done after the spin is sent, so the page draws the wheel the viewers just watched
  if (list[index].removeOnWin) {
    const st = useSettingsStore.getState()
    st.setSettings({
      chatOverlays: st.settings.chatOverlays.map((o) =>
        o.id === w.id && o.type === 'roulette'
          ? { ...o, sections: o.sections.filter((_, i) => i !== index) }
          : o
      )
    })
  }
  return { ok: true, label }
}

/**
 * A chat message that might be asking for a spin.
 *
 * Called for every message, so it leaves immediately when no wheel listens for a command — which
 * is the normal case even for somebody who has one, since the editor button and channel points are
 * the other two ways in.
 */
export function maybeSpinFromChat(channel: string, msg: ChatMessage): void {
  const wheels = wheelsOf()
  if (!wheels.length) return
  const ch = channel.toLowerCase()
  const text = (msg.text || '').trim().toLowerCase()
  for (const w of wheels) {
    if (channelOf(w, ch) !== ch) continue
    if (w.trigger === 'command') {
      const cmd = (w.command || '').trim().toLowerCase()
      if (!cmd || text !== cmd) continue
      const isBroadcaster = msg.login === ch
      const isMod = msg.badges.some((b) => b.setId === 'moderator') || isBroadcaster
      if (w.who === 'broadcaster' && !isBroadcaster) continue
      if (w.who === 'mods' && !isMod) continue
      spinWheel(w, ch)
    } else if (w.trigger === 'redeem' && msg.redeemed) {
      const want = (w.redeemTitle || '').trim().toLowerCase()
      if (!want || (msg.rewardTitle || '').trim().toLowerCase() !== want) continue
      spinWheel(w, ch)
    }
  }
}
