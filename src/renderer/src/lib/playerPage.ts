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
  /**
   * A real mouse click at a point in the page, which only the player can send.
   *
   * Some of their buttons will not take a synthetic click at all — the player controls are the
   * known case, and their share offer turned out to be another: a plain .click() closed the panel
   * and posted nothing. This sends the same events a mouse does, so the page cannot tell the
   * difference.
   */
  pressAt: (x: number, y: number) => Promise<void>
  /**
   * Type into one of their fields with real keys, and say whether the characters landed.
   *
   * Their inputs are React-controlled: setting .value and firing an input event puts the digits on
   * screen without their component ever learning about them, so the amount stayed at nothing and
   * the bet was placed for nothing. Real characters go through the same path a person's do.
   */
  typeInto: (selector: string, text: string) => Promise<boolean>
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

/**
 * One panel at a time, per channel.
 *
 * Everything that drives their own panels shares one page and one set of them: the balance panel
 * is where the rewards, the streak and each reward's description come from, and the drops chest
 * opens another. Several of these run on their own timers, and they were free to collide — the
 * background walk that reads descriptions was opening a reward card while a press was opening a
 * different one, and both came back having found nothing. Measured on a live channel: with the
 * walk running, most descriptions read as empty, and the panel then said the streamer had written
 * none at all.
 *
 * So they queue. Each waits for the one before it on that channel, whether it succeeded or not,
 * and a page that has gone away simply answers null as before.
 */
const queues = new Map<string, Promise<unknown>>()

function serial<T>(channel: string, run: () => Promise<T>): Promise<T> {
  const prev = queues.get(channel) ?? Promise.resolve()
  const next = prev.then(run, run)
  queues.set(
    channel,
    next.catch(() => {})
  )
  return next
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
       * The points balance, from the element that says it is the points balance.
       *
       * The summary holds several things at once: the bits balance, the points balance, the
       * channel's icon and, while the stream is live, a multiplier badge. Picking by position gets
       * the bits on some channels, because innerText reads "0" then "138 736" on one and the other
       * way round on another; the labelled element cannot be mistaken.
       *
       * Read twice, and only believe a number that holds still: their digits roll one by one when
       * the balance changes, and a read caught mid roll comes back with some of them missing.
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
      const digits = shown.replace(/[^0-9.,]/g, '').replace(',', '.')
      const labelled = digits ? Math.round(parseFloat(digits) * scale) : null
      // the multiplier has no label of its own, so it is picked out of the summary's own lines
      const lines = (sum.innerText || sum.textContent || '')
        .split(String.fromCharCode(10))
        .map((l) => l.trim())
        .filter(Boolean)
      let balance = null
      let multiplier = null
      for (const line of lines) {
        const clean = line.split('+')[0].trim()
        const bare = clean.replace(/[0-9]/g, '').trim()
        if (bare === '' && clean.replace(/[^0-9]/g, '') !== '')
          balance = Number(clean.replace(/[^0-9]/g, ''))
        else if (/^[xх][^0-9]{0,2}[0-9]+([.,][0-9]+)?$/i.test(clean))
          multiplier = clean.replace(/ /g, '')
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

/**
 * Send one line through the page's own chat box, command and all.
 *
 * This is how the commands Twitch took away from IRC still work: /poll, /prediction, /endpoll,
 * /marker and the rest are refused over the chat connection and accepted by the web client, and
 * the web client is exactly what the player has open. Typed as real keystrokes, because their
 * editor ignores anything else.
 *
 * Their own answer is deliberately NOT reported back. It arrives as a line in THEIR chat, and
 * there is no selector that separates it from ordinary chat, so reading "the last line" showed
 * whatever a bot had just posted and read as if that were the reply.
 */
export async function sendChatLine(channel: string, line: string): Promise<{ ok: boolean }> {
  const page = pages.get(channel)
  if (!page) return { ok: false }
  try {
    await page.typeAndSend(line)
  } catch {
    return { ok: false }
  }
  const empty = await ask<boolean>(
    channel,
    `(() => {
      const box = document.querySelector('[data-a-target="chat-input"]')
      return !!box && (box.innerText || '').trim() === ''
    })()`
  )
  return { ok: empty === true }
}

export interface PagePoll {
  /** "Поточне опитування" or the prediction's own heading, as the page writes it */
  kind: string
  question: string
  options: { label: string; share: string; votes: string; picked: boolean; mine: number }[]
  /** a vote can still be cast: their own button is there and this account has not voted yet */
  open: boolean
  /** this account has already voted in it */
  voted: boolean
  /** how long is left, as the page writes it ("00:41"), when it says so */
  timeLeft: string | null
  /** how much of the run is gone, 0 to 1, from their own bar */
  ran: number | null
}


/*
 * A poll or a prediction, read out of the chat column so the app can draw it itself.
 *
 * Their card cannot be moved: it lives in the page, inside a column we hide, so wherever it is put
 * it still lands over the video, and drawn there it flickered every time their React redrew it. So
 * the contents are copied out and the app draws its own card at the top of the chat, which is
 * where it was wanted; voting is passed back to their buttons, the only thing that can cast a vote.
 *
 * Measured on a live poll rather than guessed: each option is a BUTTON whose text is the label
 * followed by its share, "так100% (1)", the vote goes in with a button reading exactly
 * "Голосувати", and the card itself is collapsed by default, which is why nothing here depends on
 * it being open. textContent throughout, never innerText: the column is hidden, and hidden text is
 * not "rendered" text, so innerText comes back empty.
 */
const POLL_SCRIPT = `
  /*
   * Searched across the whole page, not inside the chat column.
   *
   * The expanded card's own buttons are not where its text is: the column carries the words while
   * the buttons live elsewhere in the tree, so a search bounded by the column found the heading and
   * no options at all. The pattern of an option, "<label><number>% (<votes>)", is specific enough
   * to look for everywhere.
   */
  const col = document
  /*
   * An option row is parsed by hand, with no regex at all.
   *
   * "так100% (1)" is the whole of it: a label, its share, and the count in brackets. A pattern
   * would have been shorter and would also have been the fourth thing in this file broken by a
   * template literal eating one backslash out of it, so the characters are counted instead.
   */
  const parseOption = (t) => {
    const pi = t.indexOf('%')
    if (pi < 1) return null
    const open = t.indexOf('(', pi)
    const close = t.lastIndexOf(')')
    if (open < 0 || close !== t.length - 1) return null
    let i = pi - 1
    while (i >= 0 && t[i] >= '0' && t[i] <= '9') i--
    const share = t.slice(i + 1, pi)
    if (!share) return null
    return { label: t.slice(0, i + 1).trim(), share: share + '%', votes: t.slice(open + 1, close).trim() }
  }
  const optionButtons = () =>
    [...document.querySelectorAll('button')]
      .map((b) => ({ b, text: (b.textContent || '').trim() }))
      .filter((x) => x.text.length < 60 && parseOption(x.text))
  /*
   * Their card starts collapsed, and collapsed it holds no options at all: not hidden ones, none.
   * So it is opened once, by its own "Розгорнути" button, and stays open after that.
   */
  const expand = () => {
    const b = [...document.querySelectorAll('button')].find((x) =>
      /Розгорнути|Expand/i.test(x.getAttribute('aria-label') || '')
    )
    if (!b) return false
    b.click()
    return true
  }
  /*
   * The countdown and the bar that goes with it.
   *
   * Their card writes the time as "0:41" or "00:41" near the options and draws a bar that empties
   * as it runs. The time is found as the nearest leaf of that shape; the bar as the progress fill
   * closest to the options, measured against its own groove.
   */
  const clockLeaf = () => {
    const looksLikeTime = (t) => {
      const at = t.indexOf(':')
      if (at < 1 || at > 2 || t.length - at !== 3) return false
      for (const ch of t.replace(':', '')) if (ch < '0' || ch > '9') return false
      return true
    }
    const near = optionButtons()[0]
    if (!near) return null
    const card = near.b.closest('div,section,article')
    const host = card ? card.parentElement || card : document
    const leaf = [...host.querySelectorAll('*')].find(
      (e) => e.children.length === 0 && looksLikeTime((e.textContent || '').trim())
    )
    return leaf ? (leaf.textContent || '').trim() : null
  }
  const barRan = () => {
    const near = optionButtons()[0]
    if (!near) return null
    let scope = near.b.parentElement
    for (let i = 0; i < 4 && scope; i++) {
      const groove = scope.querySelector('[class*="ScProgressBarWrapper"]')
      const fill = scope.querySelector('[class*="ScProgressBarFill"]')
      if (groove && fill) {
        const wide = groove.getBoundingClientRect().width
        if (wide > 0) return Math.min(1, fill.getBoundingClientRect().width / wide)
      }
      scope = scope.parentElement
    }
    return null
  }
  const voteButton = () =>
    [...col.querySelectorAll('button')].find((b) => /^(Голосувати|Vote)$/i.test((b.textContent || '').trim()))
  /*
   * The kind and the question, taken from what sits just above the options.
   *
   * Matching the heading's own words was too brittle: it reads "Поточне опитування" while the poll
   * runs and something else as it closes, and when the match missed, the card came out with no
   * question at all. The options are the anchor instead: in page order, the leaf before the first
   * of them is the question, and the one before that is the heading.
   */
  const heading = () => {
    const opts = optionButtons()
    if (!opts.length) return { kind: '', question: '' }
    const leaves = [...document.querySelectorAll('*')].filter(
      (e) => e.children.length === 0 && (e.textContent || '').trim()
    )
    const firstOption = opts[0].b
    let at = -1
    for (let i = 0; i < leaves.length; i++) {
      if (firstOption.contains(leaves[i])) {
        at = i
        break
      }
    }
    if (at < 1) return { kind: '', question: '' }
    const before = leaves
      .slice(Math.max(0, at - 4), at)
      .map((e) => (e.textContent || '').trim())
      .filter((t) => t.length < 120)
    const kindAt = before.findIndex((t) => /опитуванн|прогноз|poll|predict/i.test(t))
    return {
      kind: kindAt >= 0 ? before[kindAt] : '',
      question: kindAt >= 0 ? before[kindAt + 1] || '' : before[before.length - 1] || ''
    }
  }
`

export function readPoll(channel: string): Promise<PagePoll | null> {
  return ask<PagePoll>(
    channel,
    `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      ${POLL_SCRIPT}
      let opts = optionButtons()
      // no options in sight: their card starts collapsed, and its own button is the way in. Asking
      // the heading first was a mistake, since the heading is now derived FROM the options
      if (opts.length < 2 && expand()) {
        await wait(900)
        opts = optionButtons()
      }
      if (opts.length < 2) return null
      const head = heading()
      const vote = voteButton()
      const options = opts.map(({ b, text }) => {
        const part = parseOption(text)
        return {
          label: part ? part.label : text,
          share: part ? part.share : '',
          votes: part ? part.votes : '',
          picked: b.getAttribute('aria-checked') === 'true' || b.getAttribute('aria-pressed') === 'true',
          mine: 0
        }
      })
      /*
       * "Open" means a vote can still be cast, which is NOT the same as their button being
       * enabled: Twitch keeps "Голосувати" disabled until an option is picked, and reading that as
       * "voting is closed" greyed out our own options so nothing could be picked at all. What ends
       * voting is the poll going away, or this account having voted, which the page says outright.
       */
      const voted = /Проголосовано|You voted|Ви проголосували/i.test(document.body.textContent || '')
      return {
        kind: head.kind,
        question: head.question,
        options,
        open: !!vote && !voted,
        voted,
        timeLeft: clockLeaf(),
        ran: barRan()
      }
    })()`
  )
}

/*
 * Everything about their prediction panel, in one place.
 *
 * Their card in the chat column is collapsed: it holds the question and a "Прогноз" button, and
 * the outcomes are not in the page at all until that button is pressed. Measured on a live
 * prediction with four outcomes: each outcome is a ScInteractable rather than a button and reads
 * "n_vizion70 %69", pressing one offers the default amount on a button of its own plus "Прогноз
 * із власною сумою", and the custom flow confirms with "Голосувати".
 */
const PRED_SCRIPT = `
  const text = (e) => (e.textContent || '').trim()
  const col = document.querySelector('.right-column') || document.body
  const predPanel = () =>
    [...document.querySelectorAll('[class*="Attached"]')].find((e) => /Прогноз|Predict/i.test(text(e)))
  const predRows = () => {
    const p = predPanel()
    if (!p) return []
    return [...p.querySelectorAll('[class*="ScInteractable"]')].filter((e) => text(e).length > 1)
  }
  const digitsOf = (t) => {
    let out = ''
    for (const ch of t) if (ch >= '0' && ch <= '9') out += ch
    return out
  }
  const numericLabel = (t) => {
    if (!t || t.length > 12) return false
    let seen = false
    for (const ch of t) {
      if (ch >= '0' && ch <= '9') seen = true
      else if (ch !== ' ') return false
    }
    return seen
  }
  const openPred = async () => {
    let p = predPanel()
    if (!p) {
      const open = [...col.querySelectorAll('button')].find((b) => /^(Прогноз|Predict)$/i.test(text(b)))
      if (!open) return null
      open.click()
      for (let i = 0; i < 16 && !predPanel(); i++) await wait(250)
      p = predPanel()
      if (!p) return null
    }
    for (let i = 0; i < 3 && predRows().length === 0; i++) {
      const back = [...p.querySelectorAll('button')].find((b) =>
        /Назад|Back/i.test(b.getAttribute('aria-label') || '')
      )
      if (!back) break
      back.click()
      await wait(700)
      p = predPanel() || p
    }
    return predPanel() || p
  }
  /*
   * Their warning for moderators, which stops the bet dead until it is answered.
   *
   * Measured on a live prediction: pressing an amount as a moderator of the channel opens "Ти
   * береш участь як модератор. Прогноз створено стримером. Участь у ньому позбавить можливості
   * обирати результат." with Скасувати and "Я все ж хочу взяти участь". Nothing is staked until
   * that second button is pressed, which is exactly why the points never left — and it is not a
   * dialog to press on somebody's behalf, since taking part costs a moderator the right to pick
   * the winner. So it is reported back and answered from our own card.
   */
  const modWarning = () => {
    const p = predPanel()
    if (!p) return null
    if (!/як модератор|as a moderator/i.test(text(p))) return null
    return (
      [...p.querySelectorAll('button')].find((b) =>
        /все ж хочу|still want|anyway/i.test(text(b))
      ) || null
    )
  }
  /* their warning is put away when it is handed on: the answer comes back as a fresh attempt */
  const dropWarning = () => {
    const p = predPanel()
    if (!p) return
    const no = [...p.querySelectorAll('button')].find((b) => /^(Скасувати|Cancel)$/i.test(text(b)))
    if (no) no.click()
  }
  /* what the page says the balance is, digits only, for telling a placed bet from a refused one */
  const balanceDigits = () => {
    const c = document.querySelector('[data-test-selector="copo-balance-string"]')
    return c ? digitsOf(text(c)) : ''
  }
  const rowPoints = (name) => {
    const row = predRows().find((e) => text(e).indexOf(name) === 0)
    if (!row) return ''
    const said = [...row.querySelectorAll('*')]
      .filter((e) => e.children.length === 0 && text(e))
      .map((e) => text(e))
    return digitsOf(said[2] || '')
  }
`

/**
 * Put points on one side of a prediction, with the amount you choose.
 *
 * Three steps, because their amount field is React-controlled and will not take a written value:
 * the outcome is chosen, the digits are typed with real keys, and only then is their "Голосувати"
 * pressed. And it is checked afterwards rather than assumed — measured on a live prediction, the
 * old way came back "placed" for a bet Twitch never took, so our card said "ти поставив 179" while
 * every outcome in their own panel still stood at zero. Now the balance has to move, or the chosen
 * outcome's own total has to grow, before this says the points went.
 */
export async function betPrediction(
  channel: string,
  index: number,
  amount: number,
  label?: string,
  force?: boolean
): Promise<'placed' | 'noOutcome' | 'noAmount' | 'refused' | 'modWarning' | null> {
  const page = pages.get(channel)
  if (!page) return null
  return serial(channel, async () => {
    const want = String(amount)
    const ready = await ask<{ state: string; before: string; points: string }>(
      channel,
      `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      ${PRED_SCRIPT}
      const name = ${JSON.stringify(label ?? '')}
      const want = ${JSON.stringify(want)}
      let p = await openPred()
      if (!p) return { state: 'noOutcome', before: '', points: '' }
      const list = predRows()
      const row = (name ? list.find((e) => text(e).indexOf(name) === 0) : null) ?? list[${index}]
      if (!row) return { state: 'noOutcome', before: '', points: '' }
      const before = balanceDigits()
      const points = name ? rowPoints(name) : ''
      row.click()
      await wait(1200)
      p = predPanel() || p
      const quick = [...p.querySelectorAll('button')].filter((b) => !b.disabled && numericLabel(text(b)))
      const exact = quick.find((b) => digitsOf(text(b)) === want)
      if (exact) {
        exact.click()
        await wait(1200)
        const warn = modWarning()
        if (warn) {
          if (!${JSON.stringify(force === true)}) {
            dropWarning()
            return { state: 'modWarning', before: before, points: points }
          }
          warn.click()
          await wait(1200)
        }
        return { state: 'pressed', before: before, points: points }
      }
      const custom = [...p.querySelectorAll('button')].find((b) => /власною сумою|Custom/i.test(text(b)))
      if (!custom) return { state: 'noAmount', before: before, points: points }
      custom.click()
      await wait(1300)
      p = predPanel() || p
      const field = [...p.querySelectorAll('input')].find(
        (i) => i.type === 'number' || i.inputMode === 'numeric'
      )
      if (!field) return { state: 'noAmount', before: before, points: points }
      return { state: 'typing', before: before, points: points }
    })()`
    )
    if (!ready) return null
    if (ready.state === 'noOutcome') return 'noOutcome'
    if (ready.state === 'noAmount') return 'noAmount'
    if (ready.state === 'modWarning') return 'modWarning'

    if (ready.state === 'typing') {
      const typed = await page.typeInto('[class*="Attached"] input[type="number"]', want)
      if (!typed) return 'noAmount'
      const pressed = await ask<string>(
        channel,
        `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        ${PRED_SCRIPT}
        const p = predPanel()
        if (!p) return false
        const go = [...p.querySelectorAll('button')].find((b) =>
          /^(Голосувати|Прогноз|Поставити|Vote|Predict|Place)$/i.test(text(b))
        )
        if (!go || go.disabled) return 'refused'
        go.click()
        await wait(1300)
        const warn = modWarning()
        if (warn) {
          if (!${JSON.stringify(force === true)}) {
            dropWarning()
            return 'modWarning'
          }
          warn.click()
          await wait(1300)
        }
        return 'pressed'
      })()`
      )
      if (pressed === 'modWarning') return 'modWarning'
      if (pressed !== 'pressed') return 'refused'
    }

    const went = await ask<boolean>(
      channel,
      `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      ${PRED_SCRIPT}
      const name = ${JSON.stringify(label ?? '')}
      const before = ${JSON.stringify(ready.before)}
      const had = Number(${JSON.stringify(ready.points)} || '0')
      for (let i = 0; i < 12; i++) {
        await wait(400)
        const now = balanceDigits()
        if (before && now && now !== before) return true
        if (name) {
          const grown = Number(rowPoints(name) || '0')
          if (grown > had) return true
        }
      }
      return false
    })()`
    )
    await ask(
      channel,
      `(() => {
      const text = (e) => (e.textContent || '').trim()
      const p = [...document.querySelectorAll('[class*="Attached"]')].find((e) => /Прогноз|Predict/i.test(text(e)))
      if (p) {
        const shut = [...p.querySelectorAll('button')].find((b) =>
          /Закрити|Close/i.test(b.getAttribute('aria-label') || '')
        )
        if (shut) shut.click()
      }
      return true
    })()`
    )
    return went === true ? 'placed' : 'refused'
  })
}

/**
 * Take part: a vote in a poll, or points on one side of a prediction.
 *
 * The two are pressed differently, which is the whole reason this is one function. A poll wants
 * its option and then "Голосувати". A prediction has no such button: each outcome carries its own
 * button with the amount written on it, so pressing the outcome and then the button under it is
 * what places the points.
 */
export function votePoll(channel: string, index: number): Promise<boolean | null> {
  return ask<boolean>(
    channel,
    `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      ${POLL_SCRIPT}
      let opts = optionButtons()
      if (opts.length < 2 && expand()) {
        await wait(900)
        opts = optionButtons()
      }
      const pick = opts[${index}]
      if (!pick) return false
      pick.b.click()
      await wait(600)
      const vote = voteButton()
      if (vote && !vote.disabled) {
        vote.click()
        await wait(900)
        return true
      }
      /*
       * A prediction: the amount buttons are the side you are backing, one per outcome, with the
       * number of points written on them. The one in this outcome's own row is the one to press;
       * failing that, the nth of them, since they sit in outcome order.
       */
      const amounts = [...document.querySelectorAll('button')].filter((b) => {
        const t = (b.textContent || '').trim()
        return t.length > 0 && t.length < 10 && t.replace(/[0-9 ]/g, '') === '' && !b.disabled
      })
      const own = amounts.find((b) => pick.b.parentElement && pick.b.parentElement.contains(b))
      const bet = own ?? amounts[${index}]
      if (!bet) return false
      bet.click()
      await wait(900)
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
  /*
   * Prices are recognised without a single backslash on purpose.
   *
   * These scripts reach the page as template literals and one round of escaping is eaten on the
   * way: \s arrives as a literal "s", which silently dropped every price with a space in it and,
   * elsewhere, the streak number. "Digits and spaces only" says the same thing and survives.
   */
  const onlyDigits = (t) => t.replace(/[^0-9]/g, '') !== '' && t.replace(/[0-9]/g, '').trim() === ''
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
      .filter((x) => onlyDigits(x.cost) && x.whole.length > x.cost.length)
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
  return serial(channel, () =>
    ask<RewardList>(
      channel,
    `(async () => {
      ${PANEL_SCRIPT}
      const p = await openPanel()
      if (!p) return null
      const text = p.textContent || ''
      const streak = (text.match(/серія переглядів[^0-9]{0,4}([0-9]+)/i) ||
        text.match(/watch streak[^0-9]{0,4}([0-9]+)/i) || [])[1]
      const ahead =
        text.match(/Ще[^0-9]{0,3}([0-9]+)[^0-9]+([0-9]+)/i) ||
        text.match(/([0-9]+)[^0-9]{0,3}more stream[^0-9]+([0-9]+)/i) ||
        []
      const rewards = cards(p).map((x) => {
        const img = x.b.querySelector('img') || x.b.parentElement?.querySelector('img')
        return {
          key: x.whole,
          name: x.whole.slice(x.cost.length).trim(),
          cost: Number(x.cost.replace(/[^0-9]/g, '')),
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
  )
}

/**
 * The watch streak, and whether this stream has been counted towards it.
 *
 * Both live in one card at the foot of the rewards panel and nowhere else in the page. The number
 * is in its title; whether tonight counted is in the green bar under it, which fills as the stream
 * is watched and is full once the streak has been taken. That bar is the reliable answer, and it
 * is right immediately, where watching the number rise could only ever notice a streak taken while
 * the app happened to be running and got it wrong after every restart.
 *
 * Measured shape: the card carries a watchStreakFooter class, the groove is ScProgressBarWrapper
 * and the fill is ScProgressBarFill; full means fill width equals groove width.
 */
export function readStreak(channel: string): Promise<{
  streak: number | null
  left: number | null
  reward: number | null
  counted: boolean
  /**
   * Their "share this" offer, which lives in this same footer.
   *
   * Measured on a live streak: the footer reads "Твоя серія переглядів: 7 / Ти отримав(-ла)
   * додаткову нагороду: 450!" with a Поділитися button in it, and it stays there until it is
   * shared. That makes the panel the place to find it — the card Twitch throws over the chat when
   * the streak lands is gone a minute later, and this is the same offer, still open.
   */
  share: SharePrompt | null
} | null> {
  return serial(channel, () =>
    ask(
      channel,
    `(async () => {
      ${PANEL_SCRIPT}
      const p = await openPanel()
      if (!p) return null
      const text = p.textContent || ''
      const streak = (text.match(/серія переглядів[^0-9]{0,4}([0-9]+)/i) ||
        text.match(/watch streak[^0-9]{0,4}([0-9]+)/i) || [])[1]
      const ahead =
        text.match(/Ще[^0-9]{0,3}([0-9]+)[^0-9]+([0-9]+)/i) ||
        text.match(/([0-9]+)[^0-9]{0,3}more stream[^0-9]+([0-9]+)/i) ||
        []
      const card = document.querySelector('[class*="watchStreakFooter"]')
      const groove = card && card.querySelector('[class*="ScProgressBarWrapper"]')
      const fill = card && card.querySelector('[class*="ScProgressBarFill"]')
      const wide = groove ? groove.getBoundingClientRect().width : 0
      const done = fill ? fill.getBoundingClientRect().width : 0
      closePanel(p)
      /*
       * The share offer, out of the same footer.
       *
       * Its lines are not plain leaves: the reward line wraps an icon, so the text sits in text
       * nodes beside it. Each element's OWN text is collected instead, and the words that belong
       * to their button and their "new" badge are left out.
       */
      const own = (el) =>
        [...el.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => (n.textContent || '').trim())
          .filter(Boolean)
          .join(' ')
          .trim()
      const shareOf = () => {
        const box = p.querySelector('[class*="watchStreak"]')
        if (!box) return null
        const button = [...box.querySelectorAll('button')].find((b) =>
          /^(Поділитися|Share)$/i.test((b.textContent || '').trim())
        )
        if (!button) return null
        const said = []
        for (const el of [box, ...box.querySelectorAll('*')]) {
          const t = own(el)
          if (!t || t.length > 160) continue
          if (/^(Поділитися|Share|Нове|New)$/i.test(t)) continue
          if (said.indexOf(t) < 0) said.push(t)
        }
        if (said.length === 0) return null
        return { title: said[0], note: said.slice(1).join(' '), from: 'panel' }
      }
      const share = shareOf()
      return {
        streak: streak ? Number(streak) : null,
        left: ahead[1] ? Number(ahead[1]) : null,
        reward: ahead[2] ? Number(ahead[2]) : null,
        counted: wide > 0 && done / wide > 0.99,
        share: share
      }
    })()`
    ) as Promise<{
      streak: number | null
      left: number | null
      reward: number | null
      counted: boolean
      share: SharePrompt | null
    } | null>
  )
}

export interface RedeemResult {
  state: 'pressed' | 'needsText' | 'armed' | 'disabled' | 'gone' | 'noPanel' | 'refused'
  /** the balance before the attempt, so the caller can tell whether the words cost anything */
  balance?: string
  /** what the page itself said about it, when it said anything */
  message?: string
  /**
   * The streamer's own explanation of the reward, read off the card this press opened.
   *
   * Free to take here: the view has to be opened to press the button anyway, and for a reward
   * that wants a line of text this is where it says what to write.
   */
  desc?: string
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
/**
 * What a reward says about itself.
 *
 * Their card in the list carries the price and the name and nothing else; the explanation the
 * streamer wrote lives in the reward's own view, one press in. Measured there: the leaves read
 * name, then the description, then the label on the confirm button, so the description is
 * everything between the two. A reward without one goes straight from the name to the button and
 * comes back empty.
 *
 * It matters most for the rewards that ask for a line of text, because that description is where
 * it says WHAT to write, and until now the app asked for the words without passing on the
 * question.
 *
 * The view is left as it was found: back to the list, never Escape, which would also take the
 * player out of theatre mode.
 */
export function readRewardDesc(channel: string, key: string): Promise<string | null> {
  return serial(channel, () =>
    ask<string>(
      channel,
    `(async () => {
      ${PANEL_SCRIPT}
      let p = await openPanel()
      if (!p) return null
      const want = ${JSON.stringify(key)}
      const card = cards(p).find((x) => x.whole === want)
      if (!card) return null
      /*
       * The name is cut off the front of the card, not matched out of it.
       *
       * Their key is the price and the name run together, "5 000не зайобуй", and the space in the
       * price is a non-breaking one. A pattern for "digits and spaces" cannot be written here: the
       * script reaches the page as a template literal and one backslash of it is eaten, so \s
       * arrives as a literal "s" and the strip stopped at the first zero. Measured: the name came
       * out as "000не зайобуй", which matched nothing in the card, so every reward priced in
       * thousands looked like a reward with no description at all. The card already knows its own
       * price, and cutting exactly that many characters cannot be got wrong.
       */
      const name = card.whole.slice(card.cost.length).trim()
      const isConfirm = (t) => /^(Отримати|Обміняти|Redeem|Get)/i.test(t)
      /* Twitch's own footnote about live-only rewards is not the streamer's description */
      const theirs = (t) => /тільки під час стриму|тільки під час трансляц|while the stream is live|only be redeemed/i.test(t)
      const readLeaves = () => {
        const box = panel()
        if (!box) return []
        return [...box.querySelectorAll('*')]
          .filter((e) => e.children.length === 0 && (e.textContent || '').trim())
          .map((e) => (e.textContent || '').trim())
      }
      card.b.click()
      let leaves = []
      let opened = false
      for (let i = 0; i < 16; i++) {
        await wait(250)
        leaves = readLeaves()
        if (leaves.some(isConfirm)) {
          opened = true
          break
        }
      }
      let at = leaves.indexOf(name)
      if (at < 0) at = leaves.findIndex((t) => t.indexOf(name) >= 0)
      const out = []
      for (let i = at + 1; i < leaves.length && at >= 0; i++) {
        const t = leaves[i]
        if (isConfirm(t) || onlyDigits(t)) break
        if (theirs(t)) continue
        out.push(t)
      }
      p = panel() || p
      await backToList(p)
      /*
       * "Could not read it" and "there is nothing to read" are different answers.
       *
       * The caller remembers what comes back, so a card that had not finished rendering used to be
       * remembered as a reward with no description at all — and one that does have one then said
       * "the streamer wrote no description" for the rest of the session. null means ask again.
       */
      if (!opened || at < 0) return null
      return out.join(' ')
    })()`
    )
  )
}

export function redeemReward(channel: string, key: string, text?: string): Promise<RedeemResult> {
  return serial(channel, () =>
    ask<RedeemResult>(
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

      /*
       * What the streamer wrote about this reward, taken while its card is open.
       *
       * The leaves of the open card read name, description, then the label on the confirm button,
       * so the description is what lies between the two; a reward without one comes back empty.
       */
      const describe = () => {
        const box = panel()
        if (!box) return ''
        const leaves = [...box.querySelectorAll('*')]
          .filter((e) => e.children.length === 0 && (e.textContent || '').trim())
          .map((e) => (e.textContent || '').trim())
        const isConfirm = (t) => /^(Отримати|Обміняти|Redeem|Get)/i.test(t)
        const theirs = (t) => /тільки під час стриму|тільки під час трансляц|while the stream is live|only be redeemed/i.test(t)
        let at = leaves.indexOf(name)
        if (at < 0) at = leaves.findIndex((t) => t.indexOf(name) >= 0)
        if (at < 0) return ''
        const out = []
        for (let i = at + 1; i < leaves.length; i++) {
          const t = leaves[i]
          if (isConfirm(t) || onlyDigits(t)) break
          if (theirs(t)) continue
          out.push(t)
        }
        return out.join(' ')
      }
      const desc = describe()

      // the prompt is up: the words have to be typed for real, which only the player can do
      if (prompt && !go) return { state: said ? 'armed' : 'needsText', balance: before, desc }

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
  )
}

/** one reward a drops campaign is offering on this channel */
export interface DropItem {
  /** the reward's own name, as their card writes it */
  name: string
  /** the game it belongs to */
  game: string
  /** what is still wanted, in their words: "Ще 1 підписка", "Дивись ще 15 хв" */
  need: string
  /** how far along, 0 to 100, off their own progress bar */
  percent: number
  /** the picture of the reward */
  icon: string | null
  /** their card is offering to hand it over: it has been earned */
  claim: boolean
  /**
   * This one has landed, set by the store rather than read.
   *
   * A campaign can offer several drops at once, one for watching and one for subscribing, say. As
   * each is earned Twitch takes THAT card out of the panel and leaves the others, so a reward that
   * was in the last reading and is not in this one is a reward that has arrived. Kept in the list
   * and marked, because otherwise the one that landed vanished from our panel too and the reader
   * was never told which of the two it was.
   */
  earned?: boolean
}

export interface DropsInfo {
  /** the channel is running drops at all, which is what their chest in the chat bar means */
  any: boolean
  items: DropItem[]
  /** "Доступні Drops: 1" */
  offered: number | null
  /** the line at the top of their panel, which names the campaign's category */
  about: string | null
  /**
   * Twitch has stopped offering this campaign on the channel, set by the store rather than read.
   *
   * Their chest disappears from the chat bar the moment there is nothing left to earn, which is
   * what happens when the drop is claimed: measured on a live campaign, the sub drop sat at 0%,
   * the viewer gifted a subscription, and the chest and its whole panel were simply gone the next
   * time the page was asked. The last reading is kept and marked, because otherwise the app threw
   * away everything it knew at the exact moment the reward arrived.
   */
  gone?: boolean
}

/*
 * Drops, read out of their own panel.
 *
 * There is no API for this either: the drops a viewer is making progress on live in the private
 * GraphQL, and what we can reach is the page. Twitch puts a chest in the chat bar of a channel
 * that has a campaign running (data-a-target="drops-button", the same shape as their bits button)
 * and the panel behind it lists every reward with a progress bar of its own.
 *
 * Measured on a live campaign rather than guessed: the panel is found by its heading, each reward
 * is the smallest box that holds both a progress bar and the reward's picture, and inside it the
 * three lines are the reward, the game and what is still needed. The bar carries its own number in
 * aria-valuenow, so the percentage is read rather than worked out from pixel widths.
 *
 * The panel is a toggle: it is opened if it was shut, and shut again afterwards, so a reading
 * leaves the page as it found it. Never closed with Escape, which would take the player out of
 * theatre mode as well.
 */
const DROPS_SCRIPT = `
  const text = (e) => (e.textContent || '').trim()
  const leaves = (root) =>
    [...root.querySelectorAll('*')].filter((e) => e.children.length === 0 && text(e))
  const panelHead = () =>
    [...document.querySelectorAll('*')].find(
      (e) => e.children.length === 0 && /Drops та інше|Drops and more/i.test(text(e))
    )
  const panelOf = (head) => {
    let box = head
    for (let i = 0; i < 8 && box.parentElement; i++) {
      box = box.parentElement
      if (box.getBoundingClientRect().height > 200) break
    }
    return box
  }
  const onlyDigits = (t) => {
    let out = ''
    for (const ch of t) if (ch >= '0' && ch <= '9') out += ch
    return out
  }
`

export function readDrops(channel: string): Promise<DropsInfo | null> {
  return serial(channel, () =>
    ask<DropsInfo>(
      channel,
    `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      ${DROPS_SCRIPT}
      const btn = document.querySelector('[data-a-target="drops-button"]')
      if (!btn) return { any: false, items: [], offered: null, about: null }
      let head = panelHead()
      const wasOpen = !!head
      if (!head) {
        btn.click()
        /* waited for rather than slept through: a page still building can take a second or two
           to draw the panel, and a fixed wait came back with an empty list */
        for (let i = 0; i < 12 && !head; i++) {
          await wait(250)
          head = panelHead()
        }
      }
      /* their chest is there but the panel would not open: that is a failed reading, not an
         empty campaign, and saying "no items" here would mark every drop as claimed */
      if (!head) return null
      const panel = panelOf(head)
      const all = leaves(panel).map(text)
      const about = all[1] && !/Доступні|available|Drops за|Drops for/i.test(all[1]) ? all[1] : null
      let offered = null
      for (const t of all) {
        if (!/Доступні Drops|Drops available/i.test(t)) continue
        const n = onlyDigits(t)
        if (n) offered = Number(n)
      }
      /*
       * Read twice, a moment apart, and only believe a list that agrees with itself.
       *
       * A drop that has been earned really does leave their panel, and that is how we know it
       * arrived; a panel that has not finished drawing looks exactly the same for a moment. Two
       * readings that match cost half a second and keep the app from announcing a claim that has
       * not happened.
       */
      const readItems = () => {
      const seen = []
      const items = []
      for (const wrap of panel.querySelectorAll('[class*="ScProgressBarWrapper"]')) {
        /* the card is the smallest box round this bar that also carries the reward's picture */
        let card = wrap
        for (let i = 0; i < 6 && card.parentElement; i++) {
          card = card.parentElement
          if (card.querySelector('img')) break
        }
        if (seen.indexOf(card) >= 0) continue
        seen.push(card)
        const words = leaves(card)
          .map(text)
          .filter((t) => !/Доступні Drops|Drops available|Drops за|Drops for/i.test(t))
        const img = card.querySelector('img')
        const pc = Number(wrap.getAttribute('aria-valuenow') || '0')
        const claim = [...card.querySelectorAll('button')].some((b) =>
          /Отримати|Забрати|Claim/i.test(text(b))
        )
        items.push({
          name: words[0] || '',
          game: words[1] || '',
          need: words[2] || '',
          percent: Number.isFinite(pc) ? Math.max(0, Math.min(100, pc)) : 0,
          icon: img ? img.src : null,
          claim: claim
        })
      }
        return items
      }
      let items = readItems()
      const names = () => items.map((x) => x.name).sort().join('|')
      for (let i = 0; i < 3; i++) {
        const was = names()
        await wait(600)
        items = readItems()
        if (names() === was) break
      }
      if (!wasOpen) {
        btn.click()
        await wait(400)
      }
      return { any: true, items, offered, about }
    })()`
    )
  )
}

/**
 * Take a drop their panel is offering.
 *
 * Twitch hands most of them over by itself, but a campaign can hold one behind a button, and then
 * it sits there unclaimed until somebody presses it. The card is found by the reward's own name,
 * for the same reason the prediction outcomes are.
 */
export function claimDrop(channel: string, name: string): Promise<boolean | null> {
  return serial(channel, () =>
    ask<boolean>(
      channel,
    `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      ${DROPS_SCRIPT}
      const btn = document.querySelector('[data-a-target="drops-button"]')
      if (!btn) return false
      let head = panelHead()
      const wasOpen = !!head
      if (!head) {
        btn.click()
        await wait(1300)
        head = panelHead()
      }
      if (!head) return false
      const want = ${JSON.stringify(name)}
      const panel = panelOf(head)
      let took = false
      for (const wrap of panel.querySelectorAll('[class*="ScProgressBarWrapper"]')) {
        let card = wrap
        for (let i = 0; i < 6 && card.parentElement; i++) {
          card = card.parentElement
          if (card.querySelector('img')) break
        }
        const words = leaves(card).map(text)
        if (want && words.indexOf(want) < 0) continue
        const take = [...card.querySelectorAll('button')].find((b) =>
          /Отримати|Забрати|Claim/i.test(text(b))
        )
        if (!take || take.disabled) continue
        take.click()
        await wait(900)
        took = true
        break
      }
      if (!wasOpen) {
        btn.click()
        await wait(400)
      }
      return took
    })()`
    )
  )
}

/** what Twitch is offering to let you share, in its own words */
export interface SharePrompt {
  /** the heading of their card: "Твоя серія переглядів: 7" */
  title: string
  /** the line under it: "Ти отримав(-ла) додаткову нагороду: 450!" */
  note: string
  /**
   * Which of their two places it was found in.
   *
   * A watch streak sits in the rewards panel and waits there until it is shared. An anniversary or
   * a subscription comes as a bar over the chat box instead, marked "Видно лише тобі", and that one
   * has a clock on it: when it runs out it drops into the chat and scrolls away with everything
   * else. So the bar is looked for on the fast tick and the panel on the slow one, and neither
   * reading is allowed to clear the other's offer.
   */
  from: 'bar' | 'panel'
}

/*
 * The share offer that comes as a bar over their chat box.
 *
 * Found by the button, which says only "Поділитися", inside the chat column and outside the
 * balance panel — the panel's own offer is read on a different pass, and the channel header's
 * share button (data-a-target="share-button") is not in that column at all.
 */
const SHARE_BAR = `
  const barButton = () => {
    const col = document.querySelector('.right-column')
    if (!col) return null
    return (
      [...col.querySelectorAll('button')].find((b) => {
        if (b.closest('[class*="Attached"]')) return false
        const target = b.getAttribute('data-a-target') || ''
        /*
         * Not their send button, which says "Поділитися" too while the box is armed.
         *
         * That is what put "0 19 496 Посилення та нагороди Усі..." on our card as the thing being
         * shared: the send button matched, and the card walked up into the whole chat row.
         */
        if (target === 'share-button' || target === 'chat-send-button') return false
        const label = (b.getAttribute('aria-label') || '').trim()
        return /^(Поділитися|Share)$/i.test((b.textContent || '').trim()) || /^(Поділитися|Share)$/i.test(label)
      }) || null
    )
  }
  /*
   * The offer's own card, stopping short of the chat box.
   *
   * Their bar sits right above the input and shares a parent with it a couple of levels up, so
   * "the first ancestor with some text in it" swallowed the whole row: the card came out reading
   * "0 19 496 Посилення та нагороди Усі..." which is the balance panel and the emote picker.
   */
  const barCard = (b) => {
    let card = b
    for (let i = 0; i < 7 && card.parentElement; i++) {
      const up = card.parentElement
      if (up.querySelector('[data-a-target="chat-input"]')) return card
      card = up
      if ((card.textContent || '').trim().length > 24) return card
    }
    return card
  }
`

/** their bar over the chat box, while it is up */
export function readBarShare(channel: string): Promise<SharePrompt | null> {
  return ask<SharePrompt>(
    channel,
    `(() => {
      ${SHARE_BAR}
      const b = barButton()
      if (!b) return null
      const card = barCard(b)
      const own = (el) =>
        [...el.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => (n.textContent || '').trim())
          .filter(Boolean)
          .join(' ')
          .trim()
      const said = []
      for (const el of [card, ...card.querySelectorAll('*')]) {
        const t = own(el)
        if (!t || t.length > 160) continue
        if (/^(Поділитися|Share|Нове|New|Видно лише тобі|Only visible to you)$/i.test(t)) continue
        if (said.indexOf(t) < 0) said.push(t)
      }
      if (said.length === 0) return null
      return { title: said[0], note: said.slice(1).join(' '), from: 'bar' }
    })()`
  )
}

/*
 * Sharing takes two steps, because that is how their own page does it.
 *
 * Pressing the offer in the panel does not post anything: measured on a live streak, it arms the
 * page's chat box instead — a prompt appears over it reading "Поділися своєю серією переглядів!"
 * and their send button changes from "Чат" to "Поділитися". The words are then typed and sent
 * through THAT box, exactly like a reward that asks for a message, and Twitch decorates them with
 * the streak. Pressing and walking away posts nothing at all, which is what "the card disappeared
 * and nothing was in chat" was.
 */
const SHARE_PROMPT = `
  /*
   * Whether their chat box is armed for a share, told by their own send button.
   *
   * It reads "Чат" normally and "Поділитися" while a share is waiting to be written, whatever the
   * share is about. The words over the box are not a test: they are different for every kind of
   * offer — "Поділися своєю серією переглядів!" for a streak, "Поділись річницею підписки в чаті!"
   * for an anniversary — and matching one of them meant the app called a perfectly armed box a
   * failure, said so, and then pressed their button a second time, which sent the share with an
   * empty message.
   */
  const sendButton = () => document.querySelector('[data-a-target="chat-send-button"]')
  const armedNow = () => {
    const s = sendButton()
    if (!s) return false
    const said = ((s.textContent || '') + ' ' + (s.getAttribute('aria-label') || '')).trim()
    return /Поділитися|Share/i.test(said)
  }
  /** the box the prompt is wrapped around, for its own close button */
  const promptBox = () => {
    let n = document.querySelector('[data-a-target="chat-input"]')
    for (let i = 0; i < 14 && n; i++) {
      n = n.parentElement
      if (!n) break
      if ((n.textContent || '').trim().length > 600) return null
      const x = [...n.querySelectorAll('button')].find((b) =>
        /Закрити|Close/i.test(b.getAttribute('aria-label') || '')
      )
      if (x) return n
    }
    return null
  }
`

/**
 * Press their offer, which arms the page's chat box for the share.
 *
 * Their panel closes itself on the press, so nothing is read back out of it; the prompt over the
 * chat box is what says it worked.
 */
export function armShare(channel: string): Promise<boolean | null> {
  return serial(channel, () =>
    ask<boolean>(
      channel,
      `(async () => {
      ${PANEL_SCRIPT}
      ${SHARE_PROMPT}
      ${SHARE_BAR}
      /* already armed: pressing again would send it with nothing written in it */
      if (armedNow()) return true
      const waitForPrompt = async () => {
        for (let i = 0; i < 12; i++) {
          await wait(250)
          if (armedNow()) return true
        }
        return false
      }
      /* the bar over the chat box first: it is the one with a clock on it */
      const bar = barButton()
      if (bar && !bar.disabled) {
        bar.click()
        if (await waitForPrompt()) return true
      }
      const p = await openPanel()
      if (!p) return false
      const box = p.querySelector('[class*="watchStreak"]')
      if (!box) return false
      const b = [...box.querySelectorAll('button')].find((x) =>
        /^(Поділитися|Share)$/i.test((x.textContent || '').trim())
      )
      if (!b || b.disabled) return false
      b.click()
      return await waitForPrompt()
    })()`
    )
  )
}

/**
 * Send the words through their armed chat box.
 *
 * Only the player can type for real, and their editor takes nothing else — the same reason a
 * reward that wants a message goes through here. The prompt disappearing is what says it went.
 */
export async function sendShare(channel: string, words: string): Promise<boolean | null> {
  const page = pages.get(channel)
  if (!page) return null
  const armed = await ask<boolean>(
    channel,
    `(() => {
      ${SHARE_PROMPT}
      return armedNow()
    })()`
  )
  if (!armed) return false
  await page.typeAndSend(words)
  /*
   * Waited for, not glanced at.
   *
   * Their prompt takes a moment to go after the message does, and a single look 600ms later
   * reported failure on a share that had plainly worked — the line was in chat and the app showed
   * an error over it. The box emptying is the other half of the answer: their editor leaves a
   * refused message sitting in it, so an empty box after typing means it went.
   */
  const ok = await ask<boolean>(
    channel,
    `(async () => {
      ${SHARE_PROMPT}
      for (let i = 0; i < 16; i++) {
        await wait(250)
        if (!armedNow()) return true
      }
      const box = document.querySelector('[data-a-target="chat-input"]')
      return !!box && (box.textContent || '').trim() === ''
    })()`
  )
  return ok === true
}

/** Put their prompt away without sending anything: it has a close of its own. */
export function cancelShare(channel: string): Promise<boolean | null> {
  return ask<boolean>(
    channel,
    `(() => {
      ${SHARE_PROMPT}
      if (!armedNow()) return true
      const wrap = promptBox()
      if (!wrap) return false
      const x = [...wrap.querySelectorAll('button')].find((b) =>
        /Закрити|Close/i.test(b.getAttribute('aria-label') || '')
      )
      if (!x) return false
      x.click()
      return true
    })()`
  )
}

/** a prediction as their own panel shows it, for when the topic has told us nothing */
export interface PagePrediction {
  question: string
  /** "Подання заявок завершується за 7:55", as they write it */
  timeLeft: string | null
  options: { label: string; share: string; votes: string }[]
}

/**
 * Read a running prediction out of their panel.
 *
 * The topics are the proper source and they carry the clock and the tally, but they only speak
 * when something happens: start the app in the middle of a prediction nobody is betting on, or
 * reload it, and there is nothing to draw a card from at all — which is exactly how the card
 * disappeared while the prediction was still running.
 *
 * So the page is asked, the same way everything else here is. Their card in the column is
 * collapsed and holds only the question, so the panel behind its "Прогноз" button is opened, the
 * outcomes read off it — each is a ScInteractable whose leaves are the name, the share and the
 * points — and the panel is put back as it was found.
 */
export function readPagePrediction(channel: string): Promise<PagePrediction | null> {
  return serial(channel, () =>
    ask<PagePrediction>(
      channel,
      `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const text = (e) => (e.textContent || '').trim()
      const col = document.querySelector('.right-column') || document.body
      const panel = () =>
        [...document.querySelectorAll('[class*="Attached"]')].find((e) => /Прогноз|Predict/i.test(text(e)))
      const rows = () => {
        const p = panel()
        if (!p) return []
        return [...p.querySelectorAll('[class*="ScInteractable"]')].filter((e) => text(e).length > 1)
      }
      const wasOpen = !!panel()
      let p = panel()
      if (!p) {
        const open = [...col.querySelectorAll('button')].find((b) => /^(Прогноз|Predict)$/i.test(text(b)))
        if (!open) return null
        open.click()
        for (let i = 0; i < 16 && !panel(); i++) await wait(250)
        p = panel()
        if (!p) return null
      }
      for (let i = 0; i < 3 && rows().length === 0; i++) {
        const back = [...p.querySelectorAll('button')].find((b) =>
          /Назад|Back/i.test(b.getAttribute('aria-label') || '')
        )
        if (!back) break
        back.click()
        await wait(700)
        p = panel() || p
      }
      const list = rows()
      if (list.length < 2) {
        if (!wasOpen) {
          const shut = [...p.querySelectorAll('button')].find((b) =>
            /Закрити|Close/i.test(b.getAttribute('aria-label') || '')
          )
          if (shut) shut.click()
        }
        return null
      }
      const options = list.map((row) => {
        const said = [...row.querySelectorAll('*')]
          .filter((e) => e.children.length === 0 && text(e))
          .map((e) => text(e))
        return {
          label: said[0] || text(row),
          share: (said[1] || '').replace(/ /g, ''),
          votes: said[2] || ''
        }
      })
      /* the question and their countdown, from the lines that are not outcomes */
      const lines = [...p.querySelectorAll('*')]
        .filter((e) => e.children.length === 0 && text(e))
        .map((e) => text(e))
      const names = options.map((o) => o.label)
      const spare = lines.filter(
        (t) => t.length > 2 && t.length < 120 && names.indexOf(t) < 0 && !/^[0-9 ]+%?$/.test(t)
      )
      const clock = spare.find((t) => /завершується|closes|Подання/i.test(t)) || null
      const question =
        spare.find((t) => t !== clock && !/^(Прогноз|Predict|Прогнозуй)/i.test(t)) || ''
      if (!wasOpen) {
        const shut = [...(panel() ?? p).querySelectorAll('button')].find((b) =>
          /Закрити|Close/i.test(b.getAttribute('aria-label') || '')
        )
        if (shut) shut.click()
      }
      return { question, timeLeft: clock, options }
    })()`
    )
  )
}
