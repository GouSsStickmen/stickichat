import { useEffect } from 'react'
import { useUiStore } from '../store/ui'
import { useSettingsStore, favKey } from '../store/settings'
import { useT } from '../i18n'

/**
 * "Which categories does this emote belong to?" — Alt+right-click, from the picker or from chat.
 *
 * Checkboxes rather than a choice, because an emote belongs to several shelves at once and picking
 * one must not take it off another. It also stars the emote if it was not a favourite yet: filing
 * something implies keeping it, and asking twice would be a formality.
 *
 * Mounted once at the top level. Chat has no picker open when you right-click an emote in a
 * message, and the answer is the same list in both places.
 */
export default function EmoteFolderMenu(): React.JSX.Element | null {
  const t = useT()
  const menu = useUiStore((s) => s.emoteFolderMenu)
  const folders = useSettingsStore((s) => s.favoriteFolders)
  const favorites = useSettingsStore((s) => s.favoriteEmotes)

  useEffect(() => {
    if (!menu) return
    const close = (e: Event): void => {
      if (!(e.target as HTMLElement | null)?.closest?.('.emote-folder-menu')) {
        useUiStore.getState().setEmoteFolderMenu(null)
      }
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') useUiStore.getState().setEmoteFolderMenu(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onEsc)
    }
  }, [menu])

  if (!menu) return null

  const isFav = favorites.some((f) => favKey(f) === menu.key)

  const put = (folderId: string): void => {
    const st = useSettingsStore.getState()
    // filing it implies keeping it — a category of things you have not starred would be a fiction
    if (!st.favoriteEmotes.some((f) => favKey(f) === menu.key)) {
      st.setFavoriteEmotes([...st.favoriteEmotes, menu.emote])
    }
    st.toggleInFolder(folderId, menu.key)
  }

  return (
    <div
      className="emote-folder-menu popover"
      // clamped so a right-click near an edge does not open it off-screen
      style={{
        position: 'fixed',
        left: Math.min(menu.x, window.innerWidth - 220),
        top: Math.min(menu.y, window.innerHeight - 40 - folders.length * 30)
      }}
    >
      <div className="efm-head">
        <img src={menu.emote.url} alt="" />
        <span>{menu.emote.code}</span>
      </div>
      {folders.length === 0 ? (
        <div className="efm-empty">{t('picker.folderNone')}</div>
      ) : (
        folders.map((f) => {
          const inIt = f.keys.includes(menu.key)
          return (
            <button key={f.id} className={inIt ? 'on' : ''} onClick={() => put(f.id)}>
              <span className="efm-box">{inIt ? '☑' : '☐'}</span>
              {f.name}
            </button>
          )
        })
      )}
      {!isFav && folders.length > 0 && <div className="efm-note">{t('picker.folderWillStar')}</div>}
    </div>
  )
}
