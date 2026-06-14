# Configuration

claude-quota-guardian reads `~/.claude/session-continuity/config.json`. All fields are optional — missing fields fall back to defaults.

| Field | Default | Description |
|---|---|---|
| `plan` | `"none"` | `"none"` \| `"pro"` \| `"max5x"` \| `"max20x"`. `"none"` disables plan-quota checks (context-window monitoring still runs). Any other value enables `ccusage`-based plan checks. |
| `thresholds.context` | `0.995` | Fraction (0-1) of the model's context window that triggers a checkpoint. |
| `thresholds.plan` | `0.995` | Fraction (0-1) of the plan's quota that triggers a checkpoint. |
| `planTokenLimit` | `null` | Tokens in your plan's 5h window. Needed for plan-% on `ccusage` >=20 (see below). `null` → plan-% disabled, context-% still runs. |
| `planCheckIntervalToolCalls` | `5` | Reserved for the Phase 2 watcher; not yet used by the core hooks. |
| `watcherIntervalMinutes` | `15` | Reserved for the Phase 2 watcher. |
| `notifications.enabled` | `true` | Reserved for future use; notifications currently fire whenever `node-notifier` is installed. |

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
