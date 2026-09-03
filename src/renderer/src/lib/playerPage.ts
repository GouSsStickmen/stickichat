/**
 * Talking to the Twitch page a player has open.
 *
 * Channel points are not in any API we can reach: Helix lets a broadcaster manage their own
 * rewards and says nothing about redeeming one as a viewer, and the private GraphQL that the site
 * itself uses refuses our token outright. What does work is the page: when the player runs in site
 * mode there is a real, logged in Twitch tab in the app, and everything about points is already in
 * it. So this reads the balance out of that page, presses its bonus chest, and opens its rewards
 * panel to list what the channel offers and to redeem one.
 *
 * Only the player knows how to reach its own page, so it registers itself here on the way in and
 * takes itself out again on the way out; everyone else asks by channel and gets null when no
 * player is running.
 *
 * Everything below is measured against the live page, not guessed:
 *   - the balance sits in [data-test-selector="community-points-summary"], whose digits animate one
 *     by one, so a reading is taken as digits only and ignored while a "+50" is still rolling;
 *   - the chest is a button in that same summary whose aria-label mentions a bonus;
 *   - a plain click is enough for all of it (unlike the video controls, which ignore synthetic
 *     clicks and need real input events);
 *   - the rewards panel opens off the balance button and needs the chat column to be in the
 *     layout, which is why the player hides that column with opacity rather than display:none.
 */

export type PageAsk = (code: string) => Promise<unknown>

/**
 * What a running player offers the rest of the app.
 *
 * `ask` runs a script in the page. `typeAndSend` is separate because it cannot be a script: the
 * page's chat box is a Slate editor, and measured, it ignores execCommand and synthetic Enter
 * alike, and its own send button then finds nothing to send. Real character events into the
 * focused box work first time, and only the player can send those.
 */
export interface PageHandle {
  ask: PageAsk
  typeAndSend: (text: string) => Promise<void>
}

const pages = new Map<string, PageHandle>()

export function registerPlayerPage(channel: string, handle: PageHandle | null): void {
  if (handle) pages.set(channel, handle)
  else pages.delete(channel)
}

export function hasPlayerPage(channel: string): boolean {
  return pages.has(channel)
}

async function ask<T>(channel: string, code: string): Promise<T | null> {
  const page = pages.get(channel)
  if (!page) return null
  try {
    return (await page.ask(code)) as T
  } catch {
    return null
  }
}

export interface PointsReading {
  /** the balance as a number, approximate when the page has abbreviated it */
  balance: number | null
  /**
   * The balance exactly as the page writes it.
   *
   * Twitch shortens big numbers to "139,7 тис.", and stripping the digits out of that gives 1397,
   * which is what the app showed. What it writes is what gets shown.
   */
  balanceText: string | null
  /** a bonus chest is waiting to be taken */
  chest: boolean
  /** the channel's own points icon, straight from the page */
  icon: string | null
  /** "x1.2" and the like, which Twitch only draws while the stream is live */
  multiplier: string | null
  /** the page is showing this channel as live */
  live: boolean
}

/** the balance, the channel's icon, any multiplier, and whether a bonus is sitting there */
export function readPoints(channel: string): Promise<PointsReading | null> {
  return ask<PointsReading>(
    channel,
    `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const sum = document.querySelector('[data-test-selector="community-points-summary"]')
      if (!sum) return null
      /*
       * The summary holds several things at once: the bits balance, the points balance, the
       * channel's icon and, while the stream is live, a multiplier badge. innerText keeps them on
       * separate lines, where textContent would run "0" bits and "138 736" points together into
       * "0138 736".
       *
       * The balance is therefore the LAST line that is only digits, ignoring anything from a "+"
       * onwards, which is the increment still rolling up after a claim.
       */
      /*
       * Twitch labels the two balances, and that label is the only reliable way to tell them
       * apart: on one channel innerText reads "0" then "138 736", on another the points come
       * first, and picking by position gets the bits instead of the points.
       */
      /*
       * Read twice, and only believe a number that holds still.
       *
       * Their digits roll one by one when the balance changes, and a read caught mid roll comes
       * back with some of them missing: 139 769 read as "1 397" and the app showed that. Two reads
       * a third of a second apart agree except during the animation, and a third settles it.
       */
      const copoText = () => {
        const c = document.querySelector('[data-test-selector="copo-balance-string"]')
        return c ? (c.textContent || '').split('+')[0].trim() : ''
      }
      let shown = copoText()
      await wait(320)
      if (shown !== copoText()) {
        await wait(420)
        shown = copoText()
      }
      // "139,7 тис." and "1,2 млн" are the page's own shorthand: kept for display, and turned into
      // a rough number for anything that needs to compare
      const scale = /тис|k/i.test(shown) ? 1000 : /млн|m/i.test(shown) ? 1000000 : 1
      const digits = shown.replace(/[^0-9.,]/g, '').replace(/\s/g, '').replace(',', '.')
      const labelled = digits ? Math.round(parseFloat(digits) * scale) : null
      const lines = (sum.innerText || sum.textContent || '')
        .split(String.fromCharCode(10))
        .map((l) => l.trim())
        .filter(Boolean)
      let balance = null
      let multiplier = null
      for (const line of lines) {
        const clean = line.split('+')[0].trim()
        if (/^[0-9][0-9\\s]*$/.test(clean)) balance = Number(clean.replace(/[^0-9]/g, ''))
        else if (/^[xх]\\s?[0-9]+([.,][0-9]+)?$/i.test(clean)) multiplier = clean.replace(/\\s/g, '')
      }
      const chest = [...sum.querySelectorAll('button')].some((b) =>
        /бонус|bonus/i.test(b.getAttribute('aria-label') || '')
      )
      const img = sum.querySelector('img')
      const live = !!document.querySelector('.live-indicator, [data-a-target="animated-channel-viewers-count"]')
      return {
        balance: labelled !== null && !Number.isNaN(labelled) ? labelled : balance,
        balanceText: shown || null,
        chest,
        icon: img ? img.src : null,
        multiplier,
        live
      }
    })()`
  )
}

/** press the chest. Returns true when it was there to press */
export function claimBonus(channel: string): Promise<boolean | null> {
  return ask<boolean>(
    channel,
    `(() => {
      const sum = document.querySelector('[data-test-selector="community-points-summary"]')
      if (!sum) return false
      const b = [...sum.querySelectorAll('button')].find((x) =>
        /бонус|bonus/i.test(x.getAttribute('aria-label') || '')
      )
      if (!b) return false
      b.click()
      return true
    })()`
  )
}

export interface Reward {
  /** how the card reads in the page, price and name together: how it is found again */
  key: string
  name: string
  cost: number | null
  /** greyed out in the page, usually because it costs more than the balance */
  disabled: boolean
  /** the picture the streamer put on the reward */
  icon: string | null
}

export interface RewardList {
  rewards: Reward[]
  /**
   * Whether the stream was live when this was read.
   *
   * It decides what is in the list at all: Twitch does not draw rewards that only exist during a
   * stream while the channel is off air, and it does not draw the points multiplier either, so an
   * offline list is genuinely shorter than what the channel offers.
   */
  live: boolean
  /** how many streams in a row you have watched, when the panel says so */
  streak: number | null
  /** streams still to go before the streak pays out */
  streakLeft: number | null
  /** what that streak is worth */
  streakReward: number | null
}

/*
 * Reading the panel.
 *
 * Measured shape, since nothing in there carries a stable selector: the clickable button of a
 * reward holds ONLY its price, and the name sits beside it in the parent, so a card reads as
 * "100Meow 1 cute". Rewards are therefore found by that shape, price button first, name taken from
 * the parent with the price cut off the front. The panel opens on "Усі", which mixes Twitch's own
 * boosts into the list, so it is switched to the channel's own rewards tab first.
 *
 * A reward is remembered by that parent text rather than by position: the list reorders itself as
 * things become affordable, and pressing whatever ended up in slot four would redeem the wrong one.
 */
const PANEL_SCRIPT = `
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const balanceButton = () =>
    [...document.querySelectorAll('button')].find((b) =>
      /Баланси|Balances/i.test(b.getAttribute('aria-label') || '')
    )
  const panel = () =>
    [...document.querySelectorAll('[class*="Attached"]')].find((e) =>
      /нагород|reward/i.test(e.textContent || '')
    )
  const cards = (p) =>
    [...p.querySelectorAll('button')]
      .map((b) => ({ b, cost: (b.textContent || '').trim(), whole: (b.parentElement?.textContent || '').trim() }))
      .filter((x) => /^[0-9][0-9\\s]*$/.test(x.cost) && x.whole.length > x.cost.length)
  const backToList = async (p) => {
    /*
     * The panel remembers where it was left.
     *
     * Pressing a reward replaces the list with that reward's own card, and reading THAT as the
     * list is how the window came back saying the channel has no rewards at all. Its back arrow
     * returns to the list; it is the only button up there with no text.
     */
    for (let i = 0; i < 3 && cards(p).length === 0; i++) {
      const back = [...p.querySelectorAll('button')].find(
        (b) => /Назад|Back/i.test(b.getAttribute('aria-label') || '') && (b.textContent || '').trim() === ''
      )
      if (!back) break
      back.click()
      await wait(700)
      p = panel() || p
    }
    return p
  }
  const openPanel = async () => {
    let p = panel()
    if (!p) {
      const b = balanceButton()
      if (!b) return null
      b.click()
      for (let i = 0; i < 14 && !p; i++) {
        await wait(300)
        p = panel()
      }
      if (!p) return null
    }
    // first time on a channel the panel opens on a "get started" card instead of the list
    const go = [...p.querySelectorAll('button')].find((x) =>
      /^(Почати|Get started)!?$/i.test((x.textContent || '').trim())
    )
    if (go) {
      go.click()
      await wait(1400)
      p = panel() || p
    }
    const tab = [...p.querySelectorAll('button')].find((x) =>
      /^(Нагороди|Rewards)$/i.test((x.textContent || '').trim())
    )
    if (tab) {
      tab.click()
      await wait(1200)
      p = panel() || p
    }
    // the cards render a beat after the tab does
    for (let i = 0; i < 10 && cards(p).length === 0; i++) {
      await wait(300)
      p = panel() || p
    }
    return await backToList(p)
  }
  const closePanel = (p) => {
    const c = [...p.querySelectorAll('button')].find((b) => /Закрити|Close/i.test(b.getAttribute('aria-label') || ''))
    if (c) c.click()
  }
`

export function readRewards(channel: string): Promise<RewardList | null> {
  return ask<RewardList>(
    channel,
    `(async () => {
      ${PANEL_SCRIPT}
      const p = await openPanel()
      if (!p) return null
      const text = p.textContent || ''
      const streak = (text.match(/серія переглядів:\\s*(\\d+)/i) || text.match(/watch streak:?\\s*(\\d+)/i) || [])[1]
      const ahead = text.match(/Ще\\s*(\\d+)\\s*стрим[^0-9]*(\\d+)/i) || text.match(/(\\d+)\\s*more stream[^0-9]*(\\d+)/i) || []
      const rewards = cards(p).map((x) => {
        const img = x.b.querySelector('img') || x.b.parentElement?.querySelector('img')
        return {
          key: x.whole,
          name: x.whole.slice(x.cost.length).trim(),
          cost: Number(x.cost.replace(/\\s/g, '')),
          disabled: x.b.disabled || x.b.getAttribute('aria-disabled') === 'true',
          icon: img ? img.src : null
        }
      })
      closePanel(p)
      return {
        live: !!document.querySelector('.live-indicator, [data-a-target="animated-channel-viewers-count"]'),
        rewards,
        streak: streak ? Number(streak) : null,
        streakLeft: ahead[1] ? Number(ahead[1]) : null,
        streakReward: ahead[2] ? Number(ahead[2]) : null
      }
    })()`
  )
}

/**
 * Just the watch streak, without the reward list.
 *
 * The streak is written nowhere else in the page: not on the channel, not in chat, only inside the
 * rewards panel, next to "Твоя серія переглядів". So this opens that panel, reads the three
 * numbers and closes it again. The panel is invisible and takes no clicks from the mouse, so
 * nothing about that is visible to whoever is watching.
 */
export function readStreak(
  channel: string
): Promise<{ streak: number | null; left: number | null; reward: number | null } | null> {
  return ask(
    channel,
    `(async () => {
      ${PANEL_SCRIPT}
      const p = await openPanel()
      if (!p) return null
      const text = p.textContent || ''
      const streak = (text.match(/серія переглядів:\\s*(\\d+)/i) || text.match(/watch streak:?\\s*(\\d+)/i) || [])[1]
      const ahead = text.match(/Ще\\s*(\\d+)\\s*стрим[^0-9]*(\\d+)/i) || text.match(/(\\d+)\\s*more stream[^0-9]*(\\d+)/i) || []
      closePanel(p)
      return {
        streak: streak ? Number(streak) : null,
        left: ahead[1] ? Number(ahead[1]) : null,
        reward: ahead[2] ? Number(ahead[2]) : null
      }
    })()`
  ) as Promise<{ streak: number | null; left: number | null; reward: number | null } | null>
}

export interface RedeemResult {
  state: 'pressed' | 'needsText' | 'armed' | 'disabled' | 'gone' | 'noPanel' | 'refused'
  /** the balance before the attempt, so the caller can tell whether the words cost anything */
  balance?: string
  /** what the page itself said about it, when it said anything */
  message?: string
}

/**
 * Redeem one of the rewards the list came back with, found again by its own text.
 *
 * Rewards come in two shapes, and the difference is not marked anywhere in the list:
 *
 *   - most of them open a card with an "Отримати" button, and that button is what spends the
 *     points. Pressing only the reward looks like nothing happening, which is what it looked like;
 *   - some, "Виділити моє повідомлення" among them, instead put a prompt over the page's chat box
 *     ("Напиши особливе повідомлення нижче") and wait for a message. Those are recognised by that
 *     prompt: walking up from the chat box, an ancestor starts carrying the reward's name. The
 *     panel then asks for the words here, because the page they would be typed into is invisible,
 *     and the second call types them in and sends.
 *
 * When neither appears, whatever the page said about it is handed back rather than guessed at: it
 * is the page that knows a reward is out of stock, on cooldown, or only for a live stream.
 */
export function redeemReward(channel: string, key: string, text?: string): Promise<RedeemResult> {
  return ask<RedeemResult>(
    channel,
    `(async () => {
      ${PANEL_SCRIPT}
      const p = await openPanel()
      if (!p) return { state: 'noPanel' }
      const want = ${JSON.stringify(key)}
      const name = want.replace(/^[0-9\\s]+/, '').trim()
      const card = cards(p).find((x) => x.whole === want)
      if (!card) return { state: 'gone' }
      if (card.b.disabled || card.b.getAttribute('aria-disabled') === 'true') return { state: 'disabled' }
      const balance = () => {
        const c = document.querySelector('[data-test-selector="copo-balance-string"]')
        return c ? (c.textContent || '').trim() : ''
      }
      const chatBox = () => document.querySelector('[data-a-target="chat-input"]')
      // the prompt wraps the chat box, so it is found by climbing out of it
      /*
       * The prompt over the chat box, told apart from everything else around it.
       *
       * Measured: it wraps the box about eleven levels up, and by then the reward's name is not a
       * reliable sign on its own. The rewards panel is a portal in the same column, and Twitch's
       * own chat prints "redeemed <reward>" lines, so an ancestor "mentioning this reward" also
       * matches the whole chat room. Size is what separates them: the prompt holds the name, its
       * price, one line of instruction and the box, a couple of hundred characters, where the chat
       * room holds thousands.
       */
      const promptUp = () => {
        let n = chatBox()
        for (let i = 0; i < 16 && n; i++) {
          n = n.parentElement
          if (!n) break
          const tx = n.textContent || ''
          if (tx.length > 400) return null
          if (tx.includes(name)) return n
        }
        return null
      }
      const confirmButton = () => {
        const view = [...document.querySelectorAll('[class*="Attached"]')].find((e) =>
          [...e.querySelectorAll('button')].some((b) => /^(Отримати|Обміняти|Redeem|Get)/i.test((b.textContent || '').trim()))
        )
        return view
          ? [...view.querySelectorAll('button')].find((b) => /^(Отримати|Обміняти|Redeem|Get)/i.test((b.textContent || '').trim())) || null
          : null
      }
      const said = ${JSON.stringify(text ?? '')}
      const before = balance()
      card.b.click()

      /*
       * The confirmation is looked for first, and it wins.
       *
       * Their reward card is rendered inside the chat column, which is also where the chat box
       * lives, so climbing out of the box finds the card's own title and every reward looked like
       * one asking for a message: a 60 000 reward with 3 738 in the bank came back asking for
       * words instead of saying it was out of reach. So a confirmation ends the search, and a
       * prompt is only believed after a few rounds have given that card its chance to appear.
       */
      let go = null
      let prompt = null
      for (let i = 0; i < 14; i++) {
        await wait(280)
        go = confirmButton()
        if (go) break
        prompt = promptUp()
        if (prompt && i >= 4) break
        prompt = null
      }

      // the prompt is up: the words have to be typed for real, which only the player can do
      if (prompt && !go) return { state: said ? 'armed' : 'needsText', balance: before }

      if (go) {
        const view = go.closest('[class*="Attached"]')
        /*
         * A greyed "Отримати" is where Twitch explains itself: once per stream rewards say "Усі
         * нагороди за цей стрим отримано", others say they are out of stock or on cooldown. That
         * sentence is the answer to "why did nothing happen", so it is carried back whole instead
         * of being reported as a plain refusal with an invitation to try again.
         */
        if (go.disabled || go.getAttribute('aria-disabled') === 'true') {
          const lines = (view ? view.innerText || view.textContent || '' : '')
            .split(String.fromCharCode(10))
            .map((l) => l.trim())
            .filter((l) => l.length > 12 && !/^(Отримати|Обміняти|Redeem|Get)/i.test(l) && l !== name)
          // the card carries the reward's own description too; the status is the last line, just
          // above the button, and it is the only part that answers "why not"
          const status =
            lines.find((l) => /отримано|недоступн|наступн|вичерпан|зачекай|stock|cooldown|available/i.test(l)) ??
            lines[lines.length - 1]
          return { state: 'refused', message: status || undefined }
        }
        const field = view ? view.querySelector('textarea, input[type="text"]') : null
        if (field && !said) {
          const back = [...view.querySelectorAll('button')].find((b) =>
            /Закрити|Назад|Close|Back/i.test(b.getAttribute('aria-label') || '')
          )
          if (back) back.click()
          return { state: 'needsText' }
        }
        if (field && said) {
          const setter = Object.getOwnPropertyDescriptor(
            field.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
            'value'
          )
          setter.set.call(field, said)
          field.dispatchEvent(new Event('input', { bubbles: true }))
          await wait(300)
        }
        go.click()
        /*
         * Success is the card going away.
         *
         * The balance was the obvious proof and the wrong one: the page abbreviates big totals to
         * "139,7 тис.", which does not move when 77 points leave, so every redemption on a large
         * balance reported itself as refused.
         */
        for (let i = 0; i < 14; i++) {
          await wait(300)
          if (!confirmButton() || balance() !== before) return { state: 'pressed' }
        }
        return { state: 'refused' }
      }

      /*
       * Nothing opened. Twitch does say why in that case, so its words are carried back rather
       * than replaced with a guess of ours.
       */
      const note = [...document.querySelectorAll('div,p,span')]
        .map((e) => (e.textContent || '').trim())
        .find((tx) => tx.length > 3 && tx.length < 140 && /(недоступн|не доступн|вичерпан|зачекай|cooldown|unavailable|out of stock|only during|під час етеру)/i.test(tx))
      return { state: 'refused', message: note || undefined }
    })()`
  ).then(async (r) => {
    const res = r ?? { state: 'refused' as const }
    if (res.state !== 'armed') return res
    /*
     * Armed and carrying words: type them into the page's chat box and send.
     *
     * The reward attaches itself to the message, so the message has to go through THAT box; ours
     * would post the same words with none of the reward on them.
     */
    const page = pages.get(channel)
    if (!page) return { state: 'refused' as const }
    await page.typeAndSend(text ?? '')
    /*
     * The prompt over their chat box disappears when the message goes, which is the signal here:
     * the balance is abbreviated on big totals and would not move for the price of one reward.
     */
    const gone = await ask<boolean>(
      channel,
      `(() => {
        const box = document.querySelector('[data-a-target="chat-input"]')
        if (!box) return false
        // sent means the box is empty again: a message their editor refused stays sitting in it
        if ((box.innerText || '').trim() !== '') return false
        const name = ${JSON.stringify(key.replace(/^[0-9\s ]+/, '').trim())}
        let n = box
        for (let i = 0; i < 16 && n; i++) {
          n = n.parentElement
          if (!n) break
          const tx = n.textContent || ''
          if (tx.length > 400) return true
          if (tx.includes(name)) return false
        }
        return true
      })()`
    )
    return gone ? { state: 'pressed' as const } : { state: 'refused' as const }
  })
}
