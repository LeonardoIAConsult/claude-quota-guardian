import type { EngineInterface } from 'claude-code'

import type { Shared } from '../types'

// The session's own answers that Guardian's hooks write into state.json
// (lib/threshold-check.js, hooks/statusline.js): when the conversation last
// used the cache (lastActivityAt, the transcript's mtime) and whether it runs
// on a subscription. The status line and the browser extension read the same
// two fields, so all three show the same minutes.

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
    const state = JSON.parse(await $.fs.read(`${root}/${await projectHash(cwd)}/state.json`))

    if (state?.sessionId !== (await $.session.id())) {
      return null
    }

    const last = Date.parse(state.lastActivityAt)

    return {
      lastActivity: Number.isNaN(last) ? null : last,
      subscription: typeof state.subscription === 'boolean' ? state.subscription : null,
    }
  } catch {
    return null
  }
}
