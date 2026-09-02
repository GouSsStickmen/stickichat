import { useState } from 'react'
import { useSettingsStore } from '../store/settings'
import { useUiStore } from '../store/ui'
import { host } from '../lib/platform'
import { useT } from '../i18n'

/**
 * The gate in front of native GIF sending.
 *
 * Deliberately a wall of text and a checkbox rather than a toggle. What is behind it is a
 * twitch.tv session cookie — not a scoped token like the ones the accounts use, but the whole
 * account — spent on an endpoint Twitch does not publish. Nobody should arrive here by flicking
 * something; they should arrive having read what it costs and said so.
 *
 * The login itself happens in Twitch's own page in its own window. The app never sees the
 * password, never asks for it, and stores only what the login leaves in the cookie jar.
 */
export default function GifNativeConsent({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useT()
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)

  const connect = async (): Promise<void> => {
    setBusy(true)
    try {
      const token = await window.sticki.twitchWebLogin()
      if (!token) {
        setBusy(false)
        return
      }
      const enc = await host().encrypt(token)
      useSettingsStore.getState().setSettings({ gifSendMode: 'native', gifSessionEnc: enc })
      useUiStore.getState().toast(t('gif.connected'), 'ok')
      onClose()
    } catch {
      useUiStore.getState().toast(t('gif.connectFailed'), 'error')
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal small gif-consent">
        <div className="modal-header">
          {t('gif.consentTitle')}
          <div className="spacer" />
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p className="gif-consent-lead">{t('gif.consentLead')}</p>
          <ul className="gif-consent-list">
            <li>{t('gif.risk1')}</li>
            <li>{t('gif.risk2')}</li>
            <li>{t('gif.risk3')}</li>
            <li>{t('gif.risk4')}</li>
          </ul>
          <p className="gif-consent-note">{t('gif.consentNote')}</p>
          <label className="gif-consent-agree">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>{t('gif.consentAgree')}</span>
          </label>
          <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
            <button className="ghost" style={{ flex: 1 }} onClick={onClose}>
              {t('misc.cancel')}
            </button>
            <button
              className="danger"
              style={{ flex: 2 }}
              disabled={!agreed || busy}
              onClick={() => void connect()}
            >
              {busy ? t('gif.connecting') : t('gif.connect')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
