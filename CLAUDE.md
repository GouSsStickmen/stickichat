# StickiChat

Twitch chat client. Electron 33 + React 18 + Zustand 5 + TypeScript 5.7, bundled by electron-vite.
Owner GouS_Stickmen, GPL-3.0, Windows only for now.

## Layout

- `src/main/` — main process: window/IPC (`index.ts`, `ipc.ts`), settings on disk (`storage.ts`),
  the OBS overlay HTTP server (`overlayServer.ts`), auto-update (`updater.ts`), the diag log
  (`diagnostics.ts`).
- `src/renderer/src/store/` — Zustand stores. `chat.ts` is the message ring buffer, `emotes.ts` the
  emote/badge tables, `settings.ts` everything the user can configure.
- `src/renderer/src/components/` — UI. `ChatList.tsx` is a hand-written virtualized list;
  `MessageView.tsx` tokenizes and renders one message.
- `src/renderer/src/services/` — the live wiring: IRC, EventSub, PubSub, Helix.
- `src/renderer/src/lib/` — pure helpers, one concern per file.
- `src/renderer/src/styles/global.css` — every theme variable, animation and effect.

## Rules

1. **All user-facing text is Ukrainian.** Code, comments and commit messages are English.
2. **Never claim a performance improvement without a measurement before and after.** Use the
   `perf-trace` skill. "Should be faster" is not a result.
3. **The chat list is the hot path.** Before touching `ChatList.tsx`, `chat.ts`, `emotes.ts` or
   `MessageView.tsx`, read the `chat-store` skill — it lists the invariants that are easy to break
   and expensive to notice.
4. **Only ever run the dev app** from `node_modules/electron/dist/electron.exe` (`npm run dev`).
   The installed build in `%LOCALAPPDATA%\Programs\StickiChat` is the user's; launching it wastes
   time debugging stale code.
5. **Live testing happens only on the `GouS_Stickmen` channel.** Other channels may be read
   (`theburntpeanut` has heavy traffic and is good for scroll work) but never written to.
6. `npm run typecheck` covers both tsconfigs — web and node. Run it before saying a change is done.

## Release

Bump `version` in `package.json`, add the entry to `src/renderer/src/changelog.ts`, commit as
`0.5.x: short summary`, then `npm run release` (builds and publishes to GitHub). Current: 0.5.11.
