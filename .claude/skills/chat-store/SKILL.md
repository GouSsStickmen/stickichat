---
name: chat-store
description: Use before changing store/chat.ts, store/emotes.ts, components/ChatList.tsx or components/MessageView.tsx — the chat hot path. Lists the invariants that are easy to break and slow to notice.
allowed-tools: Read, Edit, Write, Grep, Glob, Bash
---

# The chat hot path

These four files carry the whole message pipeline. Everything here was learned by breaking it.

## store/chat.ts

- **No lookup may scan the message buffer.** `lookupUserColor`, `lookupUserId`, `lookupUserBadges`
  and `isKnownChatter` read `chatterIndex`, a per-channel `Map<login, ChatterInfo>` fed by
  `indexMessages()` from `appendMessages` / `prependMessages` / `seedMessages`. The reason is
  `isKnownChatter`: the tokenizer asks it about **every word of every message**, so a buffer walk
  there is buffer × words × rows. It cost a single 2.3-second task.
  If you add a lookup, add a field to `ChatterInfo` — do not reach for the buffer.
- Dedupe on insert is bounded to `DEDUPE_WINDOW` (400) from the end being appended to. A full
  `Set` of every id, rebuilt per batch per channel, was ~178 ms.
- `dropChannel` must also `chatterIndex.delete(channel)`, or the map outlives the buffer.

## store/emotes.ts

- **`version` is a broadcast, not a counter.** It is a prop on every message, part of the
  tokenized-layout cache key in `MessageView`, and part of `layoutKey` in `ChatList`. One bump =
  full re-render + full re-tokenize + full re-measure of everything on screen.
- Writes go in immediately; the bump is coalesced to once per frame by `bumpVersion()`. Any new
  setter must follow that shape. Never put `version: s.version + 1` back into a `set()`.

## components/ChatList.tsx

- Heights live in a `Map` keyed by **message id**, never by index — the buffer trims from the head.
- Prefix-sum offsets are rebuilt only when the array identity or `geomVersion` changes. Rebuilding
  them inside the scroll handler put an O(n) pass in front of every paint.
- **Never call a state setter synchronously from `onScroll`.** React flushes it immediately and it
  steals the frame the reader is scrolling. Re-slicing is deferred to a `requestAnimationFrame`,
  except on a jump larger than the overscan, where it must be immediate or the screen goes blank.
- `scrollTop` holds whole device pixels. A smooth glide therefore needs its own float accumulator
  (`glidePos`) that is rounded on write; stepping `scrollTop` by less than a pixel does nothing at
  all, which is why the newest message used to stop short of the input.
- The scroll anchor is (topmost visible message id, gap) — not a pixel offset. Anything inserted or
  resized above the viewport must leave that pair untouched.

## components/MessageView.tsx

- Tokenization is cached in `layoutCache`, keyed by message id plus everything that can change how
  the message looks. Adding to that key is cheap to write and expensive to run — every extra term
  is another reason to throw the whole cache away.
- **An inline `style` beats any stylesheet rule.** A highlight tint written inline silently erased
  the bits effect's animated background; that is why the effect branches set `background: undefined`
  instead of relying on CSS specificity.

## Before saying it is done

`npm run typecheck` (both tsconfigs), then the `perf-trace` skill if anything above was touched.
