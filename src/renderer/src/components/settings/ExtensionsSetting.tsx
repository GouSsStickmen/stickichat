import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../store/settings'
import { useT } from '../../i18n'
import { CloseIcon } from '../Icons'

/**
 * Chrome extensions for the stream player.
 *
 * Electron can load extensions, with two conditions that decide everything about how this looks:
 * they must be UNPACKED folders, because there is no Web Store and no .crx installer, and only a
 * subset of the Chrome APIs exists, so an extension either works or quietly does nothing. That is
 * why this reports what actually loaded and what was refused instead of just listing paths: an
 * extension that failed silently is indistinguishable from one that has nothing to do here.
 *
 * They run in the player's own session, which is the only place a Twitch page is open.
 */
export default function ExtensionsSetting(): React.JSX.Element {
  const t = useT()
  const paths = useSettingsStore((s) => s.settings.playerExtensions)
  const [state, setState] = useState<{
    loaded: { name: string; version: string; path: string }[]
    failed: { path: string; error: string }[]
  } | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async (list: string[]): Promise<void> => {
    if (list.length === 0) {
      setState({ loaded: [], failed: [] })
      return
    }
    setBusy(true)
    setState(await window.sticki.extLoad(list))
    setBusy(false)
  }

  useEffect(() => {
    void refresh(paths)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths.join('|')])

  const add = async (): Promise<void> => {
    const dir = await window.sticki.extPick()
    if (!dir) return
    const st = useSettingsStore.getState()
    if (st.settings.playerExtensions.includes(dir)) return
    st.setSettings({ playerExtensions: [...st.settings.playerExtensions, dir] })
  }

  const remove = (path: string): void => {
    void window.sticki.extRemove(path)
    const st = useSettingsStore.getState()
    st.setSettings({
      playerExtensions: st.settings.playerExtensions.filter((p) => p !== path)
    })
  }

  return (
    <>
      <div className="set-group-title">{t('ext.title')}</div>
      <p className="hint" style={{ color: 'var(--text-faint)', marginTop: 0 }}>
        {t('ext.hint')}
      </p>
      <ol className="gif-steps">
        <li>{t('ext.step1')}</li>
        <li>{t('ext.step2')}</li>
        <li>{t('ext.step3')}</li>
      </ol>
      <div className="set-row">
        <button className="primary" disabled={busy} onClick={() => void add()}>
          {t('ext.add')}
        </button>
      </div>
      {paths.length > 0 && (
        <div className="ext-list">
          {paths.map((p) => {
            const ok = state?.loaded.find((x) => x.path === p)
            const bad = state?.failed.find((x) => x.path === p)
            return (
              <div key={p} className="ext-row">
                <div className="ext-main">
                  <span className="ext-name">
                    {ok ? `${ok.name} ${ok.version}` : (p.split(/[\\/]/).pop() ?? p)}
                  </span>
                  <span className={`ext-state ${ok ? 'ok' : 'bad'}`}>
                    {ok ? t('ext.loaded') : bad ? bad.error : t('ext.pending')}
                  </span>
                  <span className="ext-path" title={p}>
                    {p}
                  </span>
                </div>
                <button className="ghost" title={t('misc.close')} onClick={() => remove(p)}>
                  <CloseIcon size={12} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
