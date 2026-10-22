import type { EngineInterface } from 'claude-code'

import type { Shared } from '../types'

// The session's own answers that Guardian's hooks write into state.json
// (lib/threshold-check.js, hooks/statusline.js): when the conversation last
// used the cache and whether it runs on a subscription. The status line and
// the browser extension compute the same two things from the same fields
// (lib/cache-clock.js sessionLastActivity, sessionView and sessionSubscription),
// so all three show the same minutes.

// The working directory as Node's path.resolve spells an absolute one, which
// is what lib/paths.js hashes: Windows separators, no trailing separator.
export function resolvedCwd(cwd: string): string {
  const windows = /^[A-Za-z]:/.test(cwd)
  const sep = windows ? String.fromCharCode(92) : '/'
  const unified = windows ? cwd.split('/').join(sep) : cwd
  const root = windows ? unified.slice(0, 3) : '/'
  let out = unified

  while (out.length > root.length && out.endsWith(sep)) {
    out = out.slice(0, -1)
  }

  return out
}

// Guardian's folder for a project: the first 12 hex digits of the SHA-1 of its
// resolved working directory (lib/paths.js projectHash).
export async function projectHash(cwd: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(resolvedCwd(cwd)))

  return [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12)
}

const hashes = new Map<string, string>()

// Guardian's folder for the session's working directory as it is NOW: the
// hooks and /continuity-checkpoint write under the current cwd, which can move
// during a session. The hash is computed once per directory.
export async function currentFolder($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  const known = hashes.get(cwd)

  if (known !== undefined) {
    return known
  }

  const hash = await projectHash(cwd)
  hashes.set(cwd, hash)

  return hash
}

// The state.json fields that are THIS session's: the top-level ones when it
// wrote last, else its entry in the per-session map (two sessions in one
// folder share the file). lib/cache-clock.js sessionView mirrors it: change
// both together. Null when Guardian has nothing for the session.
export function sessionView(state: any, sessionId: string): any {
  if (state?.sessionId === sessionId) {
    return state
  }

  const entry = state?.cacheSessions?.[sessionId]

  if (entry === null || typeof entry !== 'object') {
    return null
  }

  return {
    sessionId,
    transcriptPath: entry.transcriptPath,
    lastActivityAt: entry.lastActivityAt,
    subscription: entry.subscription,
    subscriptionSessions: state.subscriptionSessions,
  }
}

// Null when Guardian has not written this session's state yet (before its
// first hook, right after /clear).
export async function readShared($: EngineInterface, root: string | undefined): Promise<Shared | null> {
  if (root === undefined) {
    return null
  }

  try {
    const folder = await currentFolder($)
    const sessionId = await $.session.id()
    const state = sessionView(JSON.parse(await $.fs.read(`${root}/${folder}/state.json`)), sessionId)

    if (state === null) {
      return null
    }

    // what a hook stored; the transcript's mtime only when nothing is stored
    // (a state from before hooks stamped it)
    const stored = Date.parse(state.lastActivityAt)
    let last = Number.isNaN(stored) ? 0 : stored

    if (last <= 0 && typeof state.transcriptPath === 'string' && state.transcriptPath !== '') {
      try {
        last = (await $.fs.stat(state.transcriptPath)).mtimeMs
      } catch {
        last = 0
      }
    }

    const proven = Array.isArray(state.subscriptionSessions) && state.subscriptionSessions.includes(sessionId)

    return {
      lastActivity: last > 0 ? last : null,
      subscription: proven ? true : typeof state.subscription === 'boolean' ? state.subscription : null,
      from: proven ? 'rate_limits' : typeof state.subscriptionFrom === 'string' ? state.subscriptionFrom : null,
    }
  } catch {
    return null
  }
}

// The engine reported rate limits for this session (only subscriptions get
// them): leave Guardian a note, so the hooks record the proof in state.json
// even when another status line owns the slot and the extension agrees with
// the bar. A file of its own (lib/paths.js rateLimitsProofPath), never a
// write into state.json, which the hooks rewrite whole. Returns the
// "folder:session" key it wrote for (the caller writes once per key: a cd
// mid-session lands in another folder, which needs its own note), or null.
export async function recordRateLimitsProof(
  $: EngineInterface,
  root: string | undefined,
  sessionId: string,
): Promise<string | null> {
  if (root === undefined || sessionId === '') {
    return null
  }

  try {
    const folder = await currentFolder($)
    await $.fs.write(`${root}/${folder}/${proofNoteName(sessionId)}`, JSON.stringify({ sessionId }))

    return `${folder}:${sessionId}`
  } catch {
    return null
  }
}

// lib/paths.js rateLimitsProofPath spells the same name: change both together
// (a test pins them to the same output).
export function proofNoteName(sessionId: string): string {
  return `rate-limits-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100)}.json`
}

// lib/cache-clock.js sessionSubscription: rate limits proof first (the
// engine's own reading, or one recorded for this session), then the
// session's stored answer.
export function subscriptionOf(shared: Shared | null, engineRateLimits: boolean): boolean {
  return engineRateLimits || shared?.subscription === true
}
