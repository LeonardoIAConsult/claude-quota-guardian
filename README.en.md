# 🛡️ Claude Quota Guardian

> 🇪🇸 [Versión en español](README.md)

**Your safety net for long AI sessions.** Guardian watches how much context and quota your Claude Code session is consuming and, right before the cutoff, forces a structured checkpoint that the next session resumes on its own — no lost thread, no re-explaining.

## The problem

Anyone who runs long sessions with an AI agent knows the moment: you're hours into building something, the context window fills up or your plan quota runs out, and the session dies mid-task. What follows is worse than the cutoff itself: reopening, re-explaining everything from scratch, and watching the agent retry approaches that had already failed.

## What Guardian does

When a **Claude Code terminal session** approaches its limit (conversation context or the plan's 5h/7d quota), Guardian:

1. **Detects the threshold** (99.6% by default) after every tool call and every turn — including your real account-wide Pro/Max quota via `rate_limits`, not just local estimates.
2. **Stops new work** with a real tool block (`PreToolUse` hook): the agent cannot keep burning tokens without saving first.
3. **Forces a structured checkpoint** (`/continuity-checkpoint`): what was being built, what worked (with evidence), what did NOT work and why, the state of every file touched, decisions made, and the exact next step.
4. **Notifies you when the quota resets** (background watcher with OS notifications and adaptive polling — 15→3→1 min as the session fills up).
5. **Resumes on its own**: the next time you open Claude Code in that project, a `SessionStart` hook injects the full checkpoint as context. The agent announces the next step and continues — zero re-explanation.

```
[Normal work] -> PostToolUse: check-usage.js
       |
       |-- below threshold -> no-op
       |
       `-- >= 99.6% -> pending.json + OS notification + block
                        |
                        v
                Claude runs /continuity-checkpoint
                -> writes checkpoint-<ts>.md
                -> ends the turn cleanly
                        |
              (you close Claude; quota resets later)
                        |
              quota-watcher (background) detects the reset
              -> notification: "ready to continue"
                        |
              You reopen Claude in the same project
                        |
                SessionStart: resume-context.js
                -> injects the full checkpoint
                        |
                Claude announces the next step and continues
```

No automatic relaunching: you decide when to reopen. Guardian only handles the save and the resume.

## Benefits (verifiable)

- **Zero lost context**: the checkpoint captures what automatic summaries lose — the approaches that failed and why, so they aren't retried.
- **Zero tokens burned blindly**: the hard block prevents the agent from continuing work on a doomed session.
- **Real signal, not an estimate**: uses the account-wide `rate_limits` (5h/7d) that Claude Code exposes — the same number your account sees.
- **One-command install, clean uninstall**: merges its hooks into `settings.json` without touching yours; the uninstaller only removes its own.
- **Cross-platform**: Windows (Task Scheduler), macOS (launchd), Linux (systemd/cron).
- **129/129 tests** on Node 18 and 20 (`npm test`, CI included).
- **Extensible to other AI providers**: adapter architecture; ships with notify-only monitoring of **OpenAI Codex CLI** today (reads its local session logs and warns you before the cutoff).

## Who is it for?

- **Claude Code users on Pro/Max plans** who hit the 5h window during intense sessions.
- **Developers running autonomous agents** on long tasks (refactors, audits, multi-file features) where a mid-task cutoff costs hours.
- **Freelancers and small teams** who bill for outcomes and can't afford re-explaining context every session.
- **Multi-CLI users** who alternate between Claude Code and Codex and want a single safety net.

## Honest scope

- The full loop (detect → block → checkpoint → auto-resume) applies to **Claude Code in the terminal** (`entrypoint === "cli"`), the only surface with hooks and a real "end the turn" affordance. Desktop/IDE only feed heartbeats to the watcher; they are never blocked.
- Other providers (Codex today) are **notify-only**: without a hook system there is no blocking and no auto-resume — Guardian warns you in time to ask for a summary before the cutoff.
- The local context % is a conservative estimate (see [docs/configuration.md](docs/configuration.md)); the `rate_limits` quota signal is real.

## Requirements

- Node.js >= 18
- Claude Code (CLI) with hook support

## Quick install

```bash
git clone <repo-url> ~/.claude/claude-quota-guardian
cd ~/.claude/claude-quota-guardian
npm install
node bin/install.js
```

That single command: writes the default config, merges the hooks into `~/.claude/settings.json` (without overwriting yours), claims the `statusLine` slot for real quota tracking (only if free), installs the `/continuity-checkpoint` command, and registers the watcher with your OS scheduler.

### Uninstalling

```bash
node bin/uninstall.js          # removes hooks, command and watcher
node bin/uninstall.js --purge  # also deletes saved checkpoints
```

### Testing your install

```bash
node scripts/simulate-threshold.js --pct 99.7
```

Prints a ready-to-run command that simulates a near-limit session and confirms the hook fires, without waiting for a real session to fill up.

## Configuration

Everything is optional with sensible defaults: thresholds, plan, watcher cadence, external providers. See [docs/configuration.md](docs/configuration.md).

## What's included

- **Core loop** — `hooks/check-usage.js` (detection), `hooks/enforce-checkpoint.js` (real blocking), `hooks/resume-context.js` (auto-resume). Terminal surface only.
- **Background watcher** — `watcher/quota-watcher.js`: quota-reset notification + adaptive cadence.
- **Provider adapters** — `lib/adapters/codex.js`: notify-only monitoring of OpenAI Codex CLI sessions.
- **Installer / uninstaller** — `bin/install.js` / `bin/uninstall.js`.

## License

MIT
