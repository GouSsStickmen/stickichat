import React from 'react'
import { useUiStore } from '@renderer/store/ui'
import { useT } from '@renderer/i18n'

/**
 * The "are you sure" for a ban or a timeout.
 *
 * Deliberately not a neat little dialog: the destructive choice is the wide red one and it sits on
 * the right, away from where a thumb rests after a swipe that just crossed the screen. The name
 * being acted on is the largest thing in it, because the accidents this exists to stop were not
 * people choosing wrong — they were people not knowing a choice had been made at all.
 */
export default function ModConfirmSheet(): React.JSX.Element | null {
  const req = useUiStore((s) => s.modConfirm)
  const t = useT()
  if (!req) return null

  const answer = (ok: boolean): void => {
    // clear first: the resolver may open something of its own
    useUiStore.getState().setModConfirm(null)
    req.resolve(ok)
  }

  return (
    <div className="m-sheet-back" onClick={() => answer(false)}>
      <div className="m-sheet m-confirm" onClick={(e) => e.stopPropagation()}>
        <div className="m-confirm-what">
          {req.kind === 'ban'
            ? `🔨 ${t('swipe.ban')}`
            : req.kind === 'delete'
              ? `🗑 ${t('swipe.delete')}`
              : `⏱ ${req.duration ?? ''}`}
        </div>
        <div className="m-confirm-who">{req.login}</div>
        <div className="m-confirm-row">
          <button onClick={() => answer(false)}>{t('auth.cancel')}</button>
          <button className="danger-solid" onClick={() => answer(true)}>
            {req.kind === 'ban'
              ? t('swipe.ban')
              : req.kind === 'delete'
                ? t('swipe.delete')
                : t('mod.confirmTimeout')}
          </button>
        </div>
      </div>
    </div>
  )
}
