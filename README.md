# claude-quota-guardian

Automatic checkpoint and resume for Claude Code sessions approaching usage limits.

When your context window or plan quota gets close to its limit, claude-quota-guardian:

1. Detects the threshold (default 99.5%) via a `PostToolUse` hook.
2. Tells Claude to stop and run `/continuity-checkpoint`, which writes a rich, structured summary of the session (what was built, what worked, what didn't, the exact next step).
3. The next time you open Claude Code in that project, a `SessionStart` hook automatically injects that checkpoint as context — Claude picks up exactly where it left off, with zero re-explanation.

No automatic relaunching: you decide when to reopen Claude. claude-quota-guardian only handles the save and the resume.

## How it works

```
[Normal work] -> PostToolUse: check-usage.js
       |
       |-- below threshold -> no-op
       |
       `-- >= 99.5% -> pending.json + OS notification + hook "block"
                        |
                        v
                Claude runs /continuity-checkpoint
                -> writes checkpoint-<ts>.md, updates pending.json
                -> ends the turn cleanly
                        |
              (you close Claude, usage resets later)
                        |
              quota-watcher (background) detects the reset
              -> OS notification: "ready to continue"
                        |
              You reopen Claude in the same project
                        |
                SessionStart: resume-context.js
                -> injects the full checkpoint + "MODO RETOMAR"
                -> marks pending.json consumed
                        |
                Claude announces the next step and continues
```

## Requirements

- Node.js >= 18
- Claude Code (CLI or desktop app) with hook support

## Quick install

```bash
git clone <repo-url> ~/.claude/claude-quota-guardian
cd ~/.claude/claude-quota-guardian
npm install
node bin/install.js
```

This single command:

- Writes `~/.claude/session-continuity/config.json` with defaults (edit it afterwards to set your `plan` — see [docs/configuration.md](docs/configuration.md)).
- Merges the `PostToolUse` and `SessionStart` hooks into `~/.claude/settings.json` without touching any hooks you already have.
- Claims the `statusLine` slot for real account-wide quota tracking (`rate_limits`), unless something else already owns it — see [docs/configuration.md](docs/configuration.md).
- Copies `commands/continuity-checkpoint.md` into `~/.claude/commands/`.
- Registers the background `quota-watcher` to run every `watcherIntervalMinutes` (default 15) via Task Scheduler (Windows), launchd (macOS), or a systemd user timer with a cron fallback (Linux).

If the scheduler step fails (e.g. `schtasks`/`systemctl` unavailable), `install.js` prints a manual fallback command — everything else is still installed.

### Uninstalling

```bash
node bin/uninstall.js          # removes hooks, command and watcher schedule
node bin/uninstall.js --purge  # also deletes ~/.claude/session-continuity (checkpoints!)
```

## Manual installation

If you'd rather wire things up yourself (or `bin/install.js` doesn't support your platform), follow these steps:

1. Clone this repo somewhere stable, e.g. `~/.claude/claude-quota-guardian`:

   ```bash
   git clone <repo-url> ~/.claude/claude-quota-guardian
   ```

2. Add the hooks to `~/.claude/settings.json` (merge into your existing `hooks` object — don't overwrite other hooks):

   ```json
   {
     "hooks": {
       "PostToolUse": [
         { "matcher": "*", "hooks": [{ "type": "command", "command": "node \"~/.claude/claude-quota-guardian/hooks/check-usage.js\"" }] }
       ],
       "SessionStart": [
         { "matcher": "*", "hooks": [{ "type": "command", "command": "node \"~/.claude/claude-quota-guardian/hooks/resume-context.js\"" }] }
       ]
     }
   }
   ```

   Replace `~` with your actual home directory path (e.g. `C:\\Users\\YOU` on Windows) — `settings.json` does not expand `~`.

3. Copy the checkpoint command:

   ```bash
   cp ~/.claude/claude-quota-guardian/commands/continuity-checkpoint.md ~/.claude/commands/
   ```

4. (Optional) enable plan-quota checks: create `~/.claude/session-continuity/config.json` — see [docs/configuration.md](docs/configuration.md).

5. (Optional) install `ccusage` for plan-quota checks: `npm i -g ccusage`.

6. (Optional) install `node-notifier` for OS notifications:

   ```bash
   cd ~/.claude/claude-quota-guardian && npm install
   ```

7. (Optional) register the background watcher yourself — see `lib/scheduled-task.js` for the exact per-OS command/file, or just run `node bin/install.js` to do this step only.

## Testing your install

```bash
node scripts/simulate-threshold.js --pct 99.6
```

This prints a ready-to-run command that feeds a simulated near-limit transcript into `hooks/check-usage.js`, so you can confirm the hook fires and writes `pending.json` without waiting for a real session to fill up.

## What's included

- **Core loop** — `hooks/check-usage.js` detects the threshold and triggers `/continuity-checkpoint`; `hooks/resume-context.js` auto-injects the checkpoint on the next `SessionStart`.
- **Background watcher** — `watcher/quota-watcher.js` notifies you once your plan quota resets, so you know it's safe to reopen Claude.
- **Installer / uninstaller** — `bin/install.js` / `bin/uninstall.js` (see Quick install above).

111/111 tests pass on Node 18 and 20 (`npm test`; CI in `.github/workflows/test.yml`).

See `docs/superpowers/specs/2026-06-11-claude-quota-guardian-design.md` for the full design.

## License

MIT
