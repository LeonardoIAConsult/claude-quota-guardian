# Changelog

## 1.1.1 — 2026-10-19

### Fixed
- The status line, the bar and the extension now show the same cache minutes for the same
  session: each session has one `lastActivityAt` and one `subscription` answer in its
  `state.json`, and all three read them.
- Subscription proof from rate_limits is kept per session in a short list, so two sessions
  sharing a folder never make the idle status line rewrite state.json; a usage reading counts
  as an OAuth login (macOS keeps the token in the Keychain, not in a file).
- An API-key session on a machine that also has an OAuth login shows 5 min, not 60
  (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or Bedrock/Vertex/Foundry switches mean per-token).
- After `/clear` or `/resume` the bar forgets the previous conversation's countdown (no
  `session.start` fires for them; the bar now listens to `session.end`).
- A bar tick that outlives its session no longer leaves an unhandled rejection.
- Installing the browser bridge no longer reports failure when only the cleanup of the old
  folder fails, and never deletes the launcher it just wrote.

## 1.1.0 — 2026-10-19

### Added
- **Prompt-cache countdown.** Guardian estimates how long the conversation cache has left
  (60 min on a Pro/Max subscription, 5 min on an API key, or `cache.ttlMinutes`) and shows it in
  three places:
  - the status line (`cache 42m`, `cache 3m!`, `cache expired`), refreshed every 30 s;
  - a bar above the prompt (`bar/`, plugin `quota-guardian-bar`) with context size, 5h and week,
    a **Traspaso** button that runs `/continuity-checkpoint` and then **Limpiar y seguir**;
  - the browser extension (1.1), one row per Claude Code session of the last 24 h, through a
    read-only local native-messaging bridge (`native-host/`) that only the extension can start.
- `bin/install.js` turns on the bar and registers the bridge for Chrome, Edge, Brave and
  Chromium; `bin/uninstall.js` removes both.

### Changed
- Plugins renamed `quota-guardian` and `quota-guardian-bar`: Claude Code reserves names that
  start with `claude-`. Earlier plugin installs: `/plugin uninstall claude-quota-guardian@claude-quota-guardian`.
- The extension pins its ID (`key` in the manifest); remove 1.0 and load the folder again.
- A manual checkpoint (`/continuity-checkpoint` by hand, or Traspaso) no longer blocks tools,
  and never stands in for a real cutoff.
- `/continuity-checkpoint` replaces a consumed leftover `pending.json` instead of updating it,
  so the next session really loads the new checkpoint.
- The status line rewrites `state.json` only when the rate limits change.

Details and backlog: [docs/2026-10-19-cache-countdown.md](docs/2026-10-19-cache-countdown.md).
