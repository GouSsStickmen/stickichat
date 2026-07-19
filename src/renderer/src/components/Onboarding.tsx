import { useState } from 'react'
import { useT } from '../i18n'
import { useSettingsStore } from '../store/settings'
import { useAccountsStore } from '../store/accounts'
import DeviceAuthModal from './DeviceAuthModal'

export default function Onboarding({ onDone }: { onDone: () => void }): React.JSX.Element {
  const t = useT()
  const clientId = useSettingsStore((s) => s.clientId)
  const setClientId = useSettingsStore((s) => s.setClientId)
  const setSettings = useSettingsStore((s) => s.setSettings)
  const language = useSettingsStore((s) => s.settings.language)
  const accounts = useAccountsStore((s) => s.accounts)
  const [step, setStep] = useState(clientId ? 2 : 1)
  const [idInput, setIdInput] = useState(clientId)
  const [authOpen, setAuthOpen] = useState(false)

  return (
    <div className="onboarding">
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
          <div>
            <h1>{t('onb.welcome')}</h1>
            <div className="sub">{t('onb.intro')}</div>
          </div>
          <select
            value={language}
            onChange={(e) => setSettings({ language: e.target.value as 'uk' | 'en' })}
          >
            <option value="uk">Українська</option>
            <option value="en">English</option>
          </select>
        </div>

        {step === 1 && (
          <>
            <h3>{t('onb.step1.title')}</h3>
            <p style={{ color: 'var(--text-muted)' }}>{t('onb.step1.text')}</p>
            <ol>
              <li>{t('onb.step1.li1')}</li>
              <li>{t('onb.step1.li2')}</li>
              <li>{t('onb.step1.li3')}</li>
              <li>
                <b>{t('onb.step1.li4')}</b>
              </li>
              <li>{t('onb.step1.li5')}</li>
            </ol>
            <button
              onClick={() => window.sticki.openExternal('https://dev.twitch.tv/console/apps/create')}
            >
              {t('onb.openConsole')}
            </button>
            <div className="row">
              <input
                placeholder={t('onb.clientId.placeholder')}
                value={idInput}
                onChange={(e) => setIdInput(e.target.value.trim())}
                spellCheck={false}
              />
              <button
                className="primary"
                disabled={idInput.length < 10}
                onClick={() => {
                  setClientId(idInput)
                  setStep(2)
                }}
              >
                {t('onb.continue')}
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h3>{t('onb.step2.title')}</h3>
            <p style={{ color: 'var(--text-muted)' }}>{t('onb.step2.text')}</p>
            {accounts.map((a) => (
              <div key={a.id} className="account-row">
                {a.avatarUrl && <img src={a.avatarUrl} alt="" />}
                <b>{a.displayName}</b>
              </div>
            ))}
            <div className="row">
              <button onClick={() => setAuthOpen(true)}>{t('auth.addAccount')}</button>
              <div style={{ flex: 1 }} />
              <button className="primary" onClick={onDone}>
                {t('onb.done')}
              </button>
            </div>
          </>
        )}
      </div>
      {authOpen && <DeviceAuthModal onClose={() => setAuthOpen(false)} />}
    </div>
  )
}
