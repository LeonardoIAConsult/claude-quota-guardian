# Configuration

claude-quota-guardian reads `~/.claude/session-continuity/config.json`. All fields are optional — missing fields fall back to defaults.

| Field | Default | Description |
|---|---|---|
| `plan` | `"none"` | `"none"` \| `"pro"` \| `"max5x"` \| `"max20x"`. `"none"` disables plan-quota checks (context-window monitoring still runs). Any other value enables `ccusage`-based plan checks. |
| `thresholds.context` | `0.996` | Fraction (0-1) of the model's context window that hard-blocks tools on the CLI/IDE surface. |
| `thresholds.plan` | `0.995` | Fraction (0-1) of the plan's quota that triggers a checkpoint. |
| `thresholds.desktopWarn` | `0.99` | Fraction (0-1) of context-window usage that triggers a notify-only warning on the Claude Code Desktop surface (see below) — Desktop is never hard-blocked, even past `thresholds.context`. |
| `planTokenLimit` | `null` | Tokens in your plan's 5h window. Needed for plan-% on `ccusage` >=20 (see below). `null` → plan-% disabled, context-% still runs. |
| `planCheckIntervalToolCalls` | `5` | Reserved for the Phase 2 watcher; not yet used by the core hooks. |
| `watcherIntervalMinutes` | `15` | Base watcher polling cadence. `adaptiveWatcher.tiers` shortens this as usage climbs (default: 3min at 90%, 1min at 98%). |
| `notifications.enabled` | `true` | When `false`, the watcher and hooks still write state/pending files but skip OS notifications. |

## Detection architecture

Five hooks, all registered globally in `~/.claude/settings.json` (apply to every Claude Code project/terminal/IDE session for this user, not just one project):

| Hook | Event | Purpose |
|---|---|---|
| `hooks/check-usage.js` | `PostToolUse` | Heartbeat + threshold check after every tool call. |
| `hooks/heartbeat-stop.js` | `Stop` | Same heartbeat/threshold check after every assistant turn, **including turns with no tool calls** — closes the gap where context climbs during pure-text turns and `PostToolUse` never fires. Never emits `decision: block` (for `Stop`, that decision means "prevent the agent from stopping," the opposite of what's needed here). |
| `hooks/enforce-checkpoint.js` | `PreToolUse` | Hard stop: once a checkpoint is pending and unconsumed, blocks every tool call except `Bash`/`Write` (the two the `/continuity-checkpoint` flow needs) until the checkpoint is saved. This is a real block — unlike the `PostToolUse`/`Stop` advisories, the tool call never runs. |
| `hooks/resume-context.js` | `SessionStart` | Injects the saved checkpoint into a new session once consumed. |
| `hooks/statusline.js` | `statusLine` | Caches Claude Code's real account-wide `rate_limits` (5h/7d Pro/Max quota) into `state.json` and renders the visible status line. See below. |

Once a checkpoint is pending, `check-usage.js`/`heartbeat-stop.js` re-notify every 5 minutes (instead of a single one-shot toast) until `/continuity-checkpoint` runs and marks it consumed.

**Desktop vs CLI/IDE behavior:** every Claude Code transcript line is stamped with an `entrypoint` field (`"cli"`, `"claude-desktop"`, ...) — `lib/usage-monitor.js`'s `getEntrypoint` reads it back out of the transcript. Claude Code Desktop has no "end the turn now" affordance the way a terminal does (the real fix there is opening a fresh conversation), so `lib/threshold-check.js` branches on it:

- **CLI/IDE** (`entrypoint !== "claude-desktop"`, including unrecognized future surfaces): unchanged hard-block flow above — `thresholds.context` (99.6%) creates a pending checkpoint and `enforce-checkpoint.js` really blocks tools until `/continuity-checkpoint` runs.
- **Claude Code Desktop** (`entrypoint === "claude-desktop"`): notify-only. At `thresholds.desktopWarn` (99%) it sends a re-notified-every-5-min OS notification telling you to open a new conversation. It never creates `pending.json` and is never hard-blocked, even past 99.6% — `enforce-checkpoint.js` has nothing to block on for that session.

Both surfaces' heartbeats land in the same `state.json` (`entrypoint`, `lastDesktopWarnAt` fields included) — the watcher's adaptive polling reads `maxPct` the same way regardless of surface.

**Context limit caveat:** `lib/plan-limits.json`'s `context.default` (180000) is a conservative estimate, not Claude Code's exact internal usable budget — Claude Code reserves some of the model's raw context window for system prompt/tool schemas/autocompact margin, so its own "% used" indicator and this tool's `contextPct` will not match exactly. The default is set below the model's raw 200k window specifically to trigger before Claude Code's own autocompact silently truncates the transcript (which would otherwise reset `contextPct` downward before the threshold is ever crossed). If you still see the threshold crossed only after Code's own UI already shows a higher %, lower `thresholds.context` and/or `plan-limits.json`'s `context.default` further.

**Scope caveat:** all of the above covers every Claude Code surface — CLI, IDE extension, terminal, **and the Claude Code Desktop app** (Mac/Windows), since Desktop shares the same `~/.claude/settings.json`/hooks/engine as the CLI (confirmed via the transcript `entrypoint` field, see above). It does **not** reach the separate Claude.ai consumer chat app (web or desktop, the one with "Projects"/uploaded documents instead of a project folder) — that product has no local hook mechanism at all, regardless of surface.

## Real account-wide quota (`rate_limits` via the status line)

`thresholds.context`/`thresholds.plan` above are both estimates: `context` is a local token count against a guessed budget (see the context limit caveat above), and ccusage-derived `plan` depends on a third-party tool and, on `ccusage` >=20, a manually-supplied `planTokenLimit`. Claude Code's statusline payload is the **only** place a real, account-wide number is ever exposed — `rate_limits.five_hour.used_percentage`/`rate_limits.seven_day.used_percentage`, visible for any Claude.ai Pro/Max subscriber after the first API response in a session. It is never included in `PreToolUse`/`PostToolUse`/`Stop` hook payloads, only in the separate `statusLine` one.

`hooks/statusline.js` reads it on every render and caches the higher of the two windows into the same per-project `state.json` the other hooks heartbeat into (`rateLimitPct`, `rateLimitResetAt`). `lib/threshold-check.js` then reads that cache back on its next `PostToolUse`/`Stop` run and feeds it into `getStatus`'s `planPct` (`lib/usage-monitor.js`'s `cachedRateLimit` param) — winning over the ccusage-derived value whenever it's higher, and working even when `plan` is `"none"` (no ccusage setup required at all). From there it's just the existing `plan` signal: same `thresholds.plan` (99.5%), same hard-block/pending flow on CLI/IDE, same account-wide plan-warn on Desktop (see above) — including against `thresholds.plan` even when local context is low, since an account-wide quota and the current conversation's context are independent things.

**statusLine is a single slot.** Unlike `hooks`, Claude Code's `settings.json` only supports one `statusLine` command — there's no array of them. `bin/install.js`'s `installStatusLine` only claims it when nothing else has (e.g. a status-bar plugin's badge script); if something else already owns it, install logs `statusLine NOT registered` and leaves it untouched rather than overwriting it. In that case, rate_limits tracking stays off until you either free up the slot or manually combine both commands' logic into one script (have it write to `paths.statePath(cwd)` the same way `hooks/statusline.js` does, then print whatever it would otherwise print).

## Plan-quota checks (`ccusage`)

If `plan` is not `"none"`, `getPlanUsage` shells out to `ccusage blocks --json --active` (via `npx`, with `shell: true` so Windows resolves `npx.cmd`). If `ccusage` is not installed or fails, plan-quota checks are silently skipped — only context-window checks remain active.

**ccusage version note:** older `ccusage` (<20) returned a precomputed `tokenLimitStatus.percentUsed`, which is used directly when present. `ccusage` >=20 only reports raw `totalTokens` with no percentage — Anthropic does not publish the exact 5h token cap, so to get a plan-% on these versions you must set `planTokenLimit` (e.g. an empirical token budget for your plan). Without it, plan-% stays disabled and the **context-window guard is the sole, reliable trigger** (it always works, no `ccusage` needed).

Install `ccusage` globally for faster startup: `npm i -g ccusage`.

## Example

```json
{
  "plan": "pro",
  "thresholds": { "context": 0.995, "plan": 0.995 }
}
```
