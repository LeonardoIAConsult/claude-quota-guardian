# Guardian as a Claude Code plugin

Guardian ships **two install paths** from the same repo:

1. **Standalone** (full feature set) — `node bin/install.js`. Merges hooks into your
   `settings.json`, claims the `statusLine`, and registers the **background watcher**
   (the "your quota reset, ready to continue" notifier that runs with Claude closed).
2. **Plugin** (1-command, in-session core) — via this repo's own marketplace. Delivers
   the core loop (detect → block → checkpoint → auto-resume). See the trade-off below.

## Install as a plugin

```
/plugin marketplace add LeonardoIAConsult/claude-quota-guardian
/plugin install claude-quota-guardian@claude-quota-guardian
```

That's it — Claude Code loads the four hooks and the `/continuity-checkpoint` command.

## Files that make it a plugin (additive; never touch the standalone installer)

- `.claude-plugin/plugin.json` — plugin manifest (name, description, version, author, homepage, repo, MIT).
- `.claude-plugin/marketplace.json` — makes this repo its own marketplace (`source: "./"`), so anyone can `marketplace add` + `install` in two commands. Validated with `claude plugin validate .` (✔ passed).
- `hooks/hooks.json` — the four hooks, path-portable via `${CLAUDE_PLUGIN_ROOT}`:
  - `PreToolUse *` → `hooks/enforce-checkpoint.js`
  - `PostToolUse *` → `hooks/check-usage.js`
  - `Stop *` → `hooks/heartbeat-stop.js`
  - `SessionStart *` → `hooks/resume-context.js`
- `commands/` (already present) → exposed namespaced: `/claude-quota-guardian:continuity-checkpoint` (the short `/continuity-checkpoint` also resolves when unambiguous).

## Known trade-offs (plugin vs standalone)

1. **Background watcher is standalone-only.** The "quota reset → ready to continue"
   notifier needs an out-of-session scheduler (Task Scheduler / launchd / cron) that
   `bin/install.js` sets up. A plugin runs only *during* a session, so the plugin
   delivers the core loop; the reset notifier stays an extra of the standalone install.
2. **statusLine.** Plugins can't claim the main `statusLine` slot. Not needed for
   blocking — the real quota comes from the OAuth `usageApi` (session/weekly/per-model),
   which works regardless.
3. **Command name.** As a plugin the command is namespaced
   `/claude-quota-guardian:continuity-checkpoint`; the short name resolves too.

## Publishing to the community directory (optional, public)

The curated `claude-plugins-official` marketplace has **no application process** — Anthropic
picks those. To get listed in the **community** directory, submit at
`platform.claude.com/plugins/submit` (Console, individual author). This is a **public
action** — do it only with Leonardo's explicit OK. The self-hosted marketplace above
already gives 1-command install today without any submission.
