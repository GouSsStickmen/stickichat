/**
 * Run the project typecheck, but only when TypeScript actually changed since the last clean run.
 *
 * This is meant to be wired to a Stop hook, so it runs once when the agent finishes rather than
 * after every edit — a full check of both tsconfigs takes about five seconds, and paying that per
 * edit would cost more waiting than it saves. The stamp file makes the common case (a question, a
 * doc change, a CSS tweak) free.
 *
 * Exit 0 — nothing to do, or the check passed.
 * Exit 2 — type errors; the output goes to stderr, which is what the agent is shown.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const stamp = join(root, 'node_modules', '.cache', 'typecheck-stamp')

/** newest mtime among the sources tsc would look at */
function newestSource(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSource(full))
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      newest = Math.max(newest, statSync(full).mtimeMs)
    }
  }
  return newest
}

let stampedAt = 0
try {
  stampedAt = statSync(stamp).mtimeMs
} catch {
  // no stamp yet — first run always checks
}

if (newestSource(join(root, 'src')) <= stampedAt) process.exit(0)

const res = spawnSync('npm', ['run', 'typecheck'], {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32'
})

if (res.status === 0) {
  mkdirSync(dirname(stamp), { recursive: true })
  writeFileSync(stamp, '')
  const now = new Date()
  utimesSync(stamp, now, now)
  process.exit(0)
}

process.stderr.write(`Typecheck failed:\n${res.stdout ?? ''}${res.stderr ?? ''}`)
process.exit(2)
