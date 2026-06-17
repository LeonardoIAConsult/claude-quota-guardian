# Configuration

claude-quota-guardian reads `~/.claude/session-continuity/config.json`. All fields are optional — missing fields fall back to defaults.

| Field | Default | Description |
|---|---|---|
| `plan` | `"none"` | `"none"` \| `"pro"` \| `"max5x"` \| `"max20x"`. `"none"` disables plan-quota checks (context-window monitoring still runs). Any other value enables `ccusage`-based plan checks. |
| `thresholds.context` | `0.995` | Fraction (0-1) of the model's context window that triggers a checkpoint. |
| `thresholds.plan` | `0.995` | Fraction (0-1) of the plan's quota that triggers a checkpoint. |
| `planTokenLimit` | `null` | Tokens in your plan's 5h window. Needed for plan-% on `ccusage` >=20 (see below). `null` → plan-% disabled, context-% still runs. |
| `planCheckIntervalToolCalls` | `5` | Reserved for the Phase 2 watcher; not yet used by the core hooks. |
| `watcherIntervalMinutes` | `15` | Base watcher polling cadence. `adaptiveWatcher.tiers` shortens this as usage climbs (default: 3min at 90%, 1min at 98%). |
| `notifications.enabled` | `true` | When `false`, the watcher and hooks still write state/pending files but skip OS notifications. |

## Detection architecture

Four hooks, all registered globally in `~/.claude/settings.json` (apply to every Claude Code project/terminal/IDE session for this user, not just one project):

| Hook | Event | Purpose |
|---|---|---|
| `hooks/check-usage.js` | `PostToolUse` | Heartbeat + threshold check after every tool call. |
| `hooks/heartbeat-stop.js` | `Stop` | Same heartbeat/threshold check after every assistant turn, **including turns with no tool calls** — closes the gap where context climbs during pure-text turns and `PostToolUse` never fires. Never emits `decision: block` (for `Stop`, that decision means "prevent the agent from stopping," the opposite of what's needed here). |
| `hooks/enforce-checkpoint.js` | `PreToolUse` | Hard stop: once a checkpoint is pending and unconsumed, blocks every tool call except `Bash`/`Write` (the two the `/continuity-checkpoint` flow needs) until the checkpoint is saved. This is a real block — unlike the `PostToolUse`/`Stop` advisories, the tool call never runs. |
| `hooks/resume-context.js` | `SessionStart` | Injects the saved checkpoint into a new session once consumed. |

Once a checkpoint is pending, `check-usage.js`/`heartbeat-stop.js` re-notify every 5 minutes (instead of a single one-shot toast) until `/continuity-checkpoint` runs and marks it consumed.

**Context limit caveat:** `lib/plan-limits.json`'s `context.default` (180000) is a conservative estimate, not Claude Code's exact internal usable budget — Claude Code reserves some of the model's raw context window for system prompt/tool schemas/autocompact margin, so its own "% used" indicator and this tool's `contextPct` will not match exactly. The default is set below the model's raw 200k window specifically to trigger before Claude Code's own autocompact silently truncates the transcript (which would otherwise reset `contextPct` downward before the threshold is ever crossed). If you still see the threshold crossed only after Code's own UI already shows a higher %, lower `thresholds.context` and/or `plan-limits.json`'s `context.default` further.

**Scope caveat:** all of the above only covers Claude Code (CLI, IDE extension, terminal) — hooks have no reach into the separate Claude.ai desktop or browser apps, which have no local hook mechanism.

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
