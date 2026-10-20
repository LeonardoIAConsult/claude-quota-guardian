import type { EngineInterface } from 'claude-code'

import type { Shared } from '../types'

// The session's own answers that Guardian's hooks write into state.json
// (lib/threshold-check.js, hooks/statusline.js): when the conversation last
// used the cache and whether it runs on a subscription. The status line and
// the browser extension compute the same two things from the same fields
// (lib/cache-clock.js sessionLastActivity and the subscription answer), so all
// three show the same minutes.

// Guardian's folder for a project: the first 12 hex digits of the SHA-1 of its
// working directory (lib/paths.js projectHash).
export async function projectHash(cwd: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(cwd))

  return [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12)
}

// Null when Guardian has not written this session's state yet (before its
// first hook, right after /clear) or the folder holds another session's.
export async function readShared($: EngineInterface, root: string | undefined, cwd: string | undefined): Promise<Shared | null> {
  if (root === undefined || cwd === undefined) {
    return null
  }

  try {
    const sessionId = await $.session.id()
    const state = JSON.parse(await $.fs.read(`${root}/${await projectHash(cwd)}/state.json`))

    if (state?.sessionId !== sessionId) {
      return null
    }

    // the newer of what the hooks stored and the transcript's mtime now
    const stored = Date.parse(state.lastActivityAt)
    let transcript = 0

    if (typeof state.transcriptPath === 'string' && state.transcriptPath !== '') {
      try {
        transcript = (await $.fs.stat(state.transcriptPath)).mtimeMs
      } catch {
        transcript = 0
      }
    }

    const last = Math.max(Number.isNaN(stored) ? 0 : stored, transcript)
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

// The bar's subscription answer: an API setting in the session's environment
// always means per-token; otherwise the engine's own rate limits (only
// subscriptions get them) or Guardian's answer, in that order.
export function subscriptionOf(shared: Shared | null, engineRateLimits: boolean): boolean {
  if (shared?.from === 'api-env') {
    return false
  }

  return engineRateLimits || shared?.subscription === true
}
