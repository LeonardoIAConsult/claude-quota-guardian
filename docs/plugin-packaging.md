# Guardian as a Claude Code plugin

Guardian ships **two install paths** from the same repo:

1. **Standalone** (full feature set) — `node bin/install.js`. Merges hooks into your
   `settings.json`, claims the `statusLine`, and registers the **background watcher**
   (the "your quota reset, ready to continue" notifier that runs with Claude closed).
2. **Plugin** (1-command, in-session core) — via this repo's own marketplace. Delivers
   the core loop (detect → block → checkpoint → auto-resume). See the trade-off below.

## Install as a plugin

```
/plugin install quota-guardian --marketplace LeonardoIAConsult/claude-quota-guardian
/plugin install quota-guardian-bar --marketplace LeonardoIAConsult/claude-quota-guardian
```

The first loads the six hooks and the `/continuity-checkpoint` command; the second (optional) adds the cache-countdown bar above the prompt (`bar/`, a hooks module). One-step install needs Claude Code 2.1.275 or later.

**Why the names changed (v1.1).** Claude Code reserves plugin names that start with `claude-` for Anthropic, and `claude plugin validate` rejects `claude-quota-guardian`. The plugins are now `quota-guardian` and `quota-guardian-bar`; the marketplace keeps its name. Earlier installs: `/plugin uninstall claude-quota-guardian@claude-quota-guardian`, then the lines above.

## Files that make it a plugin (additive; never touch the standalone installer)

- `.claude-plugin/plugin.json` — plugin manifest (name, description, version, author, homepage, repo, MIT).
- `.claude-plugin/marketplace.json` — makes this repo its own marketplace (`source: "./"`), so anyone can `marketplace add` + `install` in two commands. Validated with `claude plugin validate .` (✔ passed).
- `hooks/hooks.json` — the six hooks, path-portable via `${CLAUDE_PLUGIN_ROOT}`:
  - `PreToolUse *` → `hooks/enforce-checkpoint.js`
  - `PostToolUse *` → `hooks/check-usage.js`
  - `Stop *` → `hooks/heartbeat-stop.js`
  - `SessionStart *` → `hooks/resume-context.js`
  - `UserPromptSubmit *` → `hooks/prompt-submit.js` (stamps the cache activity; never blocks)
  - `SessionEnd *` → `hooks/session-end.js` (marks the session ended; never blocks)
- `commands/` (already present) → exposed namespaced: `/quota-guardian:continuity-checkpoint` (the short `/continuity-checkpoint` also resolves when unambiguous).

## Known trade-offs (plugin vs standalone)

1. **Background watcher is standalone-only.** The "quota reset → ready to continue"
   notifier needs an out-of-session scheduler (Task Scheduler / launchd / cron) that
   `bin/install.js` sets up. A plugin runs only *during* a session, so the plugin
   delivers the core loop; the reset notifier stays an extra of the standalone install.
2. **statusLine.** Plugins can't claim the main `statusLine` slot. Not needed for
   blocking — the real quota comes from the OAuth `usageApi` (session/weekly/per-model),
   which works regardless.
3. **Command name.** As a plugin the command is namespaced
   `/quota-guardian:continuity-checkpoint`; the short name resolves too.

## Publishing to the community directory (optional, public)

The curated `claude-plugins-official` marketplace has **no application process** — Anthropic
picks those. To get listed in the **community** directory, submit at
`platform.claude.com/plugins/submit` (Console, individual author). This is a **public
action** — do it only with Leonardo's explicit OK. The self-hosted marketplace above
already gives 1-command install today without any submission.
