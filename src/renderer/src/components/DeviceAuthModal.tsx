import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'
import { useSettingsStore } from '../store/settings'
import { useAccountsStore } from '../store/accounts'
import { pollDeviceToken, startDeviceFlow, validateToken } from '../lib/twitchAuth'
import { createAccountFromTokens } from '../services/accountService'
import { reloadAllBadges } from '../services/emoteService'
import { persistAccountTokens } from '../services/config'
import { useUiStore } from '../store/ui'

type Phase = 'starting' | 'waiting' | 'done' | 'error'

export default function DeviceAuthModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useT()
  const clientId = useSettingsStore((s) => s.clientId)
  const [phase, setPhase] = useState<Phase>('starting')
  const [userCode, setUserCode] = useState('')
  const [verifyUri, setVerifyUri] = useState('https://www.twitch.tv/activate')
  const [error, setError] = useState('')
  const cancelledRef = useRef(false)

  useEffect(() => {
    cancelledRef.current = false
    ;(async () => {
      try {
        const device = await startDeviceFlow(clientId)
        setUserCode(device.user_code)
        if (device.verification_uri) setVerifyUri(device.verification_uri)
        setPhase('waiting')
        const pair = await pollDeviceToken(clientId, device, () => cancelledRef.current)
        const info = await validateToken(pair.access_token)
        if (!info) throw new Error('token validation failed')
        const account = await createAccountFromTokens(
          pair.access_token,
          pair.refresh_token,
          info.user_id,
          info.login
        )
        useAccountsStore.getState().addAccount(account)
        // write straight to disk: the settings window has no store persistence, and without
        // this a re-auth done there would evaporate on close (leaving dead tokens on disk)
        await persistAccountTokens(account.id)
        // a fresh token may fix previously-failed fetches (badges cache empty results)
        reloadAllBadges()
        useUiStore.getState().toast(t('auth.success'))
        setPhase('done')
        onClose()
      } catch (e) {
        if (cancelledRef.current) return
        setError(String(e))
        setPhase('error')
      }
    })()
    return () => {
      cancelledRef.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal small">
        <div className="modal-header">
          {t('auth.addAccount')}
          <div className="spacer" />
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {phase === 'starting' && <p>…</p>}
          {phase === 'waiting' && (
            <>
              <p>{t('auth.deviceIntro')}</p>
              <div className="device-code">{userCode}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="primary" style={{ flex: 1 }} onClick={() => window.sticki.openExternal(verifyUri)}>
                  {t('auth.openPage')}
                </button>
                <button
                  title={t('auth.copyLink')}
                  onClick={() => {
                    navigator.clipboard.writeText(verifyUri)
                    useUiStore.getState().toast(t('auth.linkCopied'))
                  }}
                >
                  🔗
                </button>
                <button
                  title={t('auth.copyCode')}
                  onClick={() => {
                    navigator.clipboard.writeText(userCode)
                    useUiStore.getState().toast(t('auth.linkCopied'))
                  }}
                >
                  📋
                </button>
              </div>
              <p style={{ color: 'var(--text-muted)', textAlign: 'center' }}>{t('auth.waiting')}</p>
            </>
          )}
          {phase === 'error' && (
            <>
              <p style={{ color: 'var(--danger)' }}>{t('auth.error')}</p>
              <p style={{ color: 'var(--text-muted)', fontSize: 12, userSelect: 'text' }}>{error}</p>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>{t('auth.cancel')}</button>
        </div>
      </div>
    </div>
  )
}
