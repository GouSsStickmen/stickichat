import { createServer, Server } from 'http'
import { AddressInfo } from 'net'

/**
 * A one-page HTTP server, alive only while a stream player is on screen.
 *
 * It exists for one reason: latency. The bare player.twitch.tv URL plays fine in a webview but
 * tells us nothing about how far behind live it is, and the numbers are not reachable from the
 * outside either. Its page has no React tree on the video element, no player object on window, and
 * `seekable.end` for a live stream is the 2^30 sentinel rather than a time. All measured.
 *
 * Twitch's own Embed SDK does expose it, through getPlaybackStats().hlsLatencyBroadcaster, and the
 * SDK needs a page on a real host to sit in, because the embed checks that `parent` matches the
 * document holding it. So: localhost, an ephemeral port, one page, no routes, no files.
 */
let server: Server | null = null
let port = 0

const PAGE = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
    #p, #p iframe { width: 100%; height: 100%; border: 0; display: block; }
  </style>
</head>
<body>
  <div id="p"></div>
  <script src="https://embed.twitch.tv/embed/v1.js"></script>
  <script>
    var channel = new URLSearchParams(location.search).get('channel') || '';
    var player = new Twitch.Player('p', {
      channel: channel,
      parent: ['localhost'],
      width: '100%',
      height: '100%',
      autoplay: true,
      muted: false
    });
    /*
     * Published for the app to read with executeJavaScript. Broadcaster latency is the number a
     * viewer actually cares about ("am I far behind, should I reload"); the buffer size is kept
     * beside it because a latency that is fine while the buffer is empty still stutters.
     */
    window.__stickiStats = null;
    setInterval(function () {
      try {
        var s = player.getPlaybackStats();
        window.__stickiStats = s
          ? { latency: s.hlsLatencyBroadcaster, buffer: s.bufferSize, drops: s.videoStats && s.videoStats.droppedFrames }
          : null;
      } catch (e) {
        window.__stickiStats = null;
      }
    }, 2000);
  </script>
</body>
</html>`

/**
 * Starts the server on first use and resolves with its port; later calls reuse it.
 *
 * Async because listen() is: asking for the address in the same tick returns null, and a player
 * pointed at port 0 loads nothing at all.
 */
export function playerServerPort(): Promise<number> {
  if (server && port) return Promise.resolve(port)
  return new Promise((resolve) => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(PAGE)
    })
    server.on('error', () => {
      server = null
      port = 0
      resolve(0)
    })
    // port 0 means "any free one", so this cannot collide with the overlay server or anything else
    server.listen(0, '127.0.0.1', () => {
      port = (server?.address() as AddressInfo | null)?.port ?? 0
      resolve(port)
    })
  })
}
