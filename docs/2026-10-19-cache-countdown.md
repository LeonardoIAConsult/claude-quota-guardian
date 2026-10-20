# Cache countdown — spec + plan (2026-10-19)

## Why

Claude Code caches the conversation prefix for a while after each request. While that cache is
warm, the next message re-reads the whole context at a fraction of the price. Once it expires, the
next message pays full price for every token of context again. Nothing tells you when that happens.
Guardian already watches the quota; this adds the clock that decides how much each message costs.

## What ships

| Surface | What it shows | Where |
|---|---|---|
| A. Status line | `cache 42m` appended to the existing line (`cache 3m!` near expiry, `cache expired`) | `hooks/statusline.js` |
| B. Bar above the prompt | live countdown, context size, 5h / week, a **Handoff** button that runs `/continuity-checkpoint`, then **Clear and continue** | `bar/` (separate plugin, hooks module) |
| C. Browser extension | one row per recent Claude Code project with the minutes left | `extension/` + local native-messaging host `native-host/` |

All three read one rule, `lib/cache-clock.js` (B carries a copy in TypeScript: hooks modules cannot
`require` Node code):

- **Last activity** = the transcript file's modification time (every message written to it is a
  request that refreshed the cache). Guardian also stores it in `state.json` as `lastActivityAt`.
- **TTL** = `config.cache.ttlMinutes` when set; otherwise 60 minutes when the session reports
  `rate_limits` (Pro/Max subscription) and 5 minutes when it does not (API key). It is an estimate
  and the docs say so.
- **Warn** when `cache.warnMinutes` (default 5) or fewer remain.

## Exit criteria (the oracle)

1. `node --test` green on the whole suite, with new tests for: the clock rule, the status line
   segment, `lastActivityAt` surviving the state rewrite, the native host protocol and its output
   shape, installer/uninstaller registration of the host and the bar.
2. `claude plugin validate bar` clean and `tsc -p bar` clean.
3. Bar seen working in a real interactive session (Leonardo's terminal).
4. Extension popup loaded in a real Chrome showing the cache rows from the real host.
5. The native host only answers its own extension (`allowed_origins`), only reads Guardian's own
   `state.json` files, and returns no paths, no file contents and no transcript text.
6. README (ES + EN) and landing (ES + EN) explain the new benefit and how Guardian saves tokens,
   with no invented numbers.

## Fixed during review (code review, 2026-10-19)

- "Limpiar y seguir" only appears, and `/clear` only runs, once a `pending.json` written since the
  handoff is unconsumed and names its checkpoint (`bar/hooks/register.test.tsx` covers it).
- `/continuity-checkpoint` replaces a consumed leftover `pending.json` instead of updating it.
- A manual checkpoint (`triggeredBy: "manual"`) never blocks tools, and never stands in for a real
  cutoff: hitting the quota on top of one still writes the blocking pending.
- The status line writes `state.json` only when the rate limits changed (idle refresh kept
  `updatedAt` fresh and the watcher never ramped down).
- The native host also reads an OAuth login on disk as a subscription signal.
- `refreshInterval: 0` is kept; the bar is not added twice when installed from the marketplace;
  Windows paths compare case-insensitively.

## Backlog

- 1.1.1 review (Verify, code review, Sentinel, external review), not blocking:
  - ~~Without Guardian's status line nobody records the rate_limits proof: a Max session with an
    exported-but-declined `ANTHROPIC_API_KEY` shows 60 in the bar (engine rate limits) and 5 in
    the extension (stored `api-env`). Early, never late. Fix: let the bar record the proof.~~ done in 1.1.2 (rate-limits note)
  - No test pins the bar's `generation` guard (tick vs `/clear`), the legacy cleanup outside
    the `try`, or the `samePath(legacy, hostDir())` guard in `installNativeHost`.
  - `performCheck` rewrites the whole `state.json` and drops the status line's
    `rateLimitByModel` until its next refresh (since adbf6cd; `subscriptionSessions` survives),
    and a status-line write during a slow `performCheck` is lost until the next refresh.
  - `apiKeyHelper` in settings is not detected as per-token (no env var to see).
  - 17+ sessions rotating in one folder evict each other from the proof list on every refresh.
  - The bar takes max(own turn, shared); status line and host do not: under a minute apart at
    the rounding edge.
  - ~~External review round 2 (GO): no test pins `readShared` following the current cwd (only the
    checkpoint path is pinned), and none pins the live-reading branch of `usageReading`
    (breaking it shows 5 min early on a Keychain login, never late).~~ both pinned in 1.1.2
  - Not yet seen in a real session: `$.session.cwd()` changing after a `cd`. (1.1.2: the bar's folder hash matched the hooks' in a real `claude -p` session.)

- ~~One shared "last activity" and "subscription" signal for the three surfaces~~ done in 1.1.1 (order guardian-2026-10-19-001) (today the bar uses
  the end of the main turn, the status line and the host the transcript mtime); they can differ
  by the length of the last answer.
- A repo moved after install leaves its old `bar/` path in `CLAUDE_CODE_PLUGIN_DIRS`; the
  uninstaller run from the new path does not remove it.
- External review (2026-10-19), not blocking:
  - `freshCheckpoint` in the bar accepts a fresh pending from any project, not only the
    current one (narrow race, not reproduced).
  - Hitting the quota on top of a manual checkpoint writes the blocking pending with
    `checkpointFile: null`; the manual checkpoint stays on disk without a reference, so the
    agent writes a new one (by design: the cutoff checkpoint is the newer one).
  - `bin/uninstall.js` `run()` wiring of `uninstallBar` has no test (the function does).
  - `bar/tsconfig.json` extends the engine-written types, so `tsc -p bar` fails on a clean
    clone until the bar has loaded once.
  - ~~The host treats an OAuth login on disk as a subscription, so an API-key session on a
    machine that also has an OAuth login shows 60 min.~~ done in 1.1.1 (API env wins)

- External review, round 2 (GO), not blocking:
  - The report test does not catch, on its own, a `hostDir()` moved back inside
    `session-continuity` (the legacy cleanup hides it; the `installNativeHost` test catches it).
    Add `assert.ok(!host.hostDir().startsWith(paths.continuityRoot()))`. Done in 1.1.1.
  - `installNativeHost` would delete the launcher it just wrote if `hostDir()` ever equalled
    `legacyHostDir()`; guard with `if (legacy !== hostDir())`. Done in 1.1.1.
  - ~~No test that the uninstaller removes the legacy folder.~~ done in 1.1.1
  - ~~The legacy cleanup sits inside the `try`: a locked `.cmd` would report the host install
    as failed although the registry is already right.~~ done in 1.1.1

## Fixed after external review (2026-10-19)

- The native host's launcher and manifest live in `~/.claude/quota-guardian-native-host`, outside
  `session-continuity` (every folder there is read as a project: it showed up as a phantom
  "native-host" project in `scripts/report.js`). Install and uninstall remove the old folder.

## Out of scope

Changing the badge (stays the quota %), notifications from the extension, publishing the
extension to the Chrome Web Store.
