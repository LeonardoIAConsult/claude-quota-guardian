# Changelog

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
