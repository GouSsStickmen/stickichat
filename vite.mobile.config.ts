import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

/**
 * The phone bundle.
 *
 * Separate from electron-vite's renderer build because the two differ in exactly two ways that
 * matter: the entry point (no desktop boot) and the base path (a WebView serves from the root of
 * its own scheme, not from a file path). Everything under `src/renderer/src` is shared as-is.
 *
 * `host: true` on the dev server is what makes live reload on a real phone possible — the device
 * pulls the UI from this machine over the LAN, so a change is visible without a rebuild.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/mobile'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      // the shared code imports as if it were still inside the renderer tree
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  build: {
    outDir: resolve(__dirname, 'dist-mobile'),
    emptyOutDir: true,
    // a phone WebView is Chromium; there is no older target to serve here
    target: 'es2022'
  },
  server: {
    host: true,
    port: 5174,
    strictPort: true
  }
})
