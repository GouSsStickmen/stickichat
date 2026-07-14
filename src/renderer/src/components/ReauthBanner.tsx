import { useUiStore } from '../store/ui'
import { useT } from '../i18n'

/**
 * Persistent top banner shown when an account's token died and its refresh token could no
 * longer produce a working one — the only fix is a full re-authorization. This makes the
 * "silently can't send" state visible instead of leaving the user guessing.
 */
export default function ReauthBanner(): React.JSX.Element | null {
  const t = useT()
  const accounts = useUiStore((s) => s.reauthAccounts)
  if (accounts.length === 0) return null

  const logins = accounts.map((a) => a.login).join(', ')
  return (
    <div className="reauth-banner">
      <span className="reauth-banner-text">
        ⚠ {t('auth.reauthBanner', { login: logins })}
      </span>
      <div className="reauth-banner-actions">
        <button className="primary" onClick={() => useUiStore.getState().setAddAccountOpen(true)}>
          {t('auth.reauthNow')}
        </button>
        <button
          className="ghost"
          title={t('auth.reauthDismiss')}
          onClick={() => accounts.forEach((a) => useUiStore.getState().clearReauthNeeded(a.id))}
        >
          ✕
        </button>
      </div>
    </div>
  )
}
