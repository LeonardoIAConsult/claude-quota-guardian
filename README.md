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

## Installation (manual)

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

## Testing your install

```bash
node scripts/simulate-threshold.js --pct 99.6
```

This prints a ready-to-run command that feeds a simulated near-limit transcript into `hooks/check-usage.js`, so you can confirm the hook fires and writes `pending.json` without waiting for a real session to fill up.

## Status

This is the **core loop** (checkpoint + resume). A follow-up phase adds:

- A background watcher that detects when your plan quota resets and notifies you it's safe to reopen Claude.
- An interactive installer/uninstaller (`bin/install.js` / `bin/uninstall.js`).

See `docs/superpowers/specs/2026-06-11-claude-quota-guardian-design.md` for the full design.

## License

MIT
