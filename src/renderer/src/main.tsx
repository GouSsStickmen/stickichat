import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'

/**
 * Renderer failures go into the same log as everything else. Without this a crash here left
 * nothing behind but a blank window — the user could describe the symptom and nothing else.
 */
window.addEventListener('error', (e) => {
  // "ResizeObserver loop completed with undelivered notifications" is a Chromium notice with
  // no stack, no file and no line, and it fires constantly in a list that relayouts all the
  // time. Forwarding it cost an IPC hop per occurrence and drowned every real error in the
  // file — a user's whole report came back as nothing but this. The main process counts them.
  if (/ResizeObserver loop/i.test(e.message)) return
  void window.sticki?.diagLog?.(
    'error',
    'renderer',
    `${e.message} @ ${e.filename?.split('/').pop() ?? '?'}:${e.lineno}
${e.error?.stack ?? ''}`
  )
})
window.addEventListener('unhandledrejection', (e) => {
  void window.sticki?.diagLog?.('error', 'renderer', `unhandled rejection: ${String(e.reason)}`)
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
