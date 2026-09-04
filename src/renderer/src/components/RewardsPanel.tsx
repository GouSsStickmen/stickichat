import { useEffect, useState } from 'react'
import {
  readRewards,
  readRewardDesc,
  redeemReward,
  hasPlayerPage,
  type RewardList
} from '../lib/playerPage'
import { useUiStore } from '../store/ui'
import { useT } from '../i18n'
import { CloseIcon } from './Icons'

/**
 * The channel's rewards, read out of the open Twitch page and redeemable from here.
 *
 * There is no API for this. A broadcaster can manage their own rewards through Helix and that is
 * the whole of it: redeeming one as a viewer exists only in the private GraphQL the site talks to
 * itself, which refuses our token. So this drives the page instead. It opens the rewards panel
 * inside the player, copies out what is on offer, closes it again, and presses the reward you pick.
 *
 * Which is why it needs a player: with no page open there is nothing to read and nothing to press,
 * and the panel says so rather than showing an empty list.
 */
export default function RewardsPanel({
  channel,
  onClose
}: {
  channel: string
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const [list, setList] = useState<RewardList | null>(null)
  const [busy, setBusy] = useState(true)
  const [said, setSaid] = useState<string | null>(null)
  const balance = useUiStore(
    (s) => s.playerPoints[channel]?.balanceText ?? s.playerPoints[channel]?.balance?.toLocaleString('uk-UA') ?? null
  )
  const open = hasPlayerPage(channel)
  const descs = useUiStore((s) => s.rewardDesc[channel]) ?? {}

  const load = async (): Promise<void> => {
    setBusy(true)
    const rows = await readRewards(channel)
    setList(rows)
    // the streak only shows up in this panel, so this is the one chance to record it
    if (rows?.streak != null) {
      useUiStore.getState().setPlayerPoints(channel, { streak: rows.streak })
    }
    setBusy(false)
  }

  useEffect(() => {
    if (!open) {
      setBusy(false)
      return
    }
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, open])

  /*
   * A reward that wants a line of text asks for it here.
   *
   * The page it would be typed into is deliberately invisible, so the request comes back out to
   * this panel and goes in with the second attempt.
   */
  /*
   * Pressed, but not spent yet.
   *
   * A press on a reward used to redeem it there and then, which is one slip away from spending
   * five thousand points on the wrong thing, and it also left no moment at which the streamer's
   * own description of the reward could be read. Now the press opens the reward, and a second
   * press on the confirm is what actually redeems it.
   */
  const [pending, setPending] = useState<{ key: string; name: string; cost: number | null } | null>(
    null
  )
  const [asking, setAsking] = useState<{ key: string; name: string } | null>(null)
  const [words, setWords] = useState('')

  /** the first press: show what it is, and read its description if it is not known yet */
  const [reading, setReading] = useState(false)
  const choose = async (key: string, name: string, cost: number | null): Promise<void> => {
    setSaid(null)
    setAsking(null)
    setPending({ key, name, cost })
    // an empty one is worth one more try at the moment somebody is actually looking at it
    if (useUiStore.getState().rewardDesc[channel]?.[key]) return
    setReading(true)
    const said = await readRewardDesc(channel, key)
    if (said !== null) useUiStore.getState().setRewardDesc(channel, key, said)
    setReading(false)
  }

  const redeem = async (key: string, name: string, text?: string): Promise<void> => {
    setSaid(t('points.redeeming', { name }))
    const res = await redeemReward(channel, key, text)
    if (res.desc) useUiStore.getState().setRewardDesc(channel, key, res.desc)
    if (res.state === 'needsText') {
      setAsking({ key, name })
      setWords('')
      setSaid(null)
      return
    }
    setAsking(null)
    setSaid(
      res.state === 'pressed'
        ? t('points.redeemed', { name })
        : res.state === 'disabled'
          ? t('points.tooDear')
          : // what Twitch said about it beats anything we could invent
            (res.message ?? t('points.redeemFailed'))
    )
    // the balance is read from the page every few seconds anyway; this just makes it prompt
    window.setTimeout(() => void load(), 1500)
  }

  return (
    <div className="rewards-panel">
      <div className="rewards-head">
        <b>{t('points.rewardsTitle')}</b>
        {balance !== null && <span className="rewards-balance">{balance}</span>}
        <div className="spacer" />
        {open && (
          <button className="ghost" disabled={busy} onClick={() => void load()}>
            {t('follows.refresh')}
          </button>
        )}
        <button className="ghost" title={t('misc.close')} onClick={onClose}>
          <CloseIcon size={13} />
        </button>
      </div>
      {!open ? (
        <div className="rewards-note">{t('points.needPlayer')}</div>
      ) : busy && !list ? (
        <div className="picker-empty">{t('picker.gifLoading')}</div>
      ) : !list ? (
        <div className="rewards-note">{t('points.noPanel')}</div>
      ) : (
        <>
          {list.streak != null && (
            <div className="rewards-streak">
              <span>{t('points.streak', { n: list.streak })}</span>
              {list.streakLeft != null && (
                <span className="rs-left">
                  {t('points.streakLeft', {
                    n: list.streakLeft,
                    reward: list.streakReward ?? '?'
                  })}
                </span>
              )}
            </div>
          )}
          {said && <div className="rewards-said">{said}</div>}
          {pending && (
            <div className="rewards-confirm">
              <b>{pending.name}</b>
              {/*
                The streamer's own explanation, read out of their card for this very moment.

                Nothing is written when there is none. It used to say "the streamer wrote no
                description" the moment a reading came back empty, and a reading came back empty
                whenever two of them collided in the page, so it said that about rewards that
                plainly do have one.
              */}
              {descs[pending.key] ? (
                <span className="rw-ask-desc">{descs[pending.key]}</span>
              ) : reading ? (
                <span className="rw-ask-desc">{t('points.reading')}</span>
              ) : null}
              <div className="rc-row">
                <button
                  className="primary"
                  onClick={() => {
                    const p = pending
                    setPending(null)
                    void redeem(p.key, p.name)
                  }}
                >
                  {pending.cost === null
                    ? t('points.redeemNow')
                    : t('points.redeemFor', { n: pending.cost.toLocaleString('uk-UA') })}
                </button>
                <button className="ghost" onClick={() => setPending(null)}>
                  {t('misc.cancel')}
                </button>
              </div>
            </div>
          )}
          {asking && (
            <div className="rewards-ask">
              <label>{t('points.needText', { name: asking.name })}</label>
              {/* the streamer's own words about it: usually they say what to write here */}
              {descs[asking.key] && <span className="rw-ask-desc">{descs[asking.key]}</span>}
              <input
                autoFocus
                value={words}
                onChange={(e) => setWords(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && words.trim()) void redeem(asking.key, asking.name, words.trim())
                  if (e.key === 'Escape') setAsking(null)
                }}
              />
              <button
                className="primary"
                disabled={!words.trim()}
                onClick={() => void redeem(asking.key, asking.name, words.trim())}
              >
                {t('points.send')}
              </button>
            </div>
          )}
          <div className="rewards-list">
            {list.rewards.length === 0 ? (
              <div className="picker-empty">{t('points.noRewards')}</div>
            ) : (
              list.rewards.map((r) => (
                <button
                  key={r.key}
                  className={`rewards-row ${r.disabled ? 'off' : ''} ${
                    pending?.key === r.key ? 'chosen' : ''
                  }`}
                  disabled={r.disabled}
                  onClick={() => void choose(r.key, r.name, r.cost)}
                >
                  {r.icon ? (
                    <img className="rw-icon" src={r.icon} alt="" />
                  ) : (
                    <span className="rw-icon" />
                  )}
                  <span className="rw-name">{r.name}</span>
                  <span className="rw-cost">{r.cost === null ? '' : r.cost.toLocaleString('uk-UA')}</span>
                </button>
              ))
            )}
          </div>
          <p className="hint rewards-hint">{t('points.pageHint')}</p>
        </>
      )}
    </div>
  )
}
