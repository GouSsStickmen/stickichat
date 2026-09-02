import { host } from '../lib/platform'
import { useUiStore } from '../store/ui'
import { useT } from '../i18n'
import type { GifItem } from '../lib/giphy'

interface Props {
  gifs: GifItem[]
  state: 'idle' | 'loading' | 'error'
  /** without a GIPHY key there is nothing to show, and the tab says so instead of looking broken */
  hasKey: boolean
  onPickGif?: (gif: GifItem) => void
  onClose: () => void
}

/**
 * The GIF half of the picker: trending until something is typed, then search.
 *
 * Two columns of variable-height thumbnails rather than the square grid the emotes use — a GIF is
 * a picture with its own shape, and cropping it to a square is how you lose the joke.
 */
export default function GifTab({ gifs, state, hasKey, onPickGif, onClose }: Props): React.JSX.Element {
  const t = useT()

  if (!hasKey) {
    return (
      <div className="gif-nokey">
        <p>{t('picker.gifNoKey')}</p>
        <div className="gif-nokey-actions">
          <button onClick={() => void host().openUrl('https://developers.giphy.com/dashboard/')}>
            {t('picker.gifGetKey')}
          </button>
          <button
            className="ghost"
            onClick={() => {
              useUiStore.getState().setSettingsSection('chat')
              useUiStore.getState().setSettingsOpen(true)
              onClose()
            }}
          >
            {t('picker.gifOpenSettings')}
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
      {/* GIPHY's terms ask for the mark wherever their results are shown */}
      <div className="gif-attribution">{t('picker.gifPowered')}</div>
    </>
  )
}
