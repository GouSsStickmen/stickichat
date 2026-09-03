import { useEffect, useState } from 'react'
import { readRewards, redeemReward, hasPlayerPage, type RewardList } from '../lib/playerPage'
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

  const load = async (): Promise<void> => {
    setBusy(true)
    const rows = await readRewards(channel)
    setList(rows)
    // the streak only shows up in this panel, so this is the one chance to record it
    if (rows?.streak != null) {
      const now = useUiStore.getState().playerPoints[channel]
      useUiStore.getState().setPlayerPoints(channel, {
        balance: now?.balance ?? null,
        chest: now?.chest ?? false,
        streak: rows.streak
      })
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
  const [asking, setAsking] = useState<{ key: string; name: string } | null>(null)
  const [words, setWords] = useState('')

  const redeem = async (key: string, name: string, text?: string): Promise<void> => {
    setSaid(t('points.redeeming', { name }))
    const res = await redeemReward(channel, key, text)
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
          {asking && (
            <div className="rewards-ask">
              <label>{t('points.needText', { name: asking.name })}</label>
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
                  className={`rewards-row ${r.disabled ? 'off' : ''}`}
                  disabled={r.disabled}
                  onClick={() => void redeem(r.key, r.name)}
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
