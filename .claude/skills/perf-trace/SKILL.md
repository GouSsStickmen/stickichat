---
name: perf-trace
description: Use when asked to measure performance, explain why the chat scroll stutters or freezes, profile the renderer, or before and after any optimisation. Also use before claiming that a performance change worked.
allowed-tools: Bash, PowerShell, Read, Edit, Write, Glob, Grep
---

# Measuring the renderer

The rule this exists to enforce: **a performance claim without a number before and after is a
guess.** Three separate times in this project a confident-sounding diagnosis was wrong and only
measurement caught it. Measure first, then change one thing, then measure again.

## The probes

`ChatList.tsx` can carry three temporary probes. They are added when hunting and removed before
committing; grep for `TEMP-` to see whether they are currently in the file.

- `TEMP-LONGTASK` — a `PerformanceObserver` on `longtask`. Reports any task over 50 ms.
- `TEMP-JANK` — on wheel input, records frame times for the burst and reports the worst frame, the
  count over 20 ms, and `n` (messages in the buffer at the time).
- `TEMP-EFFECT` — times the chat list's own layout effect and warns over 15 ms.

They write through `lib/diag` to:

```
%APPDATA%\stickichat\logs\stickichat.log
```

Read that file, do not watch the terminal. Filter to `longtask` / `jank` / `listeffect`.

`n` in the jank line is the crucial one. A long task with a **small** buffer means the cost is not
the chat at all — that single fact is what exposed the emote-store `version` churn after two wrong
guesses.

## Procedure

1. `npm run dev` and let the channels finish loading — the first ~60 s after start is when the
   emote and badge sets arrive, and it is a different regime from steady state. Say which one you
   measured.
2. Reproduce the complaint the way the user described it: fast wheel scrolling upward through
   history is the usual case, and it is much harder than sitting at the bottom.
3. Read the log. Record worst frame, count over 20 ms, `n`, and the long-task durations.
4. Change **one** thing.
5. Rebuild, repeat with the same gesture and a comparable `n`. Different `n` means the two runs are
   not comparable.

## Thresholds

- Worst frame over 32 ms during a scroll — a real stutter, the user will see it.
- Any long task over 100 ms — find its owner before doing anything else.
- List layout effect over 15 ms — the list itself is the problem; below that, look elsewhere.

## Attribution

`PerformanceObserver` reports these as `self / unknown / window`, which names nothing. Two ways to
get a real stack:

- **Chrome DevTools MCP against the running Electron renderer.** `npm run dev:debug` opens CDP on
  port 9222; point the MCP at `http://127.0.0.1:9222`. This is the only way to see *which function*
  the 150 ms went into.
- **Bisecting by hand** — comment out a suspect, re-measure. Slow but always available.

## What has already been found

Every cause so far was the same shape: a cheap operation placed inside a loop that multiplied it.

| Cause | Multiplier | Cost |
| --- | --- | --- |
| `isKnownChatter` scanning the buffer | buffer × every word of every message | one 2.3 s task |
| `appendMessages` rebuilding a `Set` of all ids | buffer × every batch × every channel | ~178 ms |
| `version` bumped on every emote-store write | whole screen × ~150 loads at startup | ~150 ms |

When looking for the next one, ask what the multiplier is, not what looks slow.
