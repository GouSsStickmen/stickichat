import { useEffect } from 'react'
import { loadGlobalEmotes } from '../services/emoteService'
import WhisperPanel from './WhisperPanel'
import Toasts from './Toasts'

/**
 * Standalone whispers window (#whispers). History comes from localStorage (shared across
 * windows); live whispers arrive via the main window's EventSub and reach us through the
 * cross-window 'storage' sync in the whispers store.
 */
export default function WhispersWindow(): React.JSX.Element {
  useEffect(() => {
    document.title = 'StickiChat — Whispers'
    // global 3rd-party emotes so whisper texts render them inline
    loadGlobalEmotes()
  }, [])

  return (
    <div className="app">
      <WhisperPanel standalone onClose={() => window.close()} />
      <Toasts />
    </div>
  )
}
