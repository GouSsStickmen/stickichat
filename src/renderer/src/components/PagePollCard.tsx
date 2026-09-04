import { useEffect, useLayoutEffect, useState } from 'react'
import { votePoll, betPrediction } from '../lib/playerPage'
import { useUiStore, type PagePollState } from '../store/ui'
import { useT } from '../i18n'

/**
 * The channel's running poll or prediction, drawn at the top of the chat.
 *
 * Twitch's own card cannot be put here: it lives inside the page the player has open, in a column
 * we hide, so wherever it is moved it still lands over the video, and shown there it flickered as
 * their React redrew the card out from under the mark we had put on it. So the state comes from
 * their poll and prediction topics, which know the clock, the tally and the verdict, and the press
 * is passed back to their own buttons, which is the only thing that can actually cast anything.
 *
 * Nothing is spent on one press. Their card asks you to pick and then confirm, and so does this
 * one: a poll shows the chosen option with a confirm beside it, a prediction opens the amount to
 * be typed first, so a misplaced click costs nothing.
 *
 * It folds away rather than closes while it is running, so it cannot be lost before voting, and
 * gains a close button once it is over.
 */
/**
 * Every poll and prediction a channel is running, one card each.
 *
 * A channel can have both at once and Twitch shows both, so this is a list: keyed by one card per
 * channel, whichever arrived last hid the other.
 */
export default function PagePollCards({ channel }: { channel: string }): React.JSX.Element | null {
  const polls = useUiStore((s) => s.pagePolls[channel]) ?? []
  const here = polls.length > 0
  /*
   * The chat is told the moment this appears or goes, in the same frame it happens.
   *
   * A card arriving above the list takes a couple of hundred pixels off the height of it, and
   * left to itself the smooth glide ANIMATES the recovery: measured on a live poll, restoring
   * the card from its icon opened a 154px gap at the bottom which then eased shut over some two
   * dozen frames. That is the dip and the settle people described. The list already knows the
   * difference between a message arriving, which is worth animating, and the page changing shape
   * under the reader, which is not — it only had to be told this is one of the second kind.
   */
  useLayoutEffect(() => {
    window.dispatchEvent(new CustomEvent('sticki:rowresized'))
    return () => {
      window.dispatchEvent(new CustomEvent('sticki:rowresized'))
    }
  }, [here, channel])
  if (!here) return null
  return (
    <>
      {polls.map((poll) => (
        <OnePoll key={poll.id} channel={channel} poll={poll} />
      ))}
    </>
  )
}

function OnePoll({
  channel,
  poll
}: {
  channel: string
  poll: PagePollState
}): React.JSX.Element | null {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [folded, setFolded] = useState(false)
  /*
   * The clock ticks here.
   *
   * Twitch's own card in the page has no countdown in it at all, so the end time comes from their
   * topic and the seconds are counted locally: one timer in the app rather than a question asked
   * of the page every second.
   */
  const [now, setNow] = useState(Date.now())
  /** which option is picked and waiting to be confirmed */
  const [picked, setPicked] = useState(-1)
  const [stake, setStake] = useState(10)
  /** what came of the last press, when it was not simply "done" */
  const [said, setSaid] = useState<string | null>(null)

  // folding and unfolding changes the height as much as the card appearing does — same signal
  useLayoutEffect(() => {
    window.dispatchEvent(new CustomEvent('sticki:rowresized'))
  }, [folded])

  const endsAt = poll.endsAt
  useEffect(() => {
    if (!endsAt) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [endsAt])

  // a new question opens the card again and forgets the last pick
  const question = poll.question
  useEffect(() => {
    setFolded(false)
    setPicked(-1)
    setSaid(null)
  }, [question])

  /*
   * The press goes to their card in the page, and what came of it is said here.
   *
   * It used to go and never report: a prediction their page would not take simply did nothing at
   * all, which reads as a broken button rather than as "Twitch refused this".
   */
  const commit = async (index: number): Promise<void> => {
    setBusy(true)
    setSaid(null)
    const amount = Math.max(1, stake)
    const label = poll.options[index]?.label ?? ''
    if (poll.isPrediction) {
      const res = await betPrediction(channel, index, amount, label)
      if (res === 'placed') {
        // the topic names only the top ten predictors, so our own stake is remembered here
        useUiStore.getState().notePagePollStake(channel, poll.id, label, amount)
      } else {
        setSaid(
          res === null
            ? t('poll.needPlayer')
            : res === 'refused'
              ? t('poll.refused')
              : t('poll.noOutcome')
        )
      }
    } else {
      const ok = await votePoll(channel, index)
      if (ok === null) setSaid(t('poll.needPlayer'))
      else if (!ok) setSaid(t('poll.noOutcome'))
    }
    setBusy(false)
    setPicked(-1)
  }

  const leftMs = endsAt ? Math.max(0, endsAt - now) : null
  const clock =
    leftMs === null
      ? null
      : `${Math.floor(leftMs / 60000)}:${String(Math.floor((leftMs % 60000) / 1000)).padStart(2, '0')}`

  /*
   * The side we have already backed, if any.
   *
   * Twitch's rule: once points are on one outcome you cannot back another, only add more to that
   * one. So the others are turned off with that reason written on them, rather than offering a
   * press the page will refuse.
   */
  const mineAt = poll.options.findIndex((o) => o.mine > 0)
  const share = (s: string): number => Number(s.replace(/[^0-9]/g, '')) || 0
  /*
   * Whoever is on the top score wins, and a level poll has more than one of them.
   *
   * Twitch marks every option that shares the lead, two or three or all of them, and only a poll
   * where nobody voted at all has no winner to mark.
   */
  const best = poll.ended ? Math.max(...poll.options.map((o) => share(o.share))) : -1

  return (
    <div className={`page-poll ${poll.ended ? 'is-over' : ''}`}>
      <div className="pp-head">
        <span className="pp-kind">{poll.kind || t('poll.short')}</span>
        {poll.ended && <span className="pp-over">{t('poll.over')}</span>}
        {!poll.ended && poll.locked && (
          <span className="pp-over" title={t('poll.lockedHint')}>
            {t('poll.closed')}
          </span>
        )}
        {!poll.ended && (poll.timeLeft ?? clock) && (
          <span className="pp-clock" title={t('poll.timeLeft')}>
            {poll.timeLeft ?? clock}
          </span>
        )}
        <div className="spacer" />
        {/*
          Out of the way without being lost: a locked prediction can hang about for an hour, so it
          goes into the little button beside the channel rewards and comes back from there.
        */}
        <button
          className="pp-tuck"
          title={t('poll.tuck')}
          onClick={() => useUiStore.getState().hidePagePoll(channel, true)}
        >
          {/* the window-minimise dash: a plus turned on its side read as a second close cross,
              and an arrow into a tray read as a download */}
          <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden>
            <path
              d="M5 10.5h10"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button
          className="pp-fold"
          title={folded ? t('poll.unfold') : t('poll.fold')}
          onClick={() => setFolded((v) => !v)}
        >
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
            <path
              d={folded ? 'M4 7.5l6 6 6-6' : 'M4 12.5l6-6 6 6'}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {/* a finished one can be dismissed; a running one only folds */}
        {poll.ended && (
          <button
            className="pp-x"
            title={t('misc.close')}
            onClick={() => useUiStore.getState().dismissPagePoll(channel, poll.id)}
          >
            ✕
          </button>
        )}
      </div>
      {poll.question && <div className="pp-q">{poll.question}</div>}
      {/* the bar empties as the time runs out, off the same clock as the numbers */}
      {!poll.ended && (poll.ran !== null || leftMs !== null) && (
        <div className="pp-timebar">
          <span
            style={{
              width: `${Math.max(
                0,
                Math.min(
                  100,
                  poll.runsFor && leftMs !== null
                    ? Math.round((leftMs / poll.runsFor) * 100)
                    : poll.ran !== null
                      ? Math.round((1 - poll.ran) * 100)
                      : 0
                )
              )}%`
            }}
          />
        </div>
      )}
      {!folded && (
        <div className="pp-opts">
          {poll.options.map((o, i) => {
            const won = poll.ended
              ? poll.winner
                ? o.label === poll.winner
                : best > 0 && share(o.share) === best
              : false
            const barred =
              poll.ended ||
              poll.locked ||
              busy ||
              (poll.isPrediction && mineAt >= 0 && mineAt !== i) ||
              (!poll.isPrediction && poll.voted)
            return (
              <div key={`${o.label}-${i}`} className="pp-row">
                <button
                  className={`pp-opt ${o.picked ? 'picked' : ''} ${won ? 'won' : ''} ${
                    picked === i ? 'chosen' : ''
                  }`}
                  disabled={barred}
                  title={
                    poll.ended
                      ? t('poll.votingClosed')
                      : poll.locked
                        ? t('poll.lockedHint')
                      : poll.isPrediction
                        ? mineAt >= 0 && mineAt !== i
                          ? t('poll.locked', { name: poll.options[mineAt].label })
                          : mineAt === i
                            ? t('poll.addMore', { n: String(stake), had: String(o.mine) })
                            : t('poll.pick')
                        : poll.voted
                          ? t('poll.already')
                          : t('poll.pick')
                  }
                  onClick={() => setPicked((v) => (v === i ? -1 : i))}
                >
                  {/* the share is drawn as the row's own fill, so the numbers stay readable */}
                  <span className="pp-fill" style={{ width: o.share || '0%' }} />
                  <span className="pp-label">{o.label}</span>
                  {o.mine > 0 && (
                    <span className="pp-mine">{t('poll.mine', { n: String(o.mine) })}</span>
                  )}
                  {won && (
                    <span className="pp-crown">
                      <span className="pp-trophy" aria-hidden>
                        🏆
                      </span>
                      {t('poll.won')}
                    </span>
                  )}
                  <span className="pp-share">
                    {o.share}
                    {o.votes ? ` (${o.votes})` : ''}
                  </span>
                </button>
                {/* pick, then confirm: on Twitch a single click spends nothing either */}
                {picked === i && !poll.ended && (
                  <div className="pp-confirm">
                    {poll.isPrediction && (
                      <input
                        type="number"
                        min={1}
                        step={10}
                        autoFocus
                        value={stake}
                        title={t('poll.stakeHint')}
                        onChange={(e) => setStake(Math.max(1, Number(e.target.value) || 1))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commit(i)
                          if (e.key === 'Escape') setPicked(-1)
                        }}
                      />
                    )}
                    <button className="primary" disabled={busy} onClick={() => void commit(i)}>
                      {!poll.isPrediction
                        ? t('poll.voteNow')
                        : mineAt === i
                          ? t('poll.addNow', { n: String(stake) })
                          : t('poll.betNow', { n: String(stake) })}
                    </button>
                    <button className="ghost" onClick={() => setPicked(-1)}>
                      {t('misc.cancel')}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {said && <div className="pp-said">{said}</div>}
      {/* who was paid what, the way their card lists it once a prediction is resolved */}
      {poll.ended && poll.payouts.length > 0 && (
        <div className="pp-payouts">
          {poll.payouts.map((p) => (
            <span key={`${p.name}-${p.points}`}>
              {t('poll.payout', { name: p.name, n: p.points.toLocaleString('uk-UA') })}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
