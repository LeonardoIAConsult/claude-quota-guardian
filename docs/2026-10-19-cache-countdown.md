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

## Out of scope

Changing the badge (stays the quota %), notifications from the extension, publishing the
extension to the Chrome Web Store.
