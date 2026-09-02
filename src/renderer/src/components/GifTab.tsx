import { useState } from 'react'
import { host } from '../lib/platform'
import { useSettingsStore } from '../store/settings'
import { useT } from '../i18n'
import type { GifItem } from '../lib/giphy'

interface Props {
  gifs: GifItem[]
  state: 'idle' | 'loading' | 'error'
  /** without a GIPHY key there is nothing to show, and the tab says so instead of looking broken */
  hasKey: boolean
  onPickGif?: (gif: GifItem) => void
  /** ask for the next page; absent once GIPHY has run out */
  onMore?: () => void
}

/**
 * The GIF half of the picker: trending until something is typed, then search.
 *
 * Two columns of variable-height thumbnails rather than the square grid the emotes use — a GIF is
 * a picture with its own shape, and cropping it to a square is how you lose the joke.
 */
export default function GifTab({ gifs, state, hasKey, onPickGif, onMore }: Props): React.JSX.Element {
  const t = useT()
  const [keyDraft, setKeyDraft] = useState('')

  if (!hasKey) {
    /*
     * The key is pasted here, not hunted for in settings.
     *
     * It lived in the settings panel first, three sections deep next to the other picker options,
     * which is a fine place for a thing you already know exists and a bad one for a thing you are
     * being told about for the first time. This is the moment it is needed, so this is where the
     * box goes; settings keeps its copy for changing it later.
     */
    return (
      <div className="gif-nokey">
        <p>{t('picker.gifNoKey')}</p>
        <div className="gif-nokey-actions">
          <input
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder={t('set.giphyKeyPlaceholder')}
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              const key = keyDraft.trim()
              if (key) useSettingsStore.getState().setSettings({ giphyApiKey: key })
            }}
          />
          <button
            disabled={!keyDraft.trim()}
            onClick={() => useSettingsStore.getState().setSettings({ giphyApiKey: keyDraft.trim() })}
          >
            {t('picker.gifSaveKey')}
          </button>
          <button className="ghost" onClick={() => void host().openUrl('https://developers.giphy.com/dashboard/')}>
            {t('picker.gifGetKey')}
          </button>
        </div>
      </div>
    )
  }

  if (state === 'error') return <div className="picker-empty">{t('picker.gifError')}</div>
  if (state === 'loading' && gifs.length === 0) {
    return <div className="picker-empty">{t('picker.gifLoading')}</div>
  }
  if (gifs.length === 0) return <div className="picker-empty">{t('picker.gifEmpty')}</div>

  return (
    <>
      <div className="gif-grid">
        {gifs.map((g) => (
          <button
            key={g.id}
            className="gif-cell"
            title={g.title}
            // the input keeps focus, exactly as picking an emote does
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={() => onPickGif?.(g)}
          >
            <img src={g.previewUrl} alt={g.title} loading="lazy" width={g.width} height={g.height} />
          </button>
        ))}
      </div>
      {onMore && (
        <button className="gif-more ghost" disabled={state === 'loading'} onClick={onMore}>
          {state === 'loading' ? t('picker.gifLoading') : t('picker.gifMore')}
        </button>
      )}
      {/* GIPHY's terms ask for the mark wherever their results are shown */}
      <div className="gif-attribution">{t('picker.gifPowered')}</div>
    </>
  )
}
