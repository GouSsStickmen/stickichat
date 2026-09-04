import { useState } from 'react'
import { claimDrop, hasPlayerPage } from '../lib/playerPage'
import { useUiStore } from '../store/ui'
import { useT } from '../i18n'
import { CloseIcon } from './Icons'
import DropsInventory from './DropsInventory'

/**
 * The drops this channel is running, and how far along each one is.
 *
 * Read out of the page, like the rewards and for the same reason: a viewer's progress towards a
 * drop lives in the private GraphQL the site talks to itself, and the only place we may look is
 * the page the player already has open. Twitch puts a chest in its chat bar when a campaign is
 * running; this is what is behind that chest, drawn where the rest of the app can see it.
 *
 * Two kinds arrive here and both are drawn the same way: one wants a subscription ("Ще 1 підписка")
 * and one wants watch time ("Дивись ще 15 хв"). Their own words are kept rather than reworded,
 * because they are the ones that know what the campaign actually asks for.
 */
export default function DropsPanel({
  channel,
  onClose
}: {
  channel: string
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const drops = useUiStore((s) => s.playerDrops[channel])
  const owned = useUiStore((s) => s.dropsOwned)
  const ownedAt = useUiStore((s) => s.dropsOwnedAt)
  /*
   * The inventory is loaded while this panel is open, and not oftener than every few minutes.
   *
   * It is a whole Twitch page in a view of its own, so it is not something to keep running; but
   * it is the only place that says what actually arrived, so it is worth one load when somebody
   * opens the panel to find out.
   */
  const readInventory = Date.now() - ownedAt > 180000
  const [busy, setBusy] = useState('')
  const open = hasPlayerPage(channel)

  /* the ones still counting, and the ones that have arrived, drawn in that order */
  const items = drops?.items ?? []
  const landed = items.filter((d) => d.earned || d.claim || d.percent >= 100)
  const waiting = items.filter((d) => !landed.includes(d))

  const take = async (name: string): Promise<void> => {
    setBusy(name)
    await claimDrop(channel, name)
    setBusy('')
  }

  return (
    <div className="rewards-panel drops-panel">
      <div className="rewards-head">
        <b>{t('drops.title')}</b>
        {drops?.offered != null && (
          <span className="rewards-balance">{t('drops.offered', { n: drops.offered })}</span>
        )}
        <div className="spacer" />
        <button className="ghost" title={t('misc.close')} onClick={onClose}>
          <CloseIcon size={13} />
        </button>
      </div>
      {readInventory && <DropsInventory />}
      {!open ? (
        <div className="rewards-note">{t('drops.needPlayer')}</div>
      ) : (
        <>
          {!drops || drops.items.length === 0 ? (
            <div className="rewards-note">{t('drops.none')}</div>
          ) : (
            <>
              {drops.about && <p className="hint drops-about">{drops.about}</p>}
              {/*
                How the campaign stands, when it offers more than one reward.

                A channel commonly runs two at once, one for watching and one for subscribing, and
                they arrive at different times: this says how many have landed and how many are
                still counting, so the one that is left is not mistaken for nothing at all.
              */}
              {landed.length > 0 && (
                <div className="rewards-said">
                  {waiting.length > 0
                    ? t('drops.tally', { got: landed.length, left: waiting.length })
                    : t('drops.allGot', { n: landed.length })}
                </div>
              )}
              <div className="drops-list">
                {[...waiting, ...landed].map((d) => {
                  const done = !!d.earned || d.claim || d.percent >= 100
                  return (
                    <div key={d.name} className={`drop-row ${done ? 'done' : ''}`}>
                      {d.icon ? (
                        <img className="rw-icon" src={d.icon} alt="" />
                      ) : (
                        <span className="rw-icon" />
                      )}
                      <div className="drop-what">
                        <span className="drop-name">{d.name}</span>
                        {d.game && <span className="drop-game">{d.game}</span>}
                        {d.need && !done && <span className="drop-need">{d.need}</span>}
                        {/* their own bar, redrawn: the number comes from it, not from its width */}
                        {!done && (
                          <span className="drop-bar">
                            <span style={{ width: `${Math.max(0, Math.min(100, d.percent))}%` }} />
                          </span>
                        )}
                      </div>
                      {d.claim ? (
                        <button
                          className="primary"
                          disabled={busy === d.name}
                          onClick={() => void take(d.name)}
                        >
                          {t('drops.claim')}
                        </button>
                      ) : (
                        <span className="drop-pc">
                          {done ? t('drops.ready') : `${Math.round(d.percent)}%`}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
          {/* what actually arrived, from Twitch's own inventory: the channel page never says */}
          {owned.length > 0 && (
            <>
              <b className="drops-owned-head">{t('drops.owned')}</b>
              <div className="drops-list">
                {owned.slice(0, 6).map((o) => (
                  <div key={`${o.name}-${o.when}`} className="drop-row owned">
                    {o.icon ? (
                      <img className="rw-icon" src={o.icon} alt="" />
                    ) : (
                      <span className="rw-icon" />
                    )}
                    <div className="drop-what">
                      <span className="drop-name">{o.name}</span>
                      <span className="drop-game">{o.when}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          <p className="hint rewards-hint">{t('drops.hint')}</p>
        </>
      )}
    </div>
  )
}
