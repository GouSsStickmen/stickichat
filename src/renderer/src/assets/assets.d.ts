/**
 * Asset imports resolve to a URL string at build time. The project does not pull in
 * `vite/client` types (they drag in a lot we don't use), so the handful of asset kinds we
 * actually import are declared here.
 */
declare module '*.mp3' {
  const src: string
  export default src
}
