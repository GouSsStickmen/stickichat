import type { CapacitorConfig } from '@capacitor/cli'

/**
 * The phone build.
 *
 * `webDir` is its own bundle, not the desktop one: the renderer is shared but the entry point is
 * not — the desktop boot brings overlays, extra windows and always-on-top with it, and none of
 * that exists here.
 *
 * `server.androidScheme: 'https'` matters more than it looks. On `http` the WebView treats the app
 * as an insecure origin, and an insecure origin has no `crypto.subtle` — which is exactly what the
 * token encryption needs.
 */
const config: CapacitorConfig = {
  appId: 'com.stickmen.stickichat',
  appName: 'StickiChat',
  webDir: 'dist-mobile',
  /*
   * Capacitor logs every plugin call and its result to logcat. That includes CapacitorHttp
   * responses and Filesystem writes — which is how an OAuth token would end up in a log. 'debug'
   * is the default and means release builds log nothing at all; it is spelled out here so the
   * choice is visible, because the safe half of it is the half that is easy to lose.
   */
  loggingBehavior: 'debug',

  android: {
    // the chat is a dark surface; letting the WebView paint white behind it flashes on every start
    backgroundColor: '#0e0e10'
  },
  server: {
    androidScheme: 'https'
  },
  plugins: {
    Keyboard: {
      // the input sits at the bottom: the web content must move up with the keyboard, not hide
      // under it, and the chat's own scroll anchor keeps its place while it happens
      resize: 'body' as never
    },
    StatusBar: {
      backgroundColor: '#0e0e10',
      style: 'DARK' as never
    }
  }
}

export default config
